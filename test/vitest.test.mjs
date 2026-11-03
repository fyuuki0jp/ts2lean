import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { fixture, intSpec, root } from "./helpers.mjs";
import { run } from "../dist/lean.js";

async function prepare(f) {
  await rm(path.join(f.dir, "ts2lean.config.ts"));
  try {
    await lstat(path.join(root, "node_modules/@fyuuki0jp/ts2lean"));
  } catch {
    await symlink(root, path.join(root, "node_modules/@fyuuki0jp/ts2lean"), "dir");
  }
  await writeFile(
    path.join(f.dir, "vitest.config.ts"),
    `
    import { defineConfig } from "vitest/config";
    import { ts2lean } from "@fyuuki0jp/ts2lean/vite";
    export default defineConfig({ root: import.meta.dirname, plugins: [ts2lean()], test: { include: ["binding.test.ts"], testTimeout: 60_000 } });
  `,
  );
}
async function vitest(f, timeout = 300000) {
  return run(
    process.execPath,
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      path.join(f.dir, "vitest.config.ts"),
    ],
    root,
    process.env,
    timeout,
  );
}

test("Vitest verifies supplied function instances and rejects invalid proof assertions without a bindings config", async () => {
  const f = await fixture(
    `
    import { increment } from "./helper";
    export function run(x: bigint): bigint { { const increment = 0n; } return increment(x); }
    export function wrong(x: bigint): bigint { return x - 1n; }
  `,
    intSpec,
  );
  try {
    await prepare(f);
    await writeFile(
      path.join(f.dir, "helper.ts"),
      "function plusOne(x: bigint): bigint { return x + 1n; } export function increment(x: bigint): bigint { return plusOne(x); }",
    );
    await writeFile(
      path.join(f.dir, "binding.test.ts"),
      `
      import { expect, test, vi } from "vitest";
      import "@fyuuki0jp/ts2lean/vitest";
      import { run as renamed, wrong } from "./main";
      import { contract as property } from "./Spec.lean";
      import * as helper from "./helper";
      import { readFile, writeFile, readdir, access } from "node:fs/promises";
      test("direct import with alias and helper verifies", async () => {
        await expect(renamed).toVerify(property);
      });
      test("different function is actually checked", async () => {
        await expect(expect(wrong).toVerify(property)).rejects.toMatchObject({ result: { status: "unproved" } });
      });
      test("wrappers are verified; unregistered mocks and bound functions need evidence", async () => {
        await expect(expect(vi.fn()).toVerify(property)).rejects.toThrow(/no source snapshot/);
        await expect((x: bigint) => renamed(x)).toVerify(property);
        await expect(expect(renamed.bind(null)).toVerify(property)).rejects.toThrow(/no source snapshot/);
      });
      test("negative assertion cannot turn unproved into a success", async () => {
        await expect(expect(wrong).not.toVerify(property)).rejects.toThrow(/does not support .not/);
      });
      test("runtime contract value is required", async () => {
        await expect(expect(renamed).toVerify({} as any)).rejects.toThrow(/Import the Lean contract/);
      });
      test("mocked dependency cannot borrow the real function proof", async () => {
        const spy = vi.spyOn(helper, "increment").mockImplementation(x => x - 1n);
        try {
          await expect(expect(renamed).toVerify(property)).rejects.toMatchObject({ result: { status: "unsupported" } });
        } finally { spy.mockRestore(); }
      });
      test("dependency replaced while Lean runs fails closed", async () => {
        let spy = undefined as ReturnType<typeof vi.spyOn> | undefined;
        const root=new URL("./.ts2lean/",import.meta.url),before=new Set(await readdir(root));let done=false;
        const monitor=(async()=>{while(!done){
          for(const dir of await readdir(root))if(!before.has(dir)&&await access(new URL(dir+"/Model.lean",root)).then(()=>true,()=>false)&&!done){spy=vi.spyOn(helper,"increment").mockImplementation(x=>x-1n);return;}
          await new Promise(resolve=>setTimeout(resolve,10));
        }})();
        try {
          await expect(expect(renamed).toVerify(property)).rejects.toMatchObject({ result: { status: "unsupported" } });
          expect(spy).toBeDefined();
        } finally { done=true; await monitor; spy?.mockRestore(); }
      });
      test("loaded dependency survives file edits", async () => {
        const file = new URL("./helper.ts", import.meta.url);
        const original = await readFile(file, "utf8");
        try {
          await writeFile(file, original.replace("x + 1n", "x + 2n"));
          await expect(renamed).toVerify(property);
        } finally { await writeFile(file, original); }
      });
      test("loaded target survives file edits", async () => {
        const file = new URL("./main.ts", import.meta.url);
        const original = await readFile(file, "utf8");
        try {
          await writeFile(file, original + "\\n// changed after import\\n");
          await expect(renamed).toVerify(property);
        } finally { await writeFile(file, original); }
      });
    `,
    );
    const result = await vitest(f);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /9 passed/);
  } finally {
    await f.cleanup();
  }
});

