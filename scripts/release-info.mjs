import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseInfo({ ref, sha, run, attempt = "1", version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package.json must contain a stable x.y.z version");
  if (ref.startsWith("refs/tags/")) {
    if (ref !== `refs/tags/v${version}`) throw new Error("Release tag must match package.json version");
    return { version, tag: "latest" };
  }
  if (ref !== "refs/heads/main") throw new Error("Only main or a matching version tag may publish");
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt))
    throw new Error("Missing or invalid workflow identity");
  return { version: `${version}-dev.${run}.${attempt}.g${sha.slice(0, 12)}`, tag: "next" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const info = releaseInfo({ version, ref: process.env.GITHUB_REF ?? "", sha: process.env.GITHUB_SHA ?? "", run: process.env.GITHUB_RUN_NUMBER ?? "", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" });
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${info.version}\ntag=${info.tag}\n`);
  console.log(`Package version: ${info.version}; dist-tag: ${info.tag}`);
}
