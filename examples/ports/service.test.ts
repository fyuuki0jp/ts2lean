import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {LeanWorkspace} from "../../dist/lean.js";
import {createProject} from "../../dist/project.js";
import {test,expect} from "vitest";
import {bindPort,verifyUseCases} from "@fyuuki0jp/ts2lean";
import {authorization,storage,save} from "./Save.lean";
import {createService,type Ports} from "./service";
import {mutations} from "./mutations";
const adapter:Ports={
  async authorize(input){return input.allowed?{ok:true,value:0n}:{ok:false,error:{kind:"denied"}};},
  async commit(input){return {ok:true,value:input.amount};},
};
const options=()=>({ports:[bindPort(adapter,"authorize",authorization),bindPort(adapter,"commit",storage)],timeoutMs:90_000,maxHeartbeats:2000000});
let verifiedModel="";
const service=createService(adapter);
test("actual use-cases and async helpers preserve safety for arbitrary serial combinations",async()=>{
  const result=await verifyUseCases([{fn:service.save,contract:save},{fn:service.saveViaHelper,contract:save}],options());
  verifiedModel=await readFile(new URL("Model.lean",pathToFileURL(result.artifact!)),"utf8");
  expect(result.status).toBe("verified");
  expect(result.assumptions).toHaveLength(2);
  expect(result.assumptions!.every(a=>a.adapter?.source?.sha256 && a.adapter.key)).toBe(true);
  expect(result.evidence?.contracts).toHaveLength(2);
  expect(result.evidence?.functions.some(f=>f.name.startsWith("@"))).toBe(true);
  expect(result.scope?.transactions).toBe(0);
});
test("intermediate Result payloads remain distinct across a port and pure helper",async()=>{
  const result=await verifyUseCases([{fn:service.saveViaProjection,contract:save}],options());
  expect(result.status).toBe("verified");
});
const broken=mutations(adapter);
for(const name of ["noAuthorization","noCommit","wrongOrder","twice"] as const)
  test(`reject ${name} as unproved, not unsupported`,async()=>{
    await expect(verifyUseCases([{fn:broken[name],contract:save}],options())).rejects.toMatchObject({result:{status:"unproved"}});
  });
for(const name of ["unawaited","nestedAwait"] as const)
  test(`fail closed for ${name}`,async()=>{
    await expect(verifyUseCases([{fn:broken[name],contract:save}],options())).rejects.toMatchObject({result:{status:"unsupported"}});
  });
test("bindings cannot be forged, reassigned or borrowed by another receiver",async()=>{
  const opts=options();
  const original=adapter.commit;
  try {
    (adapter as {commit:Ports["commit"]}).commit=async i=>({ok:true,value:i.amount});
    await expect(verifyUseCases([{fn:service.save,contract:save}],opts)).rejects.toMatchObject({status:"assumption-mismatch"});
  } finally {(adapter as {commit:Ports["commit"]}).commit=original;}
  await expect(verifyUseCases([{fn:service.save,contract:save}],{ports:[{kind:"ts2lean.port-binding"}]})).rejects.toMatchObject({status:"assumption-mismatch"});
  const other={...adapter};
  await expect(verifyUseCases([{fn:createService(other).save,contract:save}],opts)).rejects.toMatchObject({result:{status:"unsupported"}});
});

test("native outcomes and traces are admitted by the actual generated Lean execution relation",async()=>{
  expect(verifiedModel).not.toBe("");
  const ws=await LeanWorkspace.create(createProject(import.meta.dirname,{timeoutMs:90_000}));
  await writeFile(path.join(ws.dir,"Model.lean"),verifiedModel);
  await ws.compile("Ts2Lean/Inspect.lean");
  await ws.compile("Save.lean");
  await ws.compile("Model.lean");
  let assertions="import Model\nset_option linter.unusedSimpArgs false\n";
  let index=0;
  type Reply=Awaited<ReturnType<Ports["commit"]>>;
  const reply=(r:Reply)=>r.ok?`(Save.Reply.ok (${r.value}:Int))`:`(Save.Reply.err Save.Problem.${r.error.kind})`;
  for(const allowed of [false,true])for(const authMode of ["ok","denied","reject","throw"])
    for(const commitMode of ["ok","conflict","reject","rejectAfter","throw","throwAfter"]) {
      let state=0n;
      const trace:string[]=[];
      const observed:{completion:string;outcome:string;world:string;state:bigint}[]=[];
      const fault={opaque:index};
      const world=()=>`({state:=(${state}:Int),trace:=[${trace.join(",")}]}:Ts2Lean.Ports.World Int Save.Event)`;
      const act=(which:"authorize"|"commit",input:{allowed:boolean;amount:bigint}):Promise<Reply>=>{
        const mode=which==="authorize"?authMode:commitMode;
        trace.push(which==="authorize"?`Save.Event.authorize ${allowed}`:`Save.Event.commit (${input.amount}:Int)`);
        const raised=mode.startsWith("reject")||mode.startsWith("throw");
        if(which==="commit"&&(mode==="ok"||mode.endsWith("After")))state++;
        const returned:Reply=which==="authorize"
          ? mode==="ok"&&input.allowed?{ok:true,value:0n}:{ok:false,error:{kind:"denied"}}
          :mode==="ok"?{ok:true,value:input.amount}:{ok:false,error:{kind:"conflict"}};
        trace.push(raised?mode.startsWith("reject")?"Save.Event.rejected":"Save.Event.threw"
          :which==="authorize"?returned.ok?"Save.Event.authorized":"Save.Event.denied"
          :returned.ok?"Save.Event.committed":"Save.Event.conflict");
        observed.push({completion:raised?"(.thrown ())":`(.normal ${reply(returned)})`,
          outcome:raised?mode.startsWith("reject")?"(.rejected ())":"(.threw ())":`(.fulfilled ${reply(returned)})`,world:world(),state});
        if(mode.startsWith("throw"))throw fault;
        return mode.startsWith("reject")?Promise.reject(fault):Promise.resolve(returned);
      };
      const actual=createService({authorize:i=>act("authorize",i),commit:i=>act("commit",i)});
      let completion:string;
      try {completion=`(.returned ${reply(await actual.save({allowed,amount:7n}))})`;}
      catch(error){expect(error).toBe(fault);completion="(.thrown ())";}
      let proof="⟨rfl,rfl⟩";
      for(const call of [...observed].reverse())proof=`⟨${call.completion},${call.world},⟨${call.outcome},(${call.state}:Int),by simp [Save.authorization,Save.storage],rfl,rfl⟩,${proof}⟩`;
      assertions+=`example : (Case0.Ts2LeanGenerated.fn0 {allowed:=${allowed},amount:=7}).exec {state:=0,trace:=[]} ${completion} ${world()} := by\n  exact ${proof}\n`;
      index++;
    }
  await writeFile(path.join(ws.dir,"Observations.lean"),assertions);
  const checked=await ws.exec(["Observations.lean"]);
  expect(checked.code,checked.output).toBe(0);
  expect(index).toBe(48);
});
