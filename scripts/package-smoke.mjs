import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

const root = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), "ts2lean-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (exe, args, cwd) =>
  execFileSync(exe, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
  });
try {
  const packResult = JSON.parse(
    run(
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
      root,
    ),
  );
  const packed = Array.isArray(packResult) ? packResult[0] : packResult["@fyuuki0jp/ts2lean"];
  assert.equal(packed.name, "@fyuuki0jp/ts2lean");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    npm,
    [
      "install",
      "--no-save",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(dir, packed.filename),
    ],
    dir,
  );
  const manifest = JSON.parse(
    await readFile(path.join(dir, "node_modules/@fyuuki0jp/ts2lean/package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies), ["typescript"]);
  const plugin = await readFile(
    path.join(dir, "node_modules/@fyuuki0jp/ts2lean/dist/vite.js"),
    "utf8",
  );
  assert.doesNotMatch(
    plugin,
    /(?:from|import)\s*["'](?:magic-string|@jridgewell\/sourcemap-codec|@ts-morph\/common)/,
  );
  const notices = await readFile(
    path.join(dir, "node_modules/@fyuuki0jp/ts2lean/dist/THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  assert.match(notices, /magic-string/);
  assert.match(notices, /@jridgewell\/sourcemap-codec/);
  assert.match(
    run(process.execPath, ["node_modules/@fyuuki0jp/ts2lean/dist/cli.js", "--help"], dir),
    /Usage: ts2lean/,
  );
  await writeFile(
    path.join(dir, "probe.mjs"),
    `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ts2lean } from "@fyuuki0jp/ts2lean/vite";
import { compileTypeScript } from "./node_modules/@fyuuki0jp/ts2lean/dist/compiler.js";
const require = createRequire(import.meta.url);
for (const name of ["magic-string", "@jridgewell/sourcemap-codec", "@ts-morph/common", "rolldown"])
  assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
const file = fileURLToPath(new URL("./main.ts", import.meta.url));
const source = "export const make = (increment: bigint) => (x: bigint): bigint => x + increment; export const run = make(1n);";
await writeFile(file, source);
const ir = compileTypeScript(file, "run", { input: { kind: "int" }, output: { kind: "int" } }, new Map());
assert.equal(ir.functions.length, 1);
const result = await ts2lean().transform.call({addWatchFile() {}}, source, file);
assert.match(result.code, /registerClosure/);
assert.ok(result.map.mappings.length);
console.log("production install: native compiler, CLI, and bundled Vite transform passed");
`,
  );
  process.stdout.write(run(process.execPath, ["probe.mjs"], dir));

  // A separate application must work with the scoped package as a devDependency,
  // including generated runtime imports and the native Content Mapper host.
  // Use a clean dependency tree for this second installation mode.
  await rm(path.join(dir, "node_modules"), { recursive: true, force: true });
  await rm(path.join(dir, "package-lock.json"), { force: true });
  run(npm, ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund",
    path.join(dir, packed.filename), "vite@8.3.5", "vitest@5.0.5", "@types/node@24.10.0"], dir);
  const accessDir = path.join(dir, "src/features/edit-routine/model");
  const sessionDir = path.join(dir, "src/features/arrange-project-canvas/model");
  await mkdir(accessDir, {recursive:true});
  await mkdir(sessionDir, {recursive:true});
  await writeFile(path.join(sessionDir, "Shared-law.lean"), `import Ts2Lean.Contract
namespace SharedLaw
def next (x : Int) : Int := x + 1
end SharedLaw
`);
  await writeFile(path.join(accessDir, "Access.lean"), `import src.features.«arrange-project-canvas».model.«Shared-law»
namespace Access
def increment : Ts2Lean.Contract Int Int where
  pre := fun _ => True
  post := fun x y => y = SharedLaw.next x
end Access
`);
  await writeFile(path.join(sessionDir, "Session.lean"), `import src.features.«edit-routine».model.Access
namespace Session
def advance : Ts2Lean.Contract Int Int where
  pre := fun _ => True
  post := fun x y => y = SharedLaw.next x
end Session
`);
  await writeFile(path.join(dir, "consumer.test.ts"), `import {expect,test} from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import {run} from "./main";
import {increment} from "./src/features/edit-routine/model/Access.lean";
import {advance} from "./src/features/arrange-project-canvas/model/Session.lean";
test("installed package verifies the actual function through kebab-case module imports", async()=>{
  await expect(run).toVerify(increment);
  await expect(run).toVerify(advance);
});
`);
  await writeFile(path.join(dir, "vitest.config.ts"), `import {defineConfig} from "vitest/config";
import {ts2lean} from "@fyuuki0jp/ts2lean/vite";
export default defineConfig({plugins:[ts2lean()],test:{testTimeout:90000}});
`);
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {strict:true,target:"ES2022",module:"ESNext",moduleResolution:"bundler",noEmit:true,types:["node"],skipLibCheck:true},
    contentMappers:[{package:"@fyuuki0jp/ts2lean",extensions:[".lean"]}], include:["*.ts", "result-example/*.ts", "machine-example/*.ts", "ports-example/*.ts"],
  }));
  const resultDir = path.join(dir, "result-example");
  await mkdir(resultDir);
  for (const file of ["Result.lean", "main.ts", "result.ts", "result.test.ts"]) {
    await writeFile(path.join(resultDir, file), await readFile(path.join(root, "examples/result", file)));
  }
  const machineDir=path.join(dir,"machine-example"),portsDir=path.join(dir,"ports-example");
  await mkdir(machineDir); await mkdir(portsDir);
  for(const file of ["Machine.lean","reducer.ts","reducer.test.ts"])
    await writeFile(path.join(machineDir,file),await readFile(path.join(root,"examples/state-machine",file)));
  for(const file of ["Save.lean","service.ts"])
    await writeFile(path.join(portsDir,file),await readFile(path.join(root,"examples/ports",file)));
  await writeFile(path.join(portsDir,"ports.test.ts"),`import {test,expect} from "vitest";
import {bindPort,verifyUseCases} from "@fyuuki0jp/ts2lean";
import {authorization,storage,save} from "./Save.lean";
import {createService,type Ports} from "./service";
const adapter:Ports={async authorize(i){return i.allowed?{ok:true,value:0n}:{ok:false,error:{kind:"denied"}};},async commit(i){return {ok:true,value:i.amount};}};
test("installed package verifies general ports and emits adapter evidence",async()=>{
 const result=await verifyUseCases([{fn:createService(adapter).saveViaHelper,contract:save}],{ports:[bindPort(adapter,"authorize",authorization),bindPort(adapter,"commit",storage)]});
 expect(result.status).toBe("verified");
 expect(result.assumptions!.every(p=>p.adapter?.source?.sha256)).toBe(true);
});
`);
  const localElan = path.join(root, ".tools/elan");
  const env = {...process.env};
  if (!env.TS2LEAN_LEAN && existsSync(path.join(localElan,"bin/lean"))) {
    env.TS2LEAN_LEAN = path.join(localElan,"bin/lean");
    env.ELAN_HOME = localElan;
  }
  for (const args of [
    ["node_modules/typescript/bin/tsc", "--runExternalCode", "-p", "tsconfig.json"],
    ["node_modules/vitest/vitest.mjs", "run"],
  ]) process.stdout.write(execFileSync(process.execPath,args,{cwd:dir,env,encoding:"utf8",timeout:300000}));
  console.log("scoped devDependency: external Content Mapper and Vitest proof passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
