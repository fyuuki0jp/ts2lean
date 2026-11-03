import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
