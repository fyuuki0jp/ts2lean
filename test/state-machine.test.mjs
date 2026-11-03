import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {fixture} from "./helpers.mjs";
import {processBindings} from "../dist/verify.js";
const code=(await readFile("examples/state-machine/reducer.ts","utf8")).replace("reduce(","run(");
const spec=(await readFile("examples/state-machine/Machine.lean","utf8")).replaceAll("Counter","Spec").replace("def safety", "def contract");
test("actual reducer preserves initial and arbitrary finite steps with source evidence", async()=>{
  const f=await fixture(code,spec);
  try {
    const [good]=await processBindings(f.config,"verify");
    assert.equal(good.status,"verified",good.message);
    assert.equal(good.evidence.profile,"state-machine");
    assert.equal(good.evidence.functions[0].sha256,createHash("sha256").update(code).digest("hex"));
    assert.equal(code.slice(good.evidence.functions[0].span.start,good.evidence.functions[0].span.end).startsWith("export function run"),true);
    const proof=await readFile(good.artifact,"utf8");
    assert.match(proof,/ts2lean_all_executions/);
    assert.match(proof,/StateMachine.finite_safe/);
    await writeFile(path.join(f.dir,"main.ts"),code.replace("if (state > 0n)","if (state >= 0n)"));
    const [bad]=await processBindings(f.config,"verify");
    assert.equal(bad.status,"unproved",bad.message);
    assert.notEqual(bad.evidence.functions[0].sha256,good.evidence.functions[0].sha256);
  } finally {await f.cleanup();}
});
test("unsafe initial state and empty initial set are rejected",async()=>{
  for(const lean of [spec.replace("s = 0","s = -1").replace("⟨0, rfl⟩","⟨-1, rfl⟩"),spec.replace("s = 0","False"),spec.replace("fun i => i.state","fun _ => -1")]) {
    const f=await fixture(code,lean);
    try {
      const [result]=await processBindings(f.config,"verify");
      assert.ok(["unproved","spec-error"].includes(result.status),result.message);
    }finally{await f.cleanup();}
  }
});
