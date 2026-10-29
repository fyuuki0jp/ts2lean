import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { ts } from "@ts-morph/common";
import { LeanWorkspace } from "../dist/lean.js";
import { createProject } from "../dist/project.js";
import { compileEffects } from "../dist/effects/compiler.js";
import { emitEffects } from "../dist/effects/emit.js";

const root = path.resolve("examples/payments");
const input = { operationId: "case", from: "alice", to: "bob", amount: 1n };
const wrap = (body) => `import { db } from "../database.ts";
import type { TransferRequest } from "../Database.lean";
export async function scenario(requestInput: TransferRequest) {
  const input={...requestInput};
  return await db.transaction(async tx => {${body}});
}`;

function tag(value, thrown) {
  if (thrown) {
    if (value instanceof Error) return "throw:error:" + value.message;
    if (value === null) return "throw:null";
    if (value === undefined) return "throw:undefined";
    return (
      `throw:${typeof value === "bigint" ? "integer" : typeof value}:` +
      String(value)
    );
  }
  return value === undefined
    ? "return:undefined"
    : `return:request:${value.operationId}:${value.from}:${value.to}:${value.amount}`;
}

async function nativeObservations(source, sites) {
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const observations = new Set();
  // Every encountered primitive can succeed, reject before, or reject after
  // its effect. Unused suffixes are harmless and deduplicated.
  for (let mask = 0; mask < 3 ** sites; mask++) {
    let remaining = mask,
      cursor = 0;
    const decisions = Array.from({ length: sites }, () => {
      const v = remaining % 3;
      remaining = Math.floor(remaining / 3);
      return v;
    });
    const balances = new Map([
        ["alice", 10n],
        ["bob", 0n],
      ]),
      requests = new Map(),
      ledger = [];
    const effect = async (action) => {
      const choice = decisions[cursor++] ?? 0;
      if (choice === 1) throw new Error("fault");
      const result = action();
      if (choice === 2) throw new Error("fault");
      return result;
    };
    const tx = {
      getBalance: (id) => effect(() => balances.get(id) ?? 0n),
      setBalance: (id, amount) =>
        effect(() => {
          balances.set(id, amount);
        }),
      getRequest: (id) => effect(() => requests.get(id) ?? null),
      insertRequest: (r) =>
        effect(() => {
          if (requests.has(r.operationId)) throw new Error("duplicate");
          requests.set(r.operationId, { ...r });
        }),
      getTransfer: (id) =>
        effect(() => ledger.find((r) => r.operationId === id) ?? null),
      insertTransfer: (r) =>
        effect(() => {
          if (ledger.some((p) => p.operationId === r.operationId))
            throw new Error("duplicate");
          ledger.push({ ...r });
        }),
    };
    const exports = {};
    new Function("require", "exports", code)(
      () => ({ db: { transaction: (cb) => cb(tx) } }),
      exports,
    );
    let completion;
    try {
      completion = tag(await exports.scenario({ ...input }), false);
    } catch (error) {
      completion = tag(error, true);
    }
    observations.add(
      JSON.stringify([
        completion,
        String(balances.get("alice")),
        String(balances.get("bob")),
        String([...balances.values()].reduce((a, b) => a + b, 0n)),
        requests.has("case") ? "yes" : "no",
        String(ledger.length),
      ]),
    );
  }
  return [...observations].sort();
}

function observationProgram(site) {
  const definitions = site.completions.map((p, i) => {
    const parameters = [...site.captures, ...p.variables]
      .map(
        (v) =>
          `let ${v.name} : ${v.type} := ${v.type === "Request" ? "request" : v.type === "ExceptionValue" ? 'ExceptionValue.error "fault"' : v.type === "Int" ? "0" : '""'}`,
      )
      .join("\n  ");
    const result =
      p.control === "throw"
        ? `exceptionTag (${p.result.lean})`
        : p.result.type === "request"
          ? `receiptTag (${p.result.lean})`
          : '"return:undefined"';
    return `def observation${i} : Option (List String) :=
  let s := initialState
  ${parameters}
  if ${p.conditions.length ? p.conditions.join(" ∧ ") : "True"} then
    let finalState := ${p.state}
    some [${result}, toString (finalState.balances "alice"), toString (finalState.balances "bob"), toString finalState.total, if finalState.requests "case" = none then "no" else "yes", toString finalState.ledger.length]
  else none`;
  });
  return `import Ts2Lean.Modules
import Ts2Lean.LedgerEffects
open Ts2Lean.Ledger Ts2Lean.LedgerEffects
def request : Request := ⟨"case","alice","bob",1⟩
def initialState : State := {opening := fun a => if a = "alice" then 10 else 0, balances := fun a => if a = "alice" then 10 else 0, initialTotal := 10, total := 10, requests := fun _ => none, ledger := []}
def exceptionTag : ExceptionValue → String
  | .error s => "throw:error:" ++ s
  | .string s => "throw:string:" ++ s
  | .integer n => "throw:integer:" ++ toString n
  | .boolean b => "throw:boolean:" ++ toString b
  | .null => "throw:null"
  | .undefined => "throw:undefined"
def receiptTag (r : Request) : String := "return:request:" ++ r.operationId ++ ":" ++ r.from ++ ":" ++ r.to ++ ":" ++ toString r.amount
${definitions.join("\n")}
#eval IO.println ("OBS:" ++ (Lean.toJson ([${site.completions.map((_, i) => `observation${i}`).join(",")}].filterMap id)).compress)
`;
}