test("unproved contract fails the Vitest run and shows Lean diagnostics", async () => {
  const f = await fixture(
    "export function run(x: bigint): bigint { return x - 1n; }",
    intSpec,
  );
  try {
    await prepare(f);
    await writeFile(
      path.join(f.dir, "binding.test.ts"),
      `
      import { expect, test } from "vitest";
      import "@fyuuki0jp/ts2lean/vitest";
      import { run } from "./main";
      import { contract } from "./Spec.lean";
      test("incorrect implementation", async () => { await expect(run).toVerify(contract); });
    `,
    );
    const result = await vitest(f);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /ts2lean:unproved/);
    assert.match(result.output, /Proof\.lean/);
  } finally {
    await f.cleanup();
  }
});

test("Lean discovery exports all contracts and detects ambiguous export names", async () => {
  const { LeanWorkspace } = await import("../dist/lean.js");
  const { contractTypes } = await import("../dist/verify.js");
  const f = await fixture(
    "export function run(x: bigint): bigint { return x; }",
    intSpec.replace(
      "end Spec",
      "def second : Ts2Lean.Contract Int Bool where\n  pre := fun _ => True\n  post := fun _ b => b = true\nend Spec",
    ),
  );
  try {
    const ws = await LeanWorkspace.create(f.config);
    const infos = await ws.discover("Spec.lean");
    assert.deepEqual(
      infos.map((i) => i.name),
      ["Spec.contract", "Spec.second"],
    );
    const text = contractTypes(infos);
    assert.match(text, /export declare const contract/);
    assert.match(text, /export declare const second/);
    assert.throws(
      () => contractTypes([...infos, { ...infos[0], name: "Other.contract" }]),
      /Duplicate contract export/,
    );
  } finally {
    await f.cleanup();
  }
});

