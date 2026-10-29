import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { readFile, writeFile, symlink, lstat, rm } from "node:fs/promises";
import { fixture, intSpec, root } from "./helpers.mjs";
import { Mapper } from "../dist/mapper.js";
import { run } from "../dist/lean.js";

async function packageLink() {
  const link = path.join(root, "node_modules/ts2lean");
  try {
    const info = await lstat(link);
    if (info.isSymbolicLink()) return;
    await rm(link, { recursive: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await symlink(root, link, "dir");
}

test("mapper uses unsaved Lean content, returns new types, and reports invalid specs", async () => {
  const f = await fixture(
    "export function run(x: bigint): bigint { return x + 1n; }",
    intSpec,
  );
  try {
    await rm(path.join(f.dir, "ts2lean.config.ts"));
    const m = new Mapper();
    assert.equal(
      (
        await m.handle("initialize", {
          protocolVersion: 1,
          positionEncodings: ["utf-16"],
        })
      ).positionEncoding,
      "utf-16",
    );
    const p = {
      configFileName: path.join(f.dir, "tsconfig.json"),
      projectHandle: "test",
    };
    const open = await m.handle("openProject", p);
    assert.ok(open.watchedFiles.includes(path.join(f.dir, "Spec.lean")));
    const params = {
      fileName: path.join(f.dir, "Spec.lean"),
      content: intSpec,
      projectHandle: "test",
    };
    const a = await m.handle("transform", params);
    assert.match(a.text, /output: bigint/);
    assert.equal(a.diagnostics, undefined);
    const changed = intSpec
      .replace("Contract Int Int", "Contract Int Bool")
      .replace("o = i + 1", "o = true");
    const b = await m.handle("transform", { ...params, content: changed });
    assert.match(b.text, /output: boolean/);
    const bad = await m.handle("transform", {
      ...params,
      content: changed + "\nbad syntax!",
    });
    assert.ok(bad.diagnostics.length);
    assert.equal(bad.text, "export {};");
    await writeFile(path.join(f.dir, "Spec.lean"), changed);
    assert.notEqual(
      (await m.handle("openProject", p)).configIdentity,
      open.configIdentity,
    );
    await m.handle("closeProject", { projectHandle: "test" });
    await assert.rejects(m.handle("transform", params), /Unknown project/);
  } finally {
    await f.cleanup();
  }
});

test("TypeScript 7.1 host typechecks Lean imports and erases them in emitted JavaScript", async () => {
  await packageLink();
  const source = `import type { contract } from './Spec.lean';
export function run(x: contract['input']): contract['output'] { return x + 1n; }`;
  const f = await fixture(source, intSpec);
  try {
    await rm(path.join(f.dir, "ts2lean.config.ts"));
    await writeFile(
      path.join(f.dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          verbatimModuleSyntax: true,
          outDir: ".js",
        },
        contentMappers: [{ package: "ts2lean", extensions: [".lean"] }],
        include: ["main.ts"],
      }),
    );
    const compiler = path.join(root, "node_modules/typescript/bin/tsc");
    const result = await run(
      process.execPath,
      [compiler, "-p", path.join(f.dir, "tsconfig.json"), "--runExternalCode"],
      root,
      process.env,
      60000,
    );
    assert.equal(result.code, 0, result.output);
    const js = await readFile(path.join(f.dir, ".js/main.js"), "utf8");
    assert.doesNotMatch(js, /\.lean|import/);
    assert.match(js, /return x \+ 1n/);
    await writeFile(
      path.join(f.dir, "Spec.lean"),
      intSpec
        .replace("Contract Int Int", "Contract Int Bool")
        .replace("o = i + 1", "o = true"),
    );
    const broken = await run(
      process.execPath,
      [
        compiler,
        "-p",
        path.join(f.dir, "tsconfig.json"),
        "--runExternalCode",
        "--noEmit",
      ],
      root,
      process.env,
      60000,
    );
    assert.notEqual(broken.code, 0);
    assert.match(broken.output, /bigint.*boolean/s);
  } finally {
    await f.cleanup();
  }
});

test("stdio server accepts fragmented frames and leaves stdout valid JSON-RPC", async () => {
  const child = spawn(process.execPath, ["dist/mapper.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: "日本語",
    method: "initialize",
    params: { positionEncodings: ["utf-16"] },
  });
  const frame = Buffer.from(
    `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`,
  );
  child.stdin.write(frame.subarray(0, 9));
  child.stdin.end(frame.subarray(9));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  const output = Buffer.concat(chunks),
    boundary = output.indexOf("\r\n\r\n");
  assert.ok(boundary > 0);
  const body = output.subarray(boundary + 4);
  assert.equal(
    Number(
      /Content-Length: (\d+)/.exec(output.subarray(0, boundary).toString())[1],
    ),
    body.length,
  );
  assert.equal(JSON.parse(body.toString()).id, "日本語");
});
