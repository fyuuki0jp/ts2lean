import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {readFile,writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {fixture} from "./helpers.mjs";
import {processBindings} from "../dist/verify.js";
import {compileTypeScript} from "../dist/compiler.js";
import {LeanWorkspace} from "../dist/lean.js";
import {emitModel} from "../dist/emit.js";
import {encodeInput,leanObservation} from "../scripts/observations.mjs";

const source=await readFile("examples/history/history.ts","utf8");
const spec=(await readFile("examples/history/History.lean","utf8")).replaceAll("History","Spec");
const bindings=[{module:"main.ts",export:"createHistory",spec:"Spec.lean",contract:"Spec.create"},
  {module:"main.ts",export:"transitionHistory",spec:"Spec.lean",contract:"Spec.bounded"}];

test("generic history initializer and finite fixed-limit sequences prove reachable array safety",async()=>{
  const f=await fixture(source,spec,{bindings});
  try {
    const results=await processBindings(f.config,"verify");
    for(const r of results)assert.equal(r.status,"verified",r.message);
    assert.equal(results[1].evidence.dataProfile.name,"snapshot");
    assert.match(results[1].evidence.dataProfile.numberDomain,/signed zero/);
    const proof=await readFile(results[1].artifact,"utf8");
    assert.match(proof,/ts2lean_step_checked/);
    assert.match(proof,/ts2lean_all_executions/);
    assert.match(proof,/admissible i/);
    const bad=spec.replaceAll("= 80","= 0");
    await writeFile(path.join(f.dir,"Spec.lean"),bad);
    const [zero]=await processBindings({...f.config,bindings:[bindings[1]]},"verify");
    assert.equal(zero.status,"unproved",zero.message);
    await writeFile(path.join(f.dir,"Spec.lean"),spec.replace("i.maximumPast.value = 80","True"));
    const [varying]=await processBindings({...f.config,bindings:[bindings[1]]},"verify");
    assert.equal(varying.status,"unproved",varying.message);
  } finally {await f.cleanup();}
});

test("history array operations preserve native payload identity and actual JSON observations",async()=>{
  const f=await fixture(source,spec,{bindings});
  try {
    const ws=await LeanWorkspace.create(f.config);
    const info=await ws.inspect("Spec.lean","Spec.bounded");
    const ir=compileTypeScript(path.join(f.dir,"main.ts"),"transitionHistory",info,new Map());
    await writeFile(path.join(ws.dir,"Model.lean"),emitModel(ir,"Spec"));
    await ws.compile("Model.lean");
    const {createHistory,transitionHistory}=await import(pathToFileURL(path.join(f.dir,"main.ts")).href);
    const pool=[undefined,null,{}, {a:undefined}, {a:1,b:2}, {b:2,a:1},"\ud800","😀",NaN,Infinity,-0,0];
    const toModel=(shape,v)=>shape.kind==="snapshot"?{identity:pool.findIndex(x=>Object.is(x,v)),json:JSON.stringify(v)}:
      shape.kind==="array"?v.map(x=>toModel(shape.element,x)):
      shape.kind==="record"?Object.fromEntries(shape.fields.map(f=>[f.name,toModel(f.shape,v[f.name])])):
      shape.kind==="union"?{[shape.tag]:v[shape.tag],...Object.fromEntries(shape.variants.find(x=>x.tag===v[shape.tag]).fields.map(f=>[f.name,toModel(f.shape,v[f.name])]))}:v;
    const observed=(shape,v)=>shape.kind==="jsstring"?Array.from({length:v.length},(_,i)=>v.charCodeAt(i)):
      shape.kind==="safeinteger"?[String(v),Object.is(v,-0)]:
      shape.kind==="snapshot"?{identity:v.identity,json:v.json===undefined?null:observed({kind:"jsstring"},v.json)}:
      shape.kind==="array"?v.map(x=>observed(shape.element,x)):
      shape.kind==="record"?Object.fromEntries(shape.fields.map(f=>[f.name,observed(f.shape,v[f.name])])):v;
    const inputs=[];
    for(const maximumPast of [0,-0,1,3,80,9007199254740991]) {
      let state=createHistory(pool[0]);
      const actions=[{kind:"undo"},{kind:"redo"},...pool.map(value=>({kind:"change",value})),
        ...Array.from({length:15},()=>({kind:"undo"})),...Array.from({length:15},()=>({kind:"redo"}))];
      for(const action of actions) {
        inputs.push({state,action,maximumPast});
        state=transitionHistory(state,action,maximumPast);
      }
    }
    const expected=inputs.map(i=>observed(info.output,toModel(info.output,transitionHistory(i.state,i.action,i.maximumPast))));
    await writeFile(path.join(ws.dir,"Eval.lean"),"import Model\n"+inputs.map(i=>
      `#eval IO.println (${leanObservation(info.output,`Ts2LeanGenerated.${ir.target} ${encodeInput(info.input,toModel(info.input,i))}`)}).compress`).join("\n"));
    const actual=await ws.exec(["Eval.lean"]);
    assert.equal(actual.code,0,actual.output);
    assert.deepEqual(actual.output.trim().split("\n").map(JSON.parse),expected);
    assert.throws(()=>encodeInput({kind:"safeinteger"},NaN));
    assert.throws(()=>encodeInput({kind:"safeinteger"},Infinity));
    assert.throws(()=>encodeInput({kind:"safeinteger"},1.5));
    assert.throws(()=>encodeInput({kind:"safeinteger"},9007199254740992));
  } finally {await f.cleanup();}
});

test("snapshot operations fail closed without a profile and unchecked indexes cannot prove",async()=>{
  const lean=`import Ts2Lean.Contract
namespace Spec
def contract : Ts2Lean.Contract (List Int) Int where
  pre := fun _ => True
  post := fun _ _ => True
#ts2lean_snapshot_profile contract
end Spec
`;
  const f=await fixture('export function run(xs:readonly bigint[]):bigint{return xs[0]!;}',lean);
  try {
    const [unsafe]=await processBindings(f.config,"verify");
    assert.equal(unsafe.status,"unproved",unsafe.message);
    await writeFile(path.join(f.dir,"Spec.lean"),lean.replace('pre := fun _ => True','pre := fun xs => xs ≠ []'));
    const [safe]=await processBindings(f.config,"verify");
    assert.equal(safe.status,"verified",safe.message);
    await writeFile(path.join(f.dir,"Spec.lean"),lean.replace('#ts2lean_snapshot_profile contract',''));
    const [undeclared]=await processBindings(f.config,"verify");
    assert.equal(undeclared.status,"unsupported",undeclared.message);
    const info={name:"contract",input:{kind:"int"},output:{kind:"int"},unfold:[]};
    await writeFile(path.join(f.dir,"main.ts"),'export function run(x:bigint):bigint{return [x][2]!;}');
    assert.throws(()=>compileTypeScript(path.join(f.dir,"main.ts"),"run",info,new Map()),/snapshot_profile/);
  } finally {await f.cleanup();}
});

test("discarded values, literal tags and coercions retain every evaluated safety obligation",async()=>{
  const boolSpec=`import Ts2Lean.Contract
namespace Spec
def contract : Ts2Lean.Contract Int Bool where
  pre := fun _ => True
  post := fun _ _ => True
#ts2lean_snapshot_profile contract
end Spec`;
  const inputs=[
    ['export function run(x:bigint):boolean{return ({bad:[{n:x}][1]!.n,ok:true}).ok;}',boolSpec],
    ['export function run(x:bigint):boolean{return [{tag:"ok"}][1]!.tag === "ok";}',boolSpec],
    [`function h(xs:readonly bigint[]):undefined{const x=xs[0]!;return undefined;}
      export function run(xs:readonly bigint[]):bigint|undefined{return h(xs);}`,
      boolSpec.replace('Int Bool','(List Int) (Option Int)')],
    [`function h(xs:readonly bigint[]):{readonly tag:"ok"}{const x=xs[0]!;return {tag:"ok"};}
      export function run(xs:readonly bigint[]):{readonly tag:string}{return h(xs);}`,
      boolSpec.replace('def contract','structure Out where\n  tag : Ts2Lean.JSString\ndef contract').replace('Int Bool','(List Int) Out')],
  ];
  for(const [source,spec] of inputs) {
    const f=await fixture(source,spec);
    try {
      const [result]=await processBindings(f.config,"verify");
      assert.equal(result.status,"unproved",result.message);
      const model=await readFile(path.join(path.dirname(result.artifact),"Model.lean"),"utf8");
      assert.match(model,/inBounds/);
    } finally {await f.cleanup();}
  }
});

test("optional object/number equality and imported JSON impostors fail closed",async()=>{
  const f=await fixture('', '-- static compiler boundary probes');
  try {
    for(const [type,shape] of [['number',{kind:"safeinteger"}],['readonly bigint[]',{kind:"array",element:{kind:"int"}}]]) {
      await writeFile(path.join(f.dir,"main.ts"),`export function run(i:{readonly a:${type}|undefined;readonly b:${type}|undefined}):boolean{return i.a===i.b;}`);
      const input={kind:"record",lean:"Input",fields:["a","b"].map(name=>({name,shape:{kind:"optional",element:shape}}))};
      assert.throws(()=>compileTypeScript(path.join(f.dir,"main.ts"),"run",{name:"probe",input,output:{kind:"bool"},unfold:[],dataProfile:"snapshot"},new Map()),/Optional equality/);
    }
    await writeFile(path.join(f.dir,"shadow.d.ts"),'export declare const JSON:{stringify(x:unknown):string|undefined};');
    await writeFile(path.join(f.dir,"main.ts"),'import {JSON} from "./shadow.js"; export function run(x:unknown):string|undefined{return JSON.stringify(x);}');
    assert.throws(()=>compileTypeScript(path.join(f.dir,"main.ts"),"run",{name:"probe",input:{kind:"snapshot"},output:{kind:"optional",element:{kind:"jsstring"}},unfold:[],dataProfile:"snapshot"},new Map()),/standard one-argument JSON/);
  } finally {await f.cleanup();}
});

test("history contracts preserve exact payload order and reject a length-preserving mutation",async()=>{
  const step={...bindings[1],contract:"Spec.step"};
  const f=await fixture(source,spec,{bindings:[step]});
  try {
    const [good]=await processBindings(f.config,"verify");
    assert.equal(good.status,"verified",good.message);
    await writeFile(path.join(f.dir,"main.ts"),source.replace('future: [state.present, ...state.future]','future: [...state.future, state.present]'));
    const [wrongOrder]=await processBindings(f.config,"verify");
    assert.equal(wrongOrder.status,"unproved",wrongOrder.message);
    await writeFile(path.join(f.dir,"main.ts"),source.replace('present: state.past.at(-1)!','present: state.past.at(0)!'));
    const [wrongValue]=await processBindings(f.config,"verify");
    assert.equal(wrongValue.status,"unproved",wrongValue.message);
  } finally {await f.cleanup();}
});
