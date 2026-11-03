import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { processBindings } from "../dist/verify.js";
import { compileTypeScript } from "../dist/compiler.js";
import { LeanWorkspace } from "../dist/lean.js";
import { emitModel } from "../dist/emit.js";
import { tsType } from "../dist/types.js";
import { encodeInput, leanObservation, canonical } from "../scripts/observations.mjs";

const spec = (await readFile("examples/result/Result.lean", "utf8")).replaceAll("ResultExample", "Spec").replace("def run :", "def contract :");
const source = (await readFile("examples/result/main.ts", "utf8")).replace('"./result"', '"./result.ts"');
const helpers = await readFile("examples/result/result.ts", "utf8");
async function setup(code = source, lean = spec) {
  const f = await fixture(code, lean);
  await writeFile(path.join(f.dir, "result.ts"), helpers + '\nexport function unused(x: bigint): Generator<bigint>;\nexport function* unused(x: bigint) { yield x; }\n');
  return f;
}

test("boolean Result ROP verifies, preserves payloads, and matches native execution", async () => {
  const f = await setup();
  try {
    const [result] = await processBindings(f.config, "verify");
    assert.equal(result.status, "verified", result.message);
    const ws = await LeanWorkspace.create(f.config);
    const info = await ws.inspect("Spec.lean", "Spec.contract");
    assert.match(tsType(info.output), /readonly "ok": true/);
    assert.match(tsType(info.output), /readonly "ok": false/);
    assert.match(tsType(info.output), /readonly "kind": "negative"/);
    const ir = compileTypeScript(path.join(f.dir, "main.ts"), "run", info, new Map());
    await writeFile(path.join(ws.dir, "Model.lean"), emitModel(ir, "Spec"));
    const built = await ws.exec(["-o", "Model.olean", "Model.lean"]);
    assert.equal(built.code, 0, built.output);
    const inputs = ["-9999999999999999999999999999999", "-1", "0", "1", "10", "11", "9999999999999999999999999999999"];
    await writeFile(path.join(ws.dir, "Eval.lean"), "import Model\n" + inputs.map(i =>
      `#eval IO.println (${leanObservation(info.output, `Ts2LeanGenerated.${ir.target} ${encodeInput(info.input, i)}`)}).compress`).join("\n"));
    const evaluated = await ws.exec(["Eval.lean"]);
    assert.equal(evaluated.code, 0, evaluated.output);
    const { run } = await import(pathToFileURL(path.join(f.dir, "main.ts")).href);
    const native = JSON.parse(JSON.stringify(inputs.map(i => run(BigInt(i))), (_, v) => typeof v === "bigint" ? String(v) : v));
    assert.equal(canonical(native), canonical(evaluated.output.trim().split("\n").map(JSON.parse)));
  } finally { await f.cleanup(); }
});

test("ROP rejects changed success values, swallowed first failures, and wrong conditions", async () => {
  const f = await setup();
  try {
    for (const mutation of [
      source.replace("input + 1n", "input - 1n"),
      source.replace("if (!step.ok) return step;", 'if (!step.ok) return err<Problem>({kind:"tooLarge",amount:input});'),
      source.replace("input < 0n", "input > 0n"),
      source.replace("if (!step.ok) return step;", ""),
    ]) {
      await writeFile(path.join(f.dir, "main.ts"), mutation);
      const [bad] = await processBindings(f.config, "verify");
      assert.equal(bad.status, "unproved", bad.message);
    }
  } finally { await f.cleanup(); }
});

test("generic wrappers specialize at multiple types; generic roots and recursion fail closed", async () => {
  const f = await setup(source.replace("export function validate", "function wrap<T>(value:T):Result<T,never>{return ok(value);}\nexport function validate").replaceAll("ok<", "wrap<"));
  try {
    const [good] = await processBindings(f.config, "verify");
    assert.equal(good.status, "verified", good.message);
    const ws = await LeanWorkspace.create(f.config), info = await ws.inspect("Spec.lean", "Spec.contract");
    for (const invalid of [
      'export function run<T>(input:T):T{return input;}',
      source.replace('export function run', 'function again<T>(x:T):T{return again(x);}\nexport function run').replace("input + 1n", "again(input) + 1n"),
      source.replace('return ok<boolean>(true)', 'return ok<Problem>({kind:"negative",amount:input})'),
    ]) {
      await writeFile(path.join(f.dir, "main.ts"), invalid);
      assert.throws(() => compileTypeScript(path.join(f.dir, "main.ts"), "run", info, new Map()));
    }
  } finally { await f.cleanup(); }
});

test("boolean union metadata rejects duplicate constructors and discriminant payload collisions", async () => {
  for (const invalid of [
    spec.replace('Validation.ok Validation.err', 'Validation.ok Validation.ok'),
    spec.replace('| ok (value : Bool)', '| ok (ok : Bool)'),
  ]) {
    const f = await setup(source, invalid);
    try {
      const [bad] = await processBindings(f.config, "verify");
      assert.equal(bad.status, "spec-error", bad.message);
    } finally { await f.cleanup(); }
  }
});

test("generic explicit arguments are type arguments, not positional value parameters", async () => {
  const source = `const unwrap=<T>(x:{readonly value:T}):T=>x.value;
const second=<A,B>(b:B,a:A):B=>b;
export function run(x:boolean):boolean{return unwrap<boolean>({value:second<bigint,boolean>(x,1n)});}`;
  const f = await fixture(source, "-- unused by static lowering");
  const info = {name:"identity",input:{kind:"bool"},output:{kind:"bool"},unfold:[]};
  try {
    const ir = compileTypeScript(path.join(f.dir,"main.ts"), "run", info, new Map());
    assert.equal(ir.functions.length, 3);
    assert.equal(ir.functions.find(fn => fn.name === ir.target).output.kind, "bool");
    await writeFile(path.join(f.dir,"main.ts"), source.replace('unwrap<boolean>', 'unwrap'));
    assert.throws(() => compileTypeScript(path.join(f.dir,"main.ts"), "run", info, new Map()), /explicit type arguments/);
  } finally { await f.cleanup(); }
});

test("Vite capture registration distinguishes property names from variable reads", async () => {
  const { ts2lean } = await import("../dist/vite.js");
  const { transformWithOxc } = await import("vite");
  const file = path.resolve("examples/result/result.ts");
  const code = await readFile(file, "utf8");
  const transformed = await ts2lean().transform.call({addWatchFile() {}}, code, file);
  assert.doesNotMatch(transformed.code, /return return;/);
  const emitted = await transformWithOxc(transformed.code, file);
  assert.match(emitted.code, /function\* take/);
  assert.match(emitted.code, /steps.return\(undefined\)/);
});
