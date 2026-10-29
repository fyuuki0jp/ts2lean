import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Failure, type ResolvedConfig } from "./types.js";
export async function loadConfig(
  file = "ts2lean.config.ts",
): Promise<ResolvedConfig> {
  const configFile = await realpath(path.resolve(file));
  const root = path.dirname(configFile);
  const config = (
    await import(`${pathToFileURL(configFile).href}?v=${randomUUID()}`)
  ).default;
  if (!config || !Array.isArray(config.bindings) || !config.bindings.length)
    throw new Failure("spec-error", "Config requires nonempty bindings.");
  const names = new Set<string>();
  for (const b of config.bindings) {
    if (
      !b ||
      !["module", "export", "spec", "contract"].every(
        (k) => typeof b[k] === "string" && b[k].length,
      )
    )
      throw new Failure("spec-error", "Invalid binding.");
    if (
      !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(b.contract) ||
      !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(b.export)
    )
      throw new Failure(
        "spec-error",
        "Contract and export paths must use simple identifiers.",
      );
    const key = `${path.resolve(root, b.module)}:${b.export}`;
    if (names.has(key))
      throw new Failure("spec-error", `Duplicate binding: ${key}`);
    names.add(key);
    await readFile(path.resolve(root, b.module));
    await readFile(path.resolve(root, b.spec));
  }
  for (const k of ["timeoutMs", "maxHeartbeats"])
    if (
      config[k] !== undefined &&
      (!Number.isSafeInteger(config[k]) || config[k] <= 0)
    )
      throw new Failure("spec-error", `${k} must be a positive integer.`);
  if (
    config.leanPaths !== undefined &&
    (!Array.isArray(config.leanPaths) ||
      !config.leanPaths.every((p: unknown) => typeof p === "string"))
  )
    throw new Failure("spec-error", "leanPaths must be an array of paths.");
  return {
    ...config,
    root,
    configFile,
    leanPaths: (config.leanPaths ?? []).map((p: string) =>
      path.resolve(root, p),
    ),
    timeoutMs: config.timeoutMs ?? 30000,
    maxHeartbeats: config.maxHeartbeats ?? 200000,
  };
}