test("DI runtime uses closure snapshots and current port methods", async () => {
  const f = await fixture(
    `
import { make } from "./factory.ts";
import { ports } from "./ports.ts";
import * as deps from "./ports.ts";
export { ports };
export function namespaceRun(x:bigint):bigint{return deps.ports.nested.apply(x);}
const run=make(ports);
export {run};
`,
    intSpec,
  );
  try {
    await prepare(f);
    await writeFile(
      path.join(f.dir, "factory.ts"),
      `import * as ports from "./implementation.ts"; export interface Port {readonly nested:{readonly apply:(x:bigint)=>bigint}} export function make(ports:Port):(x:bigint)=>bigint{return (x:bigint):bigint=>ports.nested.apply(x);}`,
    );
    await writeFile(
      path.join(f.dir, "implementation.ts"),
      `export function add(x:bigint):bigint{return x+1n;}`,
    );
    await writeFile(
      path.join(f.dir, "ports.ts"),
      `import { add } from "./implementation.ts";import type {Port} from "./factory.ts";export const ports:Port={nested:{apply:add}};`,
    );
    await writeFile(
      path.join(f.dir, "binding.test.ts"),
      `
import {expect,test,vi} from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import {run,ports,namespaceRun} from "./main.ts";
import * as factory from "./factory.ts";
import {contract} from "./Spec.lean";
import {readFile,writeFile,readdir,access} from "node:fs/promises";
test("factory closure verifies",async()=>{await expect(run).toVerify(contract);});
test("mock port cannot borrow original proof",async()=>{
  const spy=vi.spyOn(ports.nested,"apply").mockImplementation(x=>x-1n);
  try{await expect(expect(run).toVerify(contract)).rejects.toMatchObject({result:{status:"unsupported"}});}finally{spy.mockRestore();}
});
test("getters are rejected without executing them",async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(ports.nested,"apply")!;let reads=0;
  Object.defineProperty(ports.nested,"apply",{configurable:true,get(){reads++;return descriptor.value;}});
  try{await expect(expect(run).toVerify(contract)).rejects.toThrow(/accessor/);expect(reads).toBe(0);}finally{Object.defineProperty(ports.nested,"apply",descriptor);}
});
test("namespace port traversal rejects getters without evaluating them",async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(ports.nested,"apply")!;let reads=0;
  Object.defineProperty(ports.nested,"apply",{configurable:true,get(){reads++;return descriptor.value;}});
  try{await expect(expect(namespaceRun).toVerify(contract)).rejects.toThrow(/accessor/);expect(reads).toBe(0);}finally{Object.defineProperty(ports.nested,"apply",descriptor);}
});
test("nested Proxy cannot report a different dependency to the verifier",async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(ports,"nested")!;
  Object.defineProperty(ports,"nested",{configurable:true,value:new Proxy(descriptor.value,{get(target,key){return key==="apply"?(x:bigint)=>x-1n:Reflect.get(target,key);}})});
  try{expect(run(0n)).toBe(-1n);await expect(expect(run).toVerify(contract)).rejects.toThrow(/Proxy/);}finally{Object.defineProperty(ports,"nested",descriptor);}
});
test("an existing closure is independent of the current factory reference",async()=>{
  const spy=vi.spyOn(factory,"make");
  try{await expect(run).toVerify(contract);}finally{spy.mockRestore();}
});
test("port replacement during proof is checked again",async()=>{
  let spy;
  const root=new URL("./.ts2lean/",import.meta.url),before=new Set(await readdir(root));let done=false;
  const monitor=(async()=>{while(!done){
    for(const dir of await readdir(root))if(!before.has(dir)&&await access(new URL(dir+"/Model.lean",root)).then(()=>true,()=>false)&&!done){spy=vi.spyOn(ports.nested,"apply").mockImplementation(x=>x-1n);return;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }})();
  try{await expect(expect(run).toVerify(contract)).rejects.toMatchObject({result:{status:"unsupported"}});expect(spy).toBeDefined();}finally{done=true;await monitor;spy?.mockRestore();}
});
test("an existing closure retains its factory source snapshot",async()=>{
  const file=new URL("./factory.ts",import.meta.url),original=await readFile(file,"utf8");
  try{await writeFile(file,original+"\\n// changed factory source\\n");await expect(run).toVerify(contract);}finally{await writeFile(file,original);}
});
`,
    );
    const result = await vitest(f);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /8 passed/);
  } finally {
    await f.cleanup();
  }
});

