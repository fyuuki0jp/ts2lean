import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LeanWorkspace } from "../dist/lean.js";
import { createProject } from "../dist/project.js";

test("Lean module names quote path components without renaming or injecting syntax", () => {
  const config = createProject(path.join(tmpdir(), "ts2lean-path-root"));
  const ws = new LeanWorkspace(config, path.join(config.root, "run"), "unused");
  assert.equal(ws.module("src/features/edit-routine/model/Access.lean"),
    "«src».«features».«edit-routine».«model».«Access»");
  assert.equal(ws.module("src/def/shared-law.lean"), "«src».«def».«shared-law»");
  assert.equal(ws.module("src/edit_routine/Access.lean"), "«src».«edit_routine».«Access»");
  for (const file of ["../Escape.lean", path.join(config.root + "-other", "Escape.lean"),
    "nested/../../Escape.lean", "Spec.ts", "a.b/Spec.lean", "a»/Spec.lean",
    "a\\b/Spec.lean", "bad\nimport/Spec.lean", "1bad/Spec.lean"]) {
    assert.throws(() => ws.module(file), {status:"spec-error"}, file);
  }
});

test("compilation rejects traversal and symlink escapes before starting Lean", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ts2lean-paths-"));
  const workspace = path.join(dir, "run");
  try {
    await mkdir(workspace);
    const outside = path.join(dir, "Outside.lean");
    await writeFile(outside, "def outside := true\n");
    await symlink(outside, path.join(workspace, "Escape.lean"));
    const ws = new LeanWorkspace(createProject(dir), workspace, "unused");
    ws.exec = () => { throw new Error("Lean must not run for escaped paths"); };
    for (const file of ["../Outside.lean", outside, "Escape.lean", "NotLean.txt"])
      await assert.rejects(ws.compile(file), {status:"spec-error"});
    await assert.rejects(ws.discover("../Outside.lean"), {status:"spec-error"});
  } finally { await rm(dir, {recursive:true,force:true}); }
});
