import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import {
  wrap,
  nativeObservations,
  observationProgram,
} from "../scripts/effect-observations.mjs";
import { LeanWorkspace } from "../dist/lean.js";
import { createProject } from "../dist/project.js";
import { compileEffects } from "../dist/effects/compiler.js";
import { emitEffects } from "../dist/effects/emit.js";

const root = path.resolve("examples/payments");

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
