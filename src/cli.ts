#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { verify, extract } from "./verify.js";
import { Failure, type Result } from "./types.js";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  console.log(
    "Usage: ts2lean <extract|verify> [--config ts2lean.config.ts] [--json]\nRequires Lean 4.35.0. Set TS2LEAN_LEAN to override its executable.",
  );
} else {
  let results: Result[];
  try {
    const command = args.shift();
    if (command !== "extract" && command !== "verify")
      throw new Failure("tool-error", `Unknown command: ${command}`);
    let config = "ts2lean.config.ts";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--config" && args[i + 1]) {
        config = args[++i]!;
      } else if (args[i] !== "--json")
        throw new Failure(
          "tool-error",
          `Unknown or incomplete option: ${args[i]}`,
        );
    }
    results = await (command === "verify" ? verify : extract)(
      await loadConfig(config),
    );
  } catch (error) {
    results = [
      {
        status: error instanceof Failure ? error.status : "tool-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  if (args.includes("--json"))
    console.log(JSON.stringify({ results }, null, 2));
  else
    for (const r of results)
      console.log(
        `${r.status}: ${r.module ?? ""}${r.export ? `#${r.export}` : ""}\n${r.message}${r.artifact ? `\n${r.artifact}` : ""}`,
      );
  if (results.some((r) => r.status !== "verified" && r.status !== "extracted"))
    process.exitCode = 1;
}
