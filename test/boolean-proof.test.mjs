import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.mjs";
import { processBindings } from "../dist/verify.js";

test("boolean implications prove disjunctive postconditions without accepting a wrong decision", async () => {
  const source = `type Facts={readonly uncertain:boolean;readonly permanent:boolean;readonly hasRetryBudget:boolean};
type Decision={readonly kind:"uncertain"}|{readonly kind:"queued"}|{readonly kind:"failed"};
export function run(input:Facts):Decision {
 if(input.uncertain)return {kind:"uncertain"};
 if(!input.permanent && input.hasRetryBudget)return {kind:"queued"};
 return {kind:"failed"};
}`;
  const spec = `import Ts2Lean.Contract
namespace Spec
structure Facts where
  uncertain : Bool
  permanent : Bool
  hasRetryBudget : Bool
inductive Decision where
  | uncertain
  | queued
  | failed
def contract : Ts2Lean.Contract Facts Decision where
  pre := fun _ => True
  post := fun i result =>
    (result = .uncertain ↔ i.uncertain = true) ∧
    (result = .queued ↔ i.uncertain = false ∧ i.permanent = false ∧ i.hasRetryBudget = true) ∧
    (result = .failed ↔ i.uncertain = false ∧ (i.permanent = true ∨ i.hasRetryBudget = false))
end Spec
`;
  const f = await fixture(source, spec);
  try {
    const [good] = await processBindings(f.config, "verify");
    assert.equal(good.status, "verified", good.message);
    assert.ok(!good.axioms.includes("sorryAx"));
    await writeFile(path.join(f.dir,"main.ts"), source.replace("!input.permanent", "input.permanent"));
    const [bad] = await processBindings(f.config,"verify");
    assert.equal(bad.status,"unproved",bad.message);
  } finally { await f.cleanup(); }
});