test("scalar DI checks live configuration and captured snapshots", async () => {
  const f = await fixture(
    `
type Config={readonly offset:bigint;readonly enabled:boolean};
function live(c:Config){return (x:bigint):bigint=>c.enabled?x+c.offset:x;}
function snapshot({offset}:Config){return (x:bigint):bigint=>x+offset;}
export const config:Config={offset:1n,enabled:true};
export const run=live(config);
export const snap=snapshot(config);
export const wrong=live({offset:2n,enabled:true});
`,
    intSpec,
  );
  try {
    await prepare(f);
    await writeFile(
      path.join(f.dir, "binding.test.ts"),
      `
import {expect,test} from 'vitest';import '@fyuuki0jp/ts2lean/vitest';
import {run,snap,wrong,config} from './main.ts';import {contract} from './Spec.lean';
test('config specialization',async()=>{await expect(run).toVerify(contract);await expect(expect(wrong).toVerify(contract)).rejects.toMatchObject({result:{status:'unproved'}});});
test('live value changes fail but snapshots retain their captured value',async()=>{
 const d=Object.getOwnPropertyDescriptor(config,'offset')!;Object.defineProperty(config,'offset',{...d,value:2n});
 try{await expect(expect(run).toVerify(contract)).rejects.toMatchObject({result:{status:'unproved'}});await expect(snap).toVerify(contract);}finally{Object.defineProperty(config,'offset',d);}
});
test('configuration getter is not executed',async()=>{
 const d=Object.getOwnPropertyDescriptor(config,'offset')!;let reads=0;Object.defineProperty(config,'offset',{configurable:true,get(){reads++;return 1n;}});
 try{await expect(expect(run).toVerify(contract)).rejects.toThrow(/accessor/);expect(reads).toBe(0);}finally{Object.defineProperty(config,'offset',d);}
});
`,
    );
    const result = await vitest(f);
    assert.equal(result.code, 0, result.output);
  } finally {
    await f.cleanup();
  }
});

