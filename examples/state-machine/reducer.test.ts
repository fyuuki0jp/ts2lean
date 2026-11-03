import {test, expect} from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import {randomUUID} from "node:crypto";
import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
import {safety} from "./Machine.lean";
import {reduce} from "./reducer";
test("the actual reducer preserves safety for all finite action sequences", async()=>{
  const runId=randomUUID(),directory=path.join(import.meta.dirname,".ts2lean/reports");
  const options={report:{directory,runId}};
  await expect(reduce).toPreserveInvariant(safety,options);
  const broken=(state:bigint,add:boolean):bigint=>-1n;
  await expect(expect(broken).toPreserveInvariant(safety,options)).rejects.toMatchObject({result:{status:"unproved"}});
  const files=await readdir(path.join(directory,runId));
  const reports=await Promise.all(files.map(f=>readFile(path.join(directory,runId,f),"utf8").then(JSON.parse)));
  expect(reports.map(r=>r.result.status).sort()).toEqual(["unproved","verified"]);
  expect(reports.every(r=>r.result.evidence?.profile==="state-machine")).toBe(true);
});
