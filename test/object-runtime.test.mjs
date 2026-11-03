import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, symlink, lstat } from "node:fs/promises";
import { fixture, intSpec, root } from "./helpers.mjs";
import { run } from "../dist/lean.js";

test("function objects retain their snapshots and specialize their actual environments", async () => {
  const source = `import type {Offset} from './types.ts';
export function make(n:Offset){return (x:bigint):bigint=>x+n;}
export function named(n:Offset){function result(x:bigint):bigint{return x+n;}return result;}
export function pair(a:(x:bigint)=>bigint,b:(x:bigint)=>bigint){return (x:bigint):bigint=>a(x)+b(x);}
export function plus(x:bigint):bigint{return x+1n;}
export function minus(x:bigint):bigint{return x-1n;}
const replacement:Partial<{apply:(x:bigint)=>bigint}>={apply:(x:bigint):bigint=>x-1n};
const object={apply(x:bigint):bigint{return x+1n;},...replacement};
export const reassigned=object.apply;
export const service={apply(x:bigint):bigint{return x+1n;}};
export const ports={apply:plus};
export function use(x:bigint):bigint{return ports.apply(x);}
`;
  const spec = intSpec + `
namespace Spec
def two : Ts2Lean.Contract Int Int where
 pre := fun _ => True
 post := fun i o => o = i + 2
def pairContract : Ts2Lean.Contract Int Int where
 pre := fun _ => True
 post := fun i o => o = 2*i + 3
def decrement : Ts2Lean.Contract Int Int where
 pre := fun _ => True
 post := fun i o => o = i - 1
def eleven : Ts2Lean.Contract Int Int where
 pre := fun _ => True
 post := fun i o => o = i + 11
def mixed : Ts2Lean.Contract Int Int where
 pre := fun _ => True
 post := fun i o => o = 2*i + 12
end Spec
`;
  const f = await fixture(source, spec);
  try {
    try { await lstat(path.join(root, "node_modules/@fyuuki0jp/ts2lean")); }
    catch { await symlink(root, path.join(root, "node_modules/@fyuuki0jp/ts2lean"), "dir"); }
    await writeFile(path.join(f.dir, "types.ts"), "export type Offset=bigint;");
    await writeFile(path.join(f.dir, "vitest.config.ts"), `
import {defineConfig} from 'vitest/config';import {ts2lean} from '@fyuuki0jp/ts2lean/vite';
export default defineConfig({root:import.meta.dirname,plugins:[ts2lean()],test:{include:['objects.test.ts'],testTimeout:120000,fsModuleCachePath:import.meta.dirname+'/.cache'}});
`);
    await writeFile(path.join(f.dir, "objects.test.ts"), `
import {expect,test} from 'vitest';import '@fyuuki0jp/ts2lean/vitest';
import {make,named,pair,plus,minus,reassigned,service,ports,use} from './main.ts';
import {contract,two,pairContract,decrement,eleven,mixed} from './Spec.lean';
import {readFile,writeFile,unlink} from 'node:fs/promises';
test('unexported closures use their own captured values',async()=>{
 const one=make(1n),second=make(2n);
 await expect(one).toVerify(contract);
 await expect(second).toVerify(two);
 await expect(expect(second).toVerify(contract)).rejects.toMatchObject({result:{status:'unproved'}});
});
test('composed closures retain separate captured values',async()=>{
 await expect(pair(make(1n),make(2n))).toVerify(pairContract);
});
test('named local functions and methods retain their actual bodies',async()=>{
 await expect(named(1n)).toVerify(contract);
 await expect(service.apply).toVerify(contract);
});
test('replacing a dependency compiles the actual replacement',async()=>{
 await expect(reassigned).toVerify(decrement);
 await expect(expect(reassigned).toVerify(contract)).rejects.toMatchObject({result:{status:'unproved'}});
 ports.apply=minus;
 try{await expect(expect(use).toVerify(contract)).rejects.toMatchObject({result:{status:'unproved'}});await expect(use).toVerify(decrement);}
 finally{ports.apply=plus;}
});
test('deleting source and type files does not invalidate loaded objects',async()=>{
 const file=new URL('./main.ts',import.meta.url),types=new URL('./types.ts',import.meta.url);
 const code=await readFile(file,'utf8'),typeCode=await readFile(types,'utf8');
 const old=make(1n);
 try{await unlink(file);await unlink(types);await expect(old).toVerify(contract);}
 finally{await writeFile(file,code);await writeFile(types,typeCode);}
});
test('old and new versions of the same source coexist in one dependency graph',async()=>{
 const file=new URL('./main.ts',import.meta.url),code=await readFile(file,'utf8');
 const old=make(1n);
 try{
  await writeFile(file,code.replace('=>x+n;','=>x+n+10n;'));
  const fresh=await import('./main.ts'+'?version=two');
  const next=fresh.make(1n);
  expect(next(0n)).toBe(11n);
  await expect(old).toVerify(contract);
  await expect(next).toVerify(eleven);
  await expect(pair(old,next)).toVerify(mixed);
 }finally{await writeFile(file,code);}
});
`);
    const result = await run(process.execPath,
      [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", path.join(f.dir, "vitest.config.ts")],
      // The whole child suite contains 14 proofs; its budget must cover all tests.
      root, process.env, 900000);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /6 passed/);
  } finally { await f.cleanup(); }
});
