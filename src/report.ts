import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync,renameSync} from "node:fs";
import path from "node:path";
import {Failure,type LeanContract,type Result,type VerificationOptions} from "./types.js";

/** No await between the caller's final live-reference check and publishing the
 * report. Temporary files are renamed synchronously so readers see whole JSON. */
export async function reportVerification(contract:LeanContract|undefined,options:VerificationOptions,verify:(setFinalCheck:(check:()=>void)=>void)=>Promise<Result>):Promise<Result> {
  const explicit=options.report??contract?.options?.report;
  const directory=explicit?.directory??process.env.TS2LEAN_REPORT_DIR;
  const runId=explicit?.runId??process.env.TS2LEAN_RUN_ID;
  if(!directory&&!runId)return verify(()=>{});
  if(!directory||typeof directory!=="string"||!runId||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId))
    throw new Failure("spec-error","Reports need a directory and a simple nonempty runId (or TS2LEAN_REPORT_DIR and TS2LEAN_RUN_ID)");
  const root=path.resolve(contract?.root??process.cwd(),directory,runId);
  const invocationId=randomUUID(),startedAt=new Date().toISOString();
  const publish=(result:Result)=>{
    mkdirSync(root,{recursive:true});
    const file=path.join(root,invocationId+".json"),temporary=file+".tmp";
    writeFileSync(temporary,JSON.stringify({schemaVersion:1,runId,invocationId,startedAt,finishedAt:new Date().toISOString(),result},null,2)+"\n",{flag:"wx"});
    renameSync(temporary,file);
  };
  let result:Result|undefined,finalCheck:(()=>void)|undefined;
  try {result=await verify(check=>{finalCheck=check;});finalCheck?.();}
  catch(error) {
    const report=(error&&typeof error==="object"&&"result" in error ? error.result : undefined) as Result|undefined;
    publish(report??{...result,status:error instanceof Failure?error.status:"tool-error",message:error instanceof Error?error.message:String(error)});
    throw error;
  }
  publish(result);
  return result;
}
