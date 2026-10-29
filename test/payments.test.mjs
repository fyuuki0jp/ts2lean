import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { LeanWorkspace } from "../dist/lean.js";
import { createProject } from "../dist/project.js";
import { compileEffects } from "../dist/effects/compiler.js";
import { emitEffects } from "../dist/effects/emit.js";
import { ts } from "@ts-morph/common";

const root = path.resolve("examples/payments");
const entries = (file) =>
  ["transfer", "retryPendingTransfers", "recover"].map((name) => ({
    file,
    name,
  }));
function withSettlementFinally(source, finalizer) {
  const sf = ts.createSourceFile(
    "service.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const callbacks = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "transaction"
    )
      callbacks.push(n.arguments[0]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const body = callbacks.at(-1).body;
  return (
    source.slice(0, body.getStart() + 1) +
    "\ntry {" +
    source.slice(body.getStart() + 1, body.end - 1) +
    "\n} finally {" +
    finalizer +
    "}\n" +
    source.slice(body.end - 1)
  );
}
test("effect extraction proves actual callbacks and rejects unsafe changes and omitted effects", async () => {
  const ws = await LeanWorkspace.create(createProject(root));
  await ws.compile("Ts2Lean/LedgerEffects.lean");
  const declarations = new Map();
  for (const file of ["Database.lean", "Payment.lean"])
    declarations.set(path.join(root, file), await ws.discover(file));
  const original = await readFile(path.join(root, "service.ts"), "utf8");
  const sourceFile = path.join(root, ".ts2lean", "regression.ts");
  const relocated = (source) =>
    source
      .replaceAll('"./database.ts"', '"../database.ts"')
      .replaceAll('"./Database.lean"', '"../Database.lean"');
  async function check(source, pass, label) {
    await writeFile(sourceFile, relocated(source));
    const ir = compileEffects(entries(sourceFile), declarations);
    const proof = emitEffects(
      ir,
      "Payment",
      "Payment.ledgerInvariant",
      false,
      400000,
    );
    await writeFile(path.join(ws.dir, "Proof.lean"), proof);
    const result = await ws.exec(["Proof.lean"]);
    assert.equal(result.code === 0, pass, `${label}: ${result.output}`);
    if (pass) assert.ok(result.output.includes("TS2LEAN_AXIOMS:"));
    return ir;
  }
  try {
    const correct = await check(original, true, "correct");
    assert.equal(correct.transactions.length, 2);
    // Evaluate the actual generated state expressions and compare with SQLite,
    // including integers far beyond JavaScript Number and SQLite INTEGER.
    const opening = 2n ** 130n,
      amount = 2n ** 90n + 37n;
    const register = correct.transactions[0].paths.find((p) =>
      p.writes.includes("request.insert"),
    );
    const settle = correct.transactions[1].paths.find((p) =>
      p.writes.includes("ledger.insert"),
    );
    const instantiate = (p) => p.state.replace(/\bv\d+\b/g, "request");
    await writeFile(
      path.join(ws.dir, "Differential.lean"),
      `import Ts2Lean.Modules
open Ts2Lean.Ledger
def request : Request := ⟨"large", "alice", "bob", ${amount}⟩
def start : State := {opening := fun a => if a = "alice" then ${opening} else 0, balances := fun a => if a = "alice" then ${opening} else 0, initialTotal := ${opening}, total := ${opening}, requests := fun _ => none, ledger := []}
def registered : State := let s := start; ${instantiate(register)}
def finished : State := let s := registered; ${instantiate(settle)}
#eval IO.println ("STATE:" ++ (Lean.toJson [toString (finished.balances "alice"), toString (finished.balances "bob"), toString finished.total, toString finished.ledger.length]).compress)
`,
    );
    const evaluation = await ws.exec(["Differential.lean"]);
    assert.equal(evaluation.code, 0, evaluation.output);
    const expected = JSON.parse(
      evaluation.output
        .split("\n")
        .find((l) => l.startsWith("STATE:"))
        .slice(6),
    );
    const temp = await mkdtemp(path.join(tmpdir(), "ts2lean-differential-")),
      database = path.join(temp, "db.sqlite");
    try {
      assert.equal(
        (
          await command(database, [
            "seed",
            JSON.stringify({ alice: String(opening), bob: "0" }),
          ])
        ).code,
        0,
      );
      assert.equal(
        (
          await command(database, [
            "transfer",
            "large",
            "alice",
            "bob",
            String(amount),
          ])
        ).code,
        0,
      );
      const actual = JSON.parse((await command(database, ["snapshot"])).stdout);
      assert.deepEqual(
        [
          ...actual.accounts.map((a) => a.balance),
          String(
            actual.accounts.reduce((sum, a) => sum + BigInt(a.balance), 0n),
          ),
          String(actual.transfers.length),
        ],
        expected,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    for (const name of [
      "stale-balance",
      "missing-posting",
      "changed-retry-id",
    ]) {
      const source = await readFile(
        path.join(root, "bugs", name + ".ts"),
        "utf8",
      );
      await check(source, false, name);
    }
    await check(
      original.replace("credit + request.amount", "credit - request.amount"),
      false,
      "wrong credit sign",
    );
    await check(
      original.replace(
        "await tx.setBalance(request.to, credit + request.amount);",
        "try { await tx.setBalance(request.to, credit + request.amount); } catch {}",
      ),
      false,
      "caught partial write must not commit",
    );
    await check(
      withSettlementFinally(original, "await tx.getBalance(input.from);"),
      true,
      "settlement with awaited finally",
    );
    await check(
      withSettlementFinally(original, "await tx.setBalance(input.from,-1n);"),
      false,
      "finally participates in commit safety",
    );
    await check(
      original.replace(
        /if\s*\(\s*(request|prior)\.from !== input\.from \|\|\s*\1\.to !== input\.to \|\|\s*\1\.amount !== input\.amount\s*\)/g,
        "if (false)",
      ),
      false,
      "conflicting receipt",
    );
    const catcher = `\nexport async function catchFailure() { try { await db.getBalance("missing"); } catch { await db.transaction(async tx => { await tx.setBalance("alice", -1n); }); } }`;
    await writeFile(sourceFile, relocated(original + catcher));
    const caught = compileEffects(
      [...entries(sourceFile), { file: sourceFile, name: "catchFailure" }],
      declarations,
    );
    assert.equal(
      caught.transactions.length,
      3,
      "outer catch must be extracted",
    );
    await writeFile(
      path.join(ws.dir, "Proof.lean"),
      emitEffects(caught, "Payment", "Payment.ledgerInvariant", false, 400000),
    );
    assert.notEqual((await ws.exec(["Proof.lean"])).code, 0);
    const unsupported = [
      original.replace(
        "await tx.setBalance(request.from",
        "tx.setBalance(request.from",
      ),
      original.replace(
        "if (debit < request.amount)",
        "const copy = {...request}; if (copy === request)",
      ),
      original.replace(
        "const input = { ...requestInput };",
        "const input = requestInput;",
      ),
      original.replace(
        "const pending = await db.listPending();",
        "const pending = await db.listPending(); const tx = db.transaction;",
      ),
    ];
    for (const source of unsupported) {
      await writeFile(sourceFile, relocated(source));
      assert.throws(
        () => compileEffects(entries(sourceFile), declarations),
        (e) => e.status === "unsupported",
      );
    }
  } finally {
    await rm(sourceFile, { force: true });
  }
});

function command(db, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "cli.ts"), ...args],
      {
        env: { ...process.env, PAYMENTS_DB: db, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}
test("real process death before and after commit, multi-process contention and recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ts2lean-crash-")),
    db = path.join(dir, "db.sqlite");
  const ok = async (args) => {
    const r = await command(db, args);
    assert.equal(r.code, 0, r.stderr);
    return r;
  };
  try {
    await ok(["seed"]);
    for (const [i, point] of [
      "afterRequest",
      "afterDebit",
      "afterCredit",
      "afterLedger",
      "afterCommit",
    ].entries()) {
      const id = `crash-${i}`;
      const killed = await command(db, ["transfer", id, "alice", "bob", "10"], {
        CRASH_AT: point,
      });
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      await ok(["recover"]);
      await ok(["transfer", id, "alice", "bob", "10"]);
    }
    await Promise.all(
      Array.from({ length: 8 }, () =>
        command(db, ["transfer", "concurrent", "alice", "bob", "10"]),
      ),
    );
    await ok(["transfer", "concurrent", "alice", "bob", "10"]);
    await ok(["recover"]);
    const snapshot = JSON.parse((await ok(["snapshot"])).stdout);
    assert.equal(snapshot.transfers.length, 6);
    assert.deepEqual(
      snapshot.accounts.map((a) => a.balance),
      ["940", "60"],
    );
    assert.equal(new Set(snapshot.transfers.map((r) => r.operationId)).size, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each deliberately broken example has a concrete SQLite execution witness", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ts2lean-counterexamples-"));
  try {
    for (const variant of [
      "stale-balance",
      "missing-posting",
      "changed-retry-id",
    ]) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(root, "counterexamples.ts"), variant],
          {
            env: {
              ...process.env,
              PAYMENTS_DB: path.join(dir, variant + ".sqlite"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(result.code, 0, result.stderr);
      const witness = JSON.parse(result.stdout);
      assert.equal(witness.status, "counterexample");
      await writeFile(
        path.join(root, ".ts2lean", variant + "-counterexample.json"),
        JSON.stringify(witness, null, 2),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
