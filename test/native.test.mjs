import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { compileTypeScript, importedLeanFiles } from "../dist/compiler.js";
import { compileEffects } from "../dist/effects/compiler.js";
import { withSourceFile, withAPI, captureSourceSnapshot, openSnapshotProgram } from "../dist/native.js";

const contract = { input: { kind: "int" }, output: { kind: "int" } };

test("native sessions resolve virtual Lean and ordinary imports, reject errors, and release processes", async () => {
  await mkdir(".ts2lean", { recursive: true });
  const dir = await mkdtemp(path.resolve(".ts2lean/native-"));
  const file = path.join(dir, "main.ts");
  const virtual = new Map([
    [path.join(dir, "Spec.lean.ts"), "export type Amount = bigint;"],
  ]);
  const children = [];
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    if (args[1]?.includes("--api")) children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  try {
    await writeFile(
      path.join(dir, "helper.ts"),
      'import type { Amount } from "./Spec.lean"; export function inc(x: Amount): Amount { return x + 1n; }',
    );
    await writeFile(
      path.join(dir, "barrel.ts"),
      'export { inc } from "./helper.js";',
    );
    for (let i = 0; i < 3; i++) {
      await writeFile(
        file,
        'import { inc } from "./barrel.js"; export function run(x: bigint): bigint { return inc(x); }',
      );
      assert.deepEqual(importedLeanFiles(file), [path.join(dir, "Spec.lean")]);
      assert.equal(
        compileTypeScript(file, "run", contract, virtual).functions.length,
        2,
      );
      for (const source of [
        "export function run( {",
        'import type { Amount } from "./Spec.lean"; export function run(x: Amount): Amount { return "wrong"; }',
        'import { absent } from "./missing.js"; export function run(x: bigint): bigint { return absent(x); }',
      ]) {
        await writeFile(file, source);
        assert.throws(
          () => compileTypeScript(file, "run", contract, virtual),
          (error) =>
            error.status === "type-error" && error.message.includes("main.ts"),
        );
        assert.throws(
          () => compileEffects([{ file, name: "run" }], new Map()),
          (error) => error.status === "type-error",
        );
      }
      await writeFile(
        file,
        "export function run(x: bigint): bigint { while (true) {} return x; }",
      );
      assert.throws(
        () => compileTypeScript(file, "run", contract, virtual),
        (error) => error.status === "unsupported",
      );
      assert.throws(
        () =>
          withSourceFile(file, "const x = 1n", () => {
            throw new Error("parse consumer failed");
          }),
        /parse consumer failed/,
      );
      const snapshot = captureSourceSnapshot(file, "export const value: bigint = 1n;", {});
      withAPI((api) => {
        const context = openSnapshotProgram(api, snapshot, new Map());
        try { assert.match(context.program.getSourceFile(file).text, /value: bigint = 1n/); }
        finally { context.dispose(); }
      });
      const invalid = captureSourceSnapshot(file, "export const value: bigint = 'wrong';", {});
      assert.throws(() => withAPI((api) => openSnapshotProgram(api, invalid, new Map())),
        (error) => error.status === "type-error");
    }
    const matcherFile = path.resolve("test/api-types.ts");
    const matcherSnapshot = captureSourceSnapshot(matcherFile, await readFile(matcherFile, "utf8"), {});
    withAPI((api) => {
      // Includes positive matcher calls and @ts-expect-error contract boundaries.
      const context = openSnapshotProgram(api, matcherSnapshot, new Map());
      context.dispose();
    });
    assert.ok(
      children.length >= 30,
      "exercise native process ownership on every path",
    );
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null)
          await once(child, "exit", { signal: AbortSignal.timeout(5000) });
      }),
    );
  } finally {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("project paths and inherited options are captured once and remain closed after config edits", async () => {
  const dir = await mkdtemp(path.resolve(".ts2lean/aliases-"));
  const file = path.join(dir, "main.ts");
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "base.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
      paths: { "@/*": ["./src/*"] }, types: [],
    } }));
    const config = { extends: "./base.json", include: ["main.ts", "src/*.ts"],
      contentMappers: [{package: "@fyuuki0jp/ts2lean", extensions: [".lean"]}] };
    await writeFile(path.join(dir, "tsconfig.proof.json"), JSON.stringify(config));
    await writeFile(path.join(dir, "src/helper.ts"), "export function inc(x: bigint): bigint { return x + 1n; }");
    const code = 'import { inc } from "@/helper"; export function run(x: bigint): bigint { return inc(x); }';
    await writeFile(file, code);
    const project = { root: dir, tsconfig: "tsconfig.proof.json" };
    const ir = compileTypeScript(file, "run", contract, new Map(), project);
    assert.equal(ir.functions.length, 2);
    const captured = captureSourceSnapshot(file, code, {}, project);
    assert.ok(captured.resolutions.some(r => r.name === "@/helper" && r.file === path.join(dir, "src/helper.ts")));
    assert.equal(captured.tsconfig, path.join(dir, "tsconfig.proof.json"));
    await writeFile(path.join(dir, "base.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [],
      paths: { "@/*": ["./absent/*"] },
    } }));
    await writeFile(path.join(dir, "src/helper.ts"), "this is not TypeScript");
    withAPI(api => {
      const context = openSnapshotProgram(api, captured, new Map());
      try { assert.match(context.program.getSourceFile(path.join(dir, "src/helper.ts")).text, /x \+ 1n/); }
      finally { context.dispose(); }
    });
    const changed = captureSourceSnapshot(file, code, {}, project);
    assert.notEqual(changed.id, captured.id);
    assert.throws(() => withAPI(api => openSnapshotProgram(api, changed, new Map())), /Cannot find module/);
    assert.throws(() => captureSourceSnapshot(file, code, {}, {root: dir, tsconfig: "missing.json"}), /Cannot read/);
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(config));
    await writeFile(path.join(dir, "base.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [], paths: {"@/*": ["./src/*"]},
    } }));
    await writeFile(path.join(dir, "src/helper.ts"), 'import type {Amount} from "./Spec.lean"; export function inc(x:Amount):Amount{return x+1n;}');
    assert.deepEqual(importedLeanFiles(file, {root:dir}), [path.join(dir,"src/Spec.lean")]);
    assert.equal(compileTypeScript(file,"run",contract,new Map([[path.join(dir,"src/Spec.lean.ts"),"export type Amount=bigint;"]]),{root:dir}).functions.length,2);
  } finally { await rm(dir, {recursive:true, force:true}); }
});


test("closed snapshots retain ambient types after their package symlink disappears",async()=>{
  const dir=await mkdtemp(path.resolve(".ts2lean/ambient-"));
  try {
    await mkdir(path.join(dir,"store/proofenv"),{recursive:true});
    await mkdir(path.join(dir,"node_modules/@types"),{recursive:true});
    const ambient=path.join(dir,"store/proofenv");
    await writeFile(path.join(ambient,"index.d.ts"),"declare namespace ProofEnv { type Amount = bigint; }");
    await writeFile(path.join(ambient,"package.json"),JSON.stringify({name:"@types/proofenv",version:"1.0.0",types:"index.d.ts"}));
    const link=path.join(dir,"node_modules/@types/proofenv");
    await symlink(ambient,link,"dir");
    await writeFile(path.join(dir,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",types:["proofenv"]}}));
    const file=path.join(dir,"main.ts"),code="export function run(x: ProofEnv.Amount): bigint { return x + 1n; }";
    await writeFile(file,code);
    const captured=captureSourceSnapshot(file,code,{},{root:dir});
    assert.ok(captured.roots.some(f=>f.endsWith("proofenv/index.d.ts")));
    await rm(link);
    await rm(ambient,{recursive:true});
    withAPI(api=>{
      const context=openSnapshotProgram(api,captured,new Map());
      try { assert.ok(context.program.getSourceFileNames().some(f=>f.endsWith("proofenv/index.d.ts"))); }
      finally {context.dispose();}
    });
  } finally {await rm(dir,{recursive:true,force:true});}
});
