import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { processBindings } from "../dist/verify.js";
import { compileTypeScript } from "../dist/compiler.js";
import { LeanWorkspace } from "../dist/lean.js";
const spec = `import Ts2Lean.Contract
namespace Spec
inductive Choice where
 | value (amount : Int)
 | empty
def contract : Ts2Lean.Contract Choice Choice where
 pre := fun _ => True
 post := fun input output => output = match input with
  | .value n => .value (n+1)
  | .empty => .empty
end Spec
`;
const source = `type Choice={readonly kind:"value";readonly amount:bigint}|{readonly kind:"empty"};
export function run(input:Choice):Choice {if(input.kind === "value"){return {kind:"value",amount:input.amount+1n};} return {kind:"empty"};}`;
test("Lean inductive contracts verify discriminated union branches and reject wrong variants", async () => {
  const f = await fixture(source, spec);
  try {
    const [good] = await processBindings(f.config, "verify");
    assert.equal(good.status, "verified", good.message);
    await writeFile(
      path.join(f.dir, "main.ts"),
      source.replace("amount:input.amount+1n", "amount:input.amount-1n"),
    );
    const [bad] = await processBindings(f.config, "verify");
    assert.equal(bad.status, "unproved", bad.message);
    await writeFile(
      path.join(f.dir, "main.ts"),
      source.replace(
        'input.kind === "value"',
        '!(input.kind === "empty") && input.amount === input.amount',
      ),
    );
    const [equivalent] = await processBindings(f.config, "verify");
    assert.equal(equivalent.status, "verified", equivalent.message);
  } finally {
    await f.cleanup();
  }
});
test("union lowering rejects ambiguous tags, mutation and unsafe access", async () => {
  const f = await fixture(source, spec);
  try {
    const ws = await LeanWorkspace.create(f.config),
      info = await ws.inspect("Spec.lean", "Spec.contract");
    for (const invalid of [
      source.replace('readonly kind:"empty"', 'readonly kind:"value"'),
      source.replace("if(input.kind", 'input.kind="empty";if(input.kind'),
      source.replace("input.amount+1n", "(input as any).amount+1n"),
    ]) {
      await writeFile(path.join(f.dir, "main.ts"), invalid);
      assert.throws(() =>
        compileTypeScript(path.join(f.dir, "main.ts"), "run", info, new Map()),
      );
    }
  } finally {
    await f.cleanup();
  }
});
