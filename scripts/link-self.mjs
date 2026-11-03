// Content Mapper resolution needs a node_modules entry for the scoped package.
import { lstat, mkdir, symlink } from "node:fs/promises";
const scope = new URL("../node_modules/@fyuuki0jp/", import.meta.url);
const target = new URL("ts2lean", scope);
await mkdir(scope, { recursive: true });
try { await lstat(target); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  await symlink("../..", target, "dir");
}
