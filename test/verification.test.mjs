import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fixture, intSpec } from "./helpers.mjs";
import { verify, extract } from "../dist/verify.js";
import { LeanWorkspace, run } from "../dist/lean.js";
import { compileTypeScript } from "../dist/compiler.js";
import { emitModel, emitExpr } from "../dist/emit.js";
import { contractTypes } from "../dist/verify.js";
import { ts } from "@ts-morph/common";

test("sample verifies; changing subtraction to addition invalidates proof", async () => {
  const source = await readFile("examples/balance/balance.ts", "utf8"),
    spec = await readFile("examples/balance/Balance.lean", "utf8");
  const f = await fixture(
    source
      .replace("./Balance.lean", "./Spec.lean")
      .replace("withdraw as", "contract as")
      .replace("function withdraw", "function run"),
    spec.replaceAll("Balance", "Spec").replace("def withdraw", "def contract"),
  );
  try {
    const [good] = await verify(f.config);
    assert.equal(good.status, "verified", good.message);
    assert.ok(
      good.axioms.every((a) =>
        ["propext", "Classical.choice", "Quot.sound"].includes(a),
      ),
    );
    const original = await readFile(path.join(f.dir, "main.ts"), "utf8");
    await writeFile(
      path.join(f.dir, "main.ts"),
      original.replace(
        "input.balance - input.amount",
        "input.balance + input.amount",
      ),
    );
    const [bad] = await verify(f.config);
    assert.equal(bad.status, "unproved");
    const [model] = await extract(f.config);
    assert.equal(model.status, "extracted");
    assert.match(await readFile(model.artifact, "utf8"), /\+/);
  } finally {
    await f.cleanup();
  }
});

test("reports contract mismatch, malformed specification, sorry, and custom axioms", async (t) => {
  const cases = [
    [
      "signature mismatch",
      "export function run(x: boolean): boolean { return x; }",
      intSpec,
      "type-error",
    ],
    [
      "syntax error",
      "export function run(x: bigint): bigint { return x; }",
      intSpec + "\nthis is not Lean",
      "spec-error",
    ],
    [
      "sorry",
      "export function run(x: bigint): bigint { return x; }",
      intSpec.replace("o = i + 1", "(by sorry : Prop)"),
      "spec-error",
    ],
    [
      "axiom",
      "export function run(x: bigint): bigint { return x; }",
      intSpec
        .replace("def contract", "axiom invented : Prop\ndef contract")
        .replace("o = i + 1", "invented"),
      "spec-error",
    ],
  ];
  for (const [name, source, spec, status] of cases)
    await t.test(name, async () => {
      const f = await fixture(source, spec);
      try {
        const [result] = await verify(f.config);
        assert.equal(result.status, status, result.message);
      } finally {
        await f.cleanup();
      }
    });
});

test("bounded Lean process and missing executable produce distinct errors", async () => {
  const f = await fixture(
    "export function run(x: bigint): bigint { return x + 1n; }",
    intSpec,
    { timeoutMs: 1 },
  );
  try {
    assert.equal((await verify(f.config))[0].status, "timeout");
    assert.equal(
      (await verify({ ...f.config, lean: "/missing/lean" }))[0].status,
      "tool-error",
    );
  } finally {
    await f.cleanup();
  }
});

test("Lean and JavaScript agree on branches, helpers, shadowing, records, and huge integers", async () => {
  const source = `type Input = { readonly x: bigint; readonly positive: boolean };
function twice(x: bigint): bigint { return x * 2n; }
export function run(input: Input): bigint {
  const x = input.x;
  if (input.positive && !(x < 0n)) {
    const output = { value: twice(x) };
    return output.value;
  }
  if (x === -1n) { const x = 999n; return x; }
  { const x = 42n; const y = twice(x); }
  return x !== 0n ? -x + 0xffn : 0n;
}`;
  const spec = `import Ts2Lean.Contract
namespace Spec
structure Input where
  x : Int
  positive : Bool
def contract : Ts2Lean.Contract Input Int where
  pre := fun _ => True
  post := fun _ _ => True
end Spec`;
  const f = await fixture(source, spec);
  try {
    const ws = await LeanWorkspace.create(f.config),
      info = await ws.inspect("Spec.lean", "Spec.contract");
    const ir = compileTypeScript(
      path.join(f.dir, "main.ts"),
      "run",
      info,
      new Map(),
    );
    await writeFile(path.join(ws.dir, "Model.lean"), emitModel(ir, "Spec"));
    await ws.compile("Model.lean");
    const js = await import(
      "data:text/javascript;base64," +
        Buffer.from(
          ts.transpileModule(source, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
            },
          }).outputText,
        ).toString("base64")
    );
    const xs = [
      -999999999999999999999999999999999999n,
      -2n,
      -1n,
      0n,
      1n,
      9n,
      999999999999999999999999999999999999n,
    ];
    const cases = xs.flatMap((x) =>
      [true, false].map((positive) => ({ x, positive })),
    );
    const lines = cases.map(
      (i) =>
        `#eval toString (Ts2LeanGenerated.${ir.target} { x := (${i.x}:Int), positive := ${i.positive} })`,
    );
    await writeFile(
      path.join(ws.dir, "Eval.lean"),
      "import Model\n" + lines.join("\n"),
    );
    const result = await ws.exec(["Eval.lean"]);
    assert.equal(result.code, 0, result.output);
    const actual = result.output
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      actual,
      cases.map((i) => js.run(i).toString()),
    );
  } finally {
    await f.cleanup();
  }
});

test("record output and boolean postcondition can be proved without handwritten proof", async () => {
  const source = `type Input={readonly balance:bigint;readonly amount:bigint};
type Output={readonly balance:bigint;readonly accepted:boolean};
export function run(i:Input):Output {
  if(i.amount <= i.balance) return {balance:i.balance-i.amount,accepted:true};
  return {balance:i.balance,accepted:false};
}`;
  const spec = `import Ts2Lean.Contract
namespace Spec
structure Input where
  balance : Int
  amount : Int
structure Output where
  balance : Int
  accepted : Bool
def contract : Ts2Lean.Contract Input Output where
  pre := fun i => 0 ≤ i.balance ∧ 0 ≤ i.amount
  post := fun i o => 0 ≤ o.balance ∧ (o.accepted = true ↔ i.amount ≤ i.balance)
end Spec`;
  const f = await fixture(source, spec);
  try {
    const [result] = await verify(f.config);
    assert.equal(result.status, "verified", result.message);
  } finally {
    await f.cleanup();
  }
});

test("reserved generated module names cannot overwrite a specification snapshot", async () => {
  const f = await fixture(
    "export function run(x: bigint): bigint { return x + 1n; }",
    intSpec,
  );
  try {
    await writeFile(path.join(f.dir, "Model.lean"), intSpec);
    const [result] = await verify(f.config);
    assert.equal(result.status, "spec-error");
    assert.match(result.message, /Reserved generated module/);
  } finally {
    await f.cleanup();
  }
});
