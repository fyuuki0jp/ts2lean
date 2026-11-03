import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {reportVerification} from "../dist/report.js";
import {Failure} from "../dist/types.js";
import {verifyFunction} from "../dist/runtime.js";

test("report setup preserves the invalid-contract diagnostic", async () => {
  await assert.rejects(verifyFunction(x=>x,{}), /Import the Lean contract/);
});

test("reports are run-scoped complete results and a final reference failure cannot publish verified",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"ts2lean-report-"));
  try {
    const options={report:{directory,runId:"coverage-42"}};
    const good=await reportVerification(undefined,options,async(setCheck)=>{
      setCheck(()=>{});return {status:"verified",message:"checked"};
    });
    assert.equal(good.status,"verified");
    await assert.rejects(reportVerification(undefined,options,async(setCheck)=>{
      let changed=false;
      setCheck(()=>{if(changed)throw new Failure("unsupported","capture changed before publishing");});
      queueMicrotask(()=>{changed=true;});
      return {status:"verified",message:"intermediate proof passed"};
    }),/capture changed/);
    const files=await readdir(path.join(directory,"coverage-42"));
    assert.equal(files.length,2);
    const reports=await Promise.all(files.map(f=>readFile(path.join(directory,"coverage-42",f),"utf8").then(JSON.parse)));
    assert.deepEqual(reports.map(r=>r.result.status).sort(),["unsupported","verified"]);
    assert.ok(reports.every(r=>r.runId==="coverage-42"&&r.schemaVersion===1&&r.invocationId));
    assert.notEqual(reports[0].invocationId,reports[1].invocationId);
    await assert.rejects(reportVerification(undefined,{report:{directory,runId:"../old"}},async()=>good),/Reports need/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