test("completion semantics agrees with JavaScript and Lean checks the full control-flow coverage certificate", async (t) => {
  const ws = await LeanWorkspace.create(
    createProject(root, { maxHeartbeats: 800000 }),
  );
  await ws.compile("Ts2Lean/LedgerEffects.lean");
  const declarations = new Map();
  for (const f of ["Database.lean", "Payment.lean"])
    declarations.set(path.join(root, f), await ws.discover(f));
  const file = path.join(root, ".ts2lean", "completion-fixture.ts");
  const fixtures = [
    ["return bypasses catch", `try { return; } catch { throw "wrong"; }`, 0],
    [
      "finally restores return",
      `try { return input; } finally { const x=1n; }`,
      0,
    ],
    [
      "finally return overrides rethrow",
      `try { throw "first"; } catch(error) { throw error; } finally { return; }`,
      0,
    ],
    [
      "finally throw overrides return",
      `try { return input; } finally { throw "final"; }`,
      0,
    ],
    [
      "finally throw overrides throw",
      `try { throw 1n; } finally { throw 2n; }`,
      0,
    ],
    [
      "nested finally",
      `try { try { return; } finally { throw "inner"; } } finally { throw "outer"; }`,
      0,
    ],
    ["string escapes and Unicode", `throw "\\u0041\\0\\b\\f\\n日本語😀";`, 0],
    ["literal backslash-u", String.raw`throw "\\u0041";`, 0],
    [
      "null and undefined throws",
      `try { throw null; } catch(error) { try { throw error; } finally { throw undefined; } }`,
      0,
    ],
    [
      "await rejection through finally",
      `try { await tx.getBalance("alice"); } finally { return; }`,
      1,
    ],
    [
      "catch preserves partial writes",
      `try { await tx.setBalance("alice",5n); throw "caught"; } catch(error) { throw error; }`,
      1,
    ],
    [
      "finally writes after return",
      `try { return; } finally { await tx.setBalance("alice",5n); }`,
      1,
    ],
    [
      "finally failure replaces pending exception",
      `try { throw "original"; } finally { await tx.setBalance("alice",5n); }`,
      1,
    ],
    [
      "ordered finally writes",
      `try { await tx.setBalance("alice",5n); } finally { await tx.setBalance("alice",7n); }`,
      2,
    ],
    [
      "catch return still executes finally",
      `try { throw "caught"; } catch { return; } finally { await tx.setBalance("bob",3n); }`,
      1,
    ],
    [
      "nullable comparison and ternary",
      `const request=await tx.getRequest(input.operationId); if(request === null) { const n=input.amount>0n?1n:2n; throw n; } return request;`,
      1,
    ],
  ];
  try {
    for (const [name, body, count] of fixtures)
      await t.test(name, async () => {
        const source = wrap(body);
        await writeFile(file, source);
        const ir = compileEffects([{ file, name: "scenario" }], declarations);
        await writeFile(
          path.join(ws.dir, "Semantics.lean"),
          emitEffects(
            ir,
            "Payment",
            "Payment.ledgerInvariant",
            false,
            800000,
            true,
          ),
        );
        const certificate = await ws.exec(["Semantics.lean"]);
        assert.equal(certificate.code, 0, name + ": " + certificate.output);
        await writeFile(
          path.join(ws.dir, "Observations.lean"),
          observationProgram(ir.transactions[0]),
        );
        const evaluation = await ws.exec(["Observations.lean"]);
        assert.equal(evaluation.code, 0, evaluation.output);
        const line = evaluation.output
          .split("\n")
          .find((l) => l.startsWith("OBS:"));
        const model = [
          ...new Set(JSON.parse(line.slice(4)).map((o) => JSON.stringify(o))),
        ].sort();
        assert.deepEqual(model, await nativeObservations(source, count));
      });
    await t.test(
      "an expression-bodied callback propagates rejection",
      async () => {
        const source = wrap("await tx.insertRequest(input);").replace(
          "async tx => {await tx.insertRequest(input);}",
          "async tx => await tx.insertRequest(input)",
        );
        await writeFile(file, source);
        const ir = compileEffects([{ file, name: "scenario" }], declarations);
        assert.ok(
          ir.transactions[0].completions.some((p) => p.control === "throw"),
        );
        await writeFile(
          path.join(ws.dir, "Semantics.lean"),
          emitEffects(
            ir,
            "Payment",
            "Payment.ledgerInvariant",
            false,
            800000,
            true,
          ),
        );
        const result = await ws.exec(["Semantics.lean"]);
        assert.equal(result.code, 0, result.output);
      },
    );
    await t.test(
      "dropping an abrupt or successful path fails the certificate",
      async () => {
        const source = wrap(
          'try { await tx.setBalance("alice",5n); } finally { await tx.setBalance("bob",3n); }',
        );
        await writeFile(file, source);
        const original = compileEffects(
          [{ file, name: "scenario" }],
          declarations,
        );
        for (const control of ["throw", "normal"]) {
          const ir = structuredClone(original),
            site = ir.transactions[0];
          // Preserve the structured program; falsify only the path optimizer output.
          site.completions = site.completions.filter(
            (p) => p.control !== control,
          );
          site.paths = site.completions.filter((p) => p.control !== "throw");
          await writeFile(
            path.join(ws.dir, "Semantics.lean"),
            emitEffects(
              ir,
              "Payment",
              "Payment.ledgerInvariant",
              false,
              800000,
              true,
            ),
          );
          const result = await ws.exec(["Semantics.lean"]);
          assert.notEqual(result.code, 0);
          assert.match(result.output, /unsolved goals|sorryAx/);
        }
      },
    );
    await t.test(
      "finally return can suppress an error and commit unsafe partial writes",
      async () => {
        const source = wrap(
          'try { await tx.setBalance("alice",-1n); throw "stop"; } finally { return; }',
        );
        await writeFile(file, source);
        const ir = compileEffects([{ file, name: "scenario" }], declarations);
        await writeFile(
          path.join(ws.dir, "Semantics.lean"),
          emitEffects(
            ir,
            "Payment",
            "Payment.ledgerInvariant",
            false,
            800000,
            true,
          ),
        );
        assert.equal(
          (await ws.exec(["Semantics.lean"])).code,
          0,
          "lowering itself is faithful",
        );
        await writeFile(
          path.join(ws.dir, "Proof.lean"),
          emitEffects(ir, "Payment", "Payment.ledgerInvariant", false, 800000),
        );
        assert.notEqual(
          (await ws.exec(["Proof.lean"])).code,
          0,
          "the application invariant must fail",
        );
        assert.ok(
          (await nativeObservations(source, 1)).some(
            (s) =>
              JSON.parse(s)[0] === "return:undefined" &&
              JSON.parse(s)[1] === "-1",
          ),
        );
      },
    );
    await t.test(
      "outer finally overrides returns and still discovers its transactions",
      async () => {
        const source = wrap("").replace(
          "return await db.transaction(async tx => {});",
          'try { return input; } finally { await db.transaction(async tx => {}); throw "outer"; }',
        );
        await writeFile(file, source);
        const ir = compileEffects([{ file, name: "scenario" }], declarations);
        assert.equal(ir.transactions.length, 1);
        assert.equal(ir.returnObligations.length, 0);
        assert.ok(
          (await nativeObservations(source, 0)).every(
            (s) => JSON.parse(s)[0] === "throw:string:outer",
          ),
        );
        const unsafe = source
          .replace(
            "async tx => {}",
            'async tx => {await tx.setBalance("alice",-1n);}',
          )
          .replace('throw "outer";', "");
        await writeFile(file, unsafe);
        const bad = compileEffects([{ file, name: "scenario" }], declarations);
        assert.equal(bad.transactions.length, 1);
        await writeFile(
          path.join(ws.dir, "Proof.lean"),
          emitEffects(bad, "Payment", "Payment.ledgerInvariant", false, 800000),
        );
        assert.notEqual((await ws.exec(["Proof.lean"])).code, 0);
      },
    );
  } finally {
    await rm(file, { force: true });
  }
});
