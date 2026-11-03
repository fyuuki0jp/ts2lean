import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fixture } from "./helpers.mjs";
import { processBindings } from "../dist/verify.js";
import { LeanWorkspace } from "../dist/lean.js";
import { compileTypeScript, compileFunctionObject } from "../dist/compiler.js";
import {withProgram,compilerOptions} from "../dist/native.js";
import * as ts from "typescript/ast";
import { emitModel } from "../dist/emit.js";
import { encodeInput, leanObservation } from "../scripts/observations.mjs";

const spec = `import Ts2Lean.Contract
namespace Spec
structure Input where
  operationId : Ts2Lean.JSString
  digest : Ts2Lean.JSString
def contract : Ts2Lean.Contract Input Bool where
  pre := fun _ => True
  post := fun i o => o = decide (i.operationId = i.digest)
end Spec
`;
const source = 'export function run(i:{readonly operationId:string;readonly digest:string}):boolean{return i.operationId === i.digest;}';

test("UTF-16 equality proves actual string inputs and rejects changed comparisons", async () => {
  const f = await fixture(source, spec);
  try {
    const [good] = await processBindings(f.config, "verify");
    assert.equal(good.status, "verified", good.message);
    await writeFile(path.join(f.dir,"main.ts"),source.replace('===','!=='));
    const [bad] = await processBindings(f.config, "verify");
    assert.equal(bad.status,"unproved",bad.message);
  } finally { await f.cleanup(); }
});

test("UTF-16 string comparison agrees with JS for surrogates, NUL, and normalization distinctions", async () => {
  const f = await fixture(source, spec);
  try {
    const ws = await LeanWorkspace.create(f.config);
    const info = await ws.inspect("Spec.lean","Spec.contract");
    const ir = compileTypeScript(path.join(f.dir,"main.ts"),"run",info,new Map());
    await writeFile(path.join(ws.dir,"Model.lean"),emitModel(ir,"Spec"));
    const built = await ws.exec(["-o","Model.olean","Model.lean"]);
    assert.equal(built.code,0,built.output);
    const strings = ["","same","\0","\ud800","\udc00","\ud800\udc00","\ufffd","é","e\u0301","😀"];
    const inputs = strings.flatMap(operationId=>strings.map(digest=>({operationId,digest})));
    await writeFile(path.join(ws.dir,"Eval.lean"),"import Model\n"+inputs.map(i=>`#eval IO.println (${leanObservation(info.output,`Ts2LeanGenerated.${ir.target} ${encodeInput(info.input,i)}`)}).compress`).join("\n"));
    const evaluated = await ws.exec(["Eval.lean"]);
    assert.equal(evaluated.code,0,evaluated.output);
    const {run} = await import(pathToFileURL(path.join(f.dir,"main.ts")).href);
    assert.deepEqual(evaluated.output.trim().split("\n").map(JSON.parse),inputs.map(run));
    for(const [code, expected] of [
      ['export function run(x:string):string{return "\\ud800\\0😀";}',[55296,0,55357,56832]],
      ['export function run(x:string):string{return x;}',[56320,0]],
    ]) {
      await writeFile(path.join(f.dir,"main.ts"),code);
      const shape={kind:"jsstring"};
      const ir2=compileTypeScript(path.join(f.dir,"main.ts"),"run",{name:"text",input:shape,output:shape,unfold:[]},new Map());
      await writeFile(path.join(ws.dir,"Text.lean"),emitModel(ir2,"Spec")+`\n#eval IO.println (${leanObservation(shape,`Ts2LeanGenerated.${ir2.target} ${encodeInput(shape,"\udc00\0")}`)}).compress`);
      const out=await ws.exec(["Text.lean"]);
      assert.equal(out.code,0,out.output);
      assert.deepEqual(JSON.parse(out.output.trim().split("\n").at(-1)),expected);
    }
  } finally {await f.cleanup();}
});

test("void is not collapsed to undefined in inputs, fields or port outputs",async()=>{
  const f=await fixture(source,spec);
  try {
    for(const [code,input] of [
      ['export function run(x:void):boolean{return x === undefined;}',{kind:"unit"}],
      ['export function run(x:{readonly value:void}):boolean{return x.value === undefined;}',{kind:"record",lean:"Record",fields:[{name:"value",shape:{kind:"unit"}}]}],
    ]) {
      await writeFile(path.join(f.dir,"main.ts"),code);
      assert.throws(()=>compileTypeScript(path.join(f.dir,"main.ts"),"run",{name:"check",input,output:{kind:"bool"},unfold:[]},new Map()),/supported|differ|argument/);
    }
    const file=path.join(f.dir,"main.ts");
    await writeFile(file,'declare const port:{read(x:boolean):Promise<void>}; export async function run(x:boolean):Promise<boolean>{const value=await port.read(x);return value===undefined;}');
    assert.throws(()=>withProgram([file],new Map(),compilerOptions,(program,checker)=>{
      const node=program.getSourceFile(file).statements.find(ts.isFunctionDeclaration);
      const root={kind:"function",node,env:new Map()};
      const session={roots:[root],context:()=>({program,checker,declarations:new Map(),snapshot:{id:"void-probe"}}),resolve:()=>({kind:"port",index:0}),identity:()=>"fn"};
      compileFunctionObject(session,{name:"uc",kind:"use-case",input:{kind:"bool"},output:{kind:"bool"},unfold:[]},[{name:"port",input:{kind:"bool"},output:{kind:"unit"},unfold:[]}]);
    }),/supported/);
  }finally{await f.cleanup();}
});
