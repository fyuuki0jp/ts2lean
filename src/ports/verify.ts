import path from "node:path";
import {createHash} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {FunctionGraph} from "../object-context.js";
import {compileFunctionObject} from "../compiler.js";
import {LeanWorkspace} from "../lean.js";
import {createProject} from "../project.js";
import {portModel,portProof} from "./emit.js";
import {Failure, type LeanContract,type Result,type UseCaseEntry,type VerificationOptions,type ContractInfo} from "../types.js";

export async function verifyPortCases(graph:FunctionGraph,entries:readonly UseCaseEntry[],portRefs:readonly LeanContract[],options:VerificationOptions,check:()=>void,adapters:NonNullable<NonNullable<Result["assumptions"]>[number]["adapter"]>[]):Promise<Result> {
  let artifact:string|undefined;
  try {
    const first=entries[0]!.contract;
    const all=[...entries.map(e=>e.contract),...portRefs];
    const sources:Record<string,string>={};
    for(const ref of all) {
      if(ref.root!==first.root)throw new Failure("unsupported","Use-case and port contracts must share a project root");
      for(const [file,text] of Object.entries(ref.sources??{})) {
        if(file in sources && sources[file]!==text)throw new Failure("unsupported","Conflicting contract source snapshots");
        sources[file]=text;
      }
    }
    const config=createProject(first.root,{...first.options,...options});
    const ws=await LeanWorkspace.create(config,undefined,Object.keys(sources).length?sources:undefined);
    const infos=new Map<string,ContractInfo[]>();
    for(const ref of all)if(!infos.has(ref.spec))infos.set(ref.spec,await ws.discover(ref.spec));
    const lookup=(ref:LeanContract,kind:"port"|"use-case")=>{
      const info=infos.get(ref.spec)?.find(c=>c.name===ref.name);
      if(info?.kind!==kind || !info.world)throw new Failure("spec-error",`Expected ${kind} contract: ${ref.name}`);
      return info;
    };
    const ports=portRefs.map(ref=>lookup(ref,"port"));
    const contracts=entries.map(e=>lookup(e.contract,"use-case"));
    const world=JSON.stringify(contracts[0]!.world);
    if([...contracts,...ports].some(c=>JSON.stringify(c.world)!==world))throw new Failure("type-error","All use-cases and ports must share state/event/exception types");
    if(new Set(ports.map(p=>p.name)).size!==ports.length)throw new Failure("assumption-mismatch","Use a distinct port contract declaration for each adapter operation");
    const prepared=await graph.prepare(config);
    const cases=graph.compile(prepared,session=>contracts.map((contract,i)=>({contract,
      ir:compileFunctionObject({...session,roots:[session.roots[i]!]},contract,ports)})));
    for(const c of cases)if(!c.ir.functions.find(f=>f.name===c.ir.target)?.async)
      throw new Failure("unsupported","Use-case entrypoints must be async functions");
    check();
    await writeFile(path.join(ws.dir,"ir.json"),JSON.stringify(cases,null,2));
    const imports=[...new Set(all.map(ref=>ws.module(ref.spec)))];
    await writeFile(path.join(ws.dir,"Model.lean"),`import Ts2Lean.Inspect\n${imports.map(m=>`import ${m}`).join("\n")}\n`+cases.map((c,i)=>portModel(c.ir,c.contract,i)).join("\n"));
    await ws.compile("Model.lean");
    artifact=path.join(ws.dir,"Proof.lean");
    await writeFile(artifact,portProof(cases,ports,config.maxHeartbeats));
    const outcome=await ws.exec([artifact]);
    const evidence:NonNullable<Result["evidence"]>={profile:"use-case",contract:{file:first.spec,name:first.name},
      contracts:entries.map((e,i)=>({file:e.contract.spec,name:e.contract.name,target:`Case${i}.Ts2LeanGenerated.${cases[i]!.ir.target}`})),
      leanSources:await ws.sourceEvidence(),functions:cases.flatMap((c,i)=>c.ir.functions.map(f=>({file:f.source,name:f.localName,sha256:f.sourceHash,span:f.span,snapshot:f.snapshot,instance:f.instance,
        modelName:`Case${i}.Ts2LeanGenerated.${f.name}`,modelSha256:createHash("sha256").update(JSON.stringify(f)).digest("hex"),captures:f.captures})))};
    if(outcome.code!==0||outcome.output.includes("declaration uses `sorry`"))return {status:"unproved",message:outcome.output,artifact,evidence};
    const audits=outcome.output.split("\n").filter(l=>l.startsWith("TS2LEAN_AXIOMS:"));
    if(audits.length!==cases.length+3)throw new Failure("tool-error","Missing generated theorem axiom audits");
    check();
    return {status:"verified",artifact,evidence,
      message:"Lean checked all outcomes, operation traces, initial safety and arbitrary finite serial invocations of the supplied functions, conditional on the bound adapter transition contracts. Exception payloads are opaque; no rollback or interleaving is assumed.",
      axioms:[...new Set(audits.flatMap(l=>JSON.parse(l.slice(15)) as string[]))],
      assumptions:portRefs.map((ref,i)=>({identity:ref.name,assurance:"assumed",declaration:`${ref.spec}#${ref.name}`,adapter:adapters[i],settings:{},laws:[{name:"runtime-refinement",assurance:"assumed",statement:"The exact bound receiver and method refine this port's complete transition relation, including fulfillment, synchronous throw, asynchronous rejection and any persistent effects on failure. This adapter correspondence is assumed, not proved."}]})),
      scope:{functions:evidence.functions.map(f=>`${f.file}#${f.name}`),transactions:0,paths:0,
        semantics:"Structural typed completion programs; all port outcomes quantified; actual source snapshots and exact receiver/method bindings checked.",
        execution:"Arbitrary finite serial invocations, including exceptional completions. Invariants at operation boundaries; no scheduler/interleaving or liveness claim.",artifacts:[artifact,path.join(ws.dir,"Model.lean"),path.join(ws.dir,"ir.json")]}};
  } catch(error) {
    return {status:error instanceof Failure?error.status:"tool-error",message:error instanceof Error?error.message:String(error),artifact};
  }
}
