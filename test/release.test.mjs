import test from "node:test";
import assert from "node:assert/strict";
import { releaseInfo } from "../scripts/release-info.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const input = { version: "0.1.0", ref: "refs/heads/main", sha: "a".repeat(40), run: "42", attempt: "1" };
test("CD uses distinct development versions and matching stable tags", () => {
  assert.deepEqual(releaseInfo(input), {version:"0.1.0-dev.42.1.gaaaaaaaaaaaa",tag:"next"});
  assert.notEqual(releaseInfo(input).version, releaseInfo({...input,attempt:"2"}).version);
  assert.deepEqual(releaseInfo({...input,ref:"refs/tags/v0.1.0"}),{version:"0.1.0",tag:"latest"});
  for (const change of [{ref:"refs/heads/feature"},{ref:"refs/tags/v0.2.0"},{ref:"refs/tags/v0.1.0-rc.1"},{sha:"oops"},{run:""},{version:"0.1.0-dev.1"}])
    assert.throws(()=>releaseInfo({...input,...change}));
});

test("CD writes separate GitHub Actions output records", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ts2lean-release-"));
  const output = path.join(dir, "output");
  try {
    execFileSync(process.execPath, ["scripts/release-info.mjs"], {
      env: {...process.env, GITHUB_REF:input.ref, GITHUB_SHA:input.sha,
        GITHUB_RUN_NUMBER:input.run, GITHUB_RUN_ATTEMPT:input.attempt, GITHUB_OUTPUT:output},
    });
    assert.equal(readFileSync(output, "utf8"), "version=0.1.0-dev.42.1.gaaaaaaaaaaaa\ntag=next\n");
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
