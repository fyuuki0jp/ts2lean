import path from "node:path";
import { readdir } from "node:fs/promises";
import {
  Failure,
  type ResolvedConfig,
  type VerificationOptions,
} from "./types.js";

/** A project needs tool options, not a list of function-to-contract bindings. */
export function createProject(
  root: string,
  options: VerificationOptions = {},
): ResolvedConfig {
  for (const key of ["timeoutMs", "maxHeartbeats"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Failure("spec-error", `${key} must be a positive integer.`);
    }
  }
  if (
    options.lean !== undefined &&
    (typeof options.lean !== "string" || !options.lean)
  ) {
    throw new Failure("spec-error", "lean must be an executable name or path.");
  }
  if (
    options.leanPaths !== undefined &&
    (!Array.isArray(options.leanPaths) ||
      !options.leanPaths.every((p) => typeof p === "string"))
  ) {
    throw new Failure("spec-error", "leanPaths must be an array of paths.");
  }
  root = path.resolve(root);
  return {
    ...options,
    root,
    configFile: "",
    bindings: [],
    leanPaths: (options.leanPaths ?? []).map((p) => path.resolve(root, p)),
    timeoutMs: options.timeoutMs ?? 30000,
    maxHeartbeats: options.maxHeartbeats ?? 200000,
  };
}

export async function leanSources(roots: string[]): Promise<string[]> {
  const files = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || ["node_modules", "dist"].includes(e.name))
        continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await visit(file);
      else if (e.isFile() && file.endsWith(".lean")) files.add(file);
    }
  };
  for (const root of new Set(roots)) await visit(root);
  return [...files].sort();
}