test("effect DI rejects different live handles and changes made by settings evidence", async () => {
  const f = await fixture(
    `import {adapter,mutatedAdapter} from './adapter.ts';
export function make(port:{readonly db:typeof adapter}){return async()=>{await port.db.transaction(async tx=>{});};}
export const ports={db:adapter};export const run=make(ports);
export const helperPorts={work:async(n:bigint)=>{await adapter.transaction(async tx=>{});}};
export async function helperRun(){await helperPorts.work(1n);}
export async function stringHelper(id:string){await adapter.transaction(async tx=>{});}
export async function noArgumentHelper(){await adapter.transaction(async tx=>{});}
export const mutatedRun=make({db:mutatedAdapter});`,
    intSpec,
  );
  try {
    await prepare(f);
    for (const file of ["Database.lean", "Payment.lean"])
      await writeFile(
        path.join(f.dir, file),
        await readFile(path.join(root, "examples/payments", file), "utf8"),
      );
    await writeFile(
      path.join(f.dir, "vitest.config.ts"),
      `import {defineConfig} from 'vitest/config';import {ts2lean} from '@fyuuki0jp/ts2lean/vite';export default defineConfig({root:import.meta.dirname,plugins:[ts2lean()],test:{include:['binding.test.ts'],testTimeout:90000}});`,
    );
    await writeFile(
      path.join(f.dir, "adapter.ts"),
      `import type {SerializableDatabase} from './Database.lean';
interface Adapter extends SerializableDatabase {settings():Record<string,string|number>}
export const control={calls:0,at:0,hook:()=>{}};
export const adapter:Adapter={transaction:async()=>{throw new Error('not executed');},listPending:async()=>[],getBalance:async()=>0n,
settings(){control.calls++;if(control.calls===control.at)control.hook();return {journalMode:'wal',synchronous:2,readUncommitted:0,transactionMode:'IMMEDIATE'};}};
export const mutatedAdapter:Adapter={...adapter};
mutatedAdapter.transaction=async()=>{throw new Error('replacement');};`,
    );
    await writeFile(
      path.join(f.dir, "binding.test.ts"),
      `import {expect,test,vi} from 'vitest';import {verifySystem} from '@fyuuki0jp/ts2lean/runtime';
import {run,ports,make,helperPorts,helperRun,stringHelper,noArgumentHelper,mutatedRun} from './main.ts';import {control} from './adapter.ts';import {ledgerInvariant} from './Payment.lean';
import {readFile,writeFile,unlink} from 'node:fs/promises';
test('module initialization cannot replace methods after law registration',async()=>{
 await expect(verifySystem({mutatedRun},ledgerInvariant)).rejects.toThrow(/method replaced/);
});
test('an unexported operation uses its loaded source, module law and contract snapshots',async()=>{
 const instance=make(ports);
 const files=['main.ts','adapter.ts','Database.lean','Payment.lean'].map(name=>new URL('./'+name,import.meta.url));
 const sources=await Promise.all(files.map(file=>readFile(file,'utf8')));
 try{for(const file of files)await unlink(file);await verifySystem({instance},ledgerInvariant);}
 finally{await Promise.all(files.map((file,i)=>writeFile(file,sources[i])));}
});
test('replacement helpers must match actual parameter types and arity',async()=>{
 const original=helperPorts.work;
 try{
  Reflect.set(helperPorts,'work',stringHelper);
  await expect(verifySystem({helperRun},ledgerInvariant)).rejects.toThrow(/Actual helper parameter type/);
  Reflect.set(helperPorts,'work',noArgumentHelper);
  await expect(verifySystem({helperRun},ledgerInvariant)).rejects.toThrow(/Actual helper parameter count/);
 }finally{helperPorts.work=original;}
});
test('settings cannot replace an already-checked handle on the final pass',async()=>{
 const original=ports.db;control.calls=0;control.at=3;control.hook=()=>{ports.db={...original};};
 try{await expect(verifySystem({run},ledgerInvariant)).rejects.toThrow(/Verification environment changed/);expect(control.calls).toBe(3);}finally{ports.db=original;control.at=0;control.hook=()=>{};}
});
test('settings cannot substitute another registered instance between checks',async()=>{
 vi.resetModules();const other=await import('./adapter.ts');
 const original=ports.db;control.calls=0;control.at=3;control.hook=()=>{ports.db=other.adapter;};
 try{await expect(verifySystem({run},ledgerInvariant)).rejects.toThrow(/Verification environment changed|one shared database handle/);expect(control.calls).toBe(3);}finally{ports.db=original;control.at=0;control.hook=()=>{};}
});
test('settings accessors are never invoked',async()=>{
 const d=Object.getOwnPropertyDescriptor(ports.db,'settings')!;let reads=0;
 Object.defineProperty(ports.db,'settings',{configurable:true,get(){reads++;return d.value;}});
 try{await expect(verifySystem({run},ledgerInvariant)).rejects.toThrow(/accessor/);expect(reads).toBe(0);}finally{Object.defineProperty(ports.db,'settings',d);}
});
test('settings function proxies are rejected without invoking traps',async()=>{
 const d=Object.getOwnPropertyDescriptor(ports.db,'settings')!;let calls=0;
 Object.defineProperty(ports.db,'settings',{...d,value:new Proxy(d.value,{apply(target,self,args){calls++;return Reflect.apply(target,self,args);}})});
 try{await expect(verifySystem({run},ledgerInvariant)).rejects.toThrow(/Proxy/);expect(calls).toBe(0);}finally{Object.defineProperty(ports.db,'settings',d);}
});
test('same source snapshot cannot collapse separately loaded handles',async()=>{
 vi.resetModules();const other=await import('./main.ts');
 await expect(verifySystem({first:run,second:other.run},ledgerInvariant)).rejects.toThrow(/Verification environment changed|one shared database handle/);
});`,
    );
    // Eight independently bounded tests can collectively exceed five minutes on CI.
    const result = await vitest(f, 900000);
    assert.equal(result.code, 0, result.output);
  } finally {
    await f.cleanup();
  }
});
