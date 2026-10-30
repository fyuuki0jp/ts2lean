import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { LeanWorkspace } from "../lean.js";
import { importedLeanFiles } from "../compiler.js";
import { createProject } from "../project.js";
import {
  Failure,
  type ContractInfo,
  type LeanContract,
  type Result,
  type VerificationOptions,
} from "../types.js";
import { compileEffects, type EffectIR } from "./compiler.js";
import { emitEffects } from "./emit.js";

export async function verifyEffects(
  entries: { file: string; name: string }[],
  contract: LeanContract,
  options: VerificationOptions = {},
  checkSources?: (ir: EffectIR) => void,
): Promise<Result> {
  let artifact: string | undefined;
  try {
    const config = createProject(contract.root, {
      ...contract.options,
      ...options,
    });
    const ws = await LeanWorkspace.create(config);
    await ws.compile("Ts2Lean/LedgerEffects.lean");
    const declarations = new Map<string, ContractInfo[]>();
    const specs = new Set([
      path.resolve(contract.spec),
      ...entries.flatMap((e) => importedLeanFiles(e.file)),
    ]);
    for (const spec of specs) declarations.set(spec, await ws.discover(spec));
    const target = declarations
      .get(path.resolve(contract.spec))
      ?.find((c) => c.name === contract.name);
    if (!target || !["operation", "system"].includes(target.kind ?? ""))
      throw new Failure(
        "spec-error",
        "Expected a Lean operation or system contract",
      );
    const ir = compileEffects(
      entries,
      declarations,
      target.kind === "operation",
    );
    if (!ir.transactions.length)
      throw new Failure(
        "unsupported",
        "No modeled transaction was reachable from the supplied functions",
      );
    checkSources?.(ir);
    artifact = path.join(ws.dir, "Proof.lean");
    await writeFile(path.join(ws.dir, "ir.json"), JSON.stringify(ir, null, 2));
    await writeFile(
      artifact,
      emitEffects(
        ir,
        ws.module(contract.spec),
        contract.name,
        target.kind === "operation",
        config.maxHeartbeats,
      ),
    );
    const outcome = await ws.exec([artifact]);
    if (
      outcome.code !== 0 ||
      outcome.output.includes("declaration uses `sorry`")
    )
      return { status: "unproved", message: outcome.output, artifact };
    const audits = outcome.output
      .split("\n")
      .filter((l) => l.startsWith("TS2LEAN_AXIOMS:"));
    if (!audits.length)
      throw new Failure("tool-error", "Missing Lean axiom audit");
    const axioms = [
      ...new Set(audits.flatMap((l) => JSON.parse(l.slice(15)) as string[])),
    ];
    for (const [file, hash] of Object.entries(ir.sourceHashes)) {
      const current = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      if (current !== hash)
        throw new Failure(
          "unsupported",
          `Source changed while proving: ${file}`,
        );
    }
    checkSources?.(ir);
    return {
      status: "verified",
      message:
        "Lean checked structured callback completion semantics (normal, return, throw), its coverage by symbolic paths, initial safety, arbitrary finite commit/failure/restart sequences, persisted receipts, and retry identity; conditional on the listed module laws.",
      artifact,
      axioms,
      assumptions: ir.modules.map((m) => ({
        identity: m.metadata.identity,
        assurance: "assumed",
        laws: [
          {
            name: "ledger-v1-runtime-refinement",
            assurance: "assumed",
            statement:
              "The adapter refines Ts2Lean.Ledger primitives exactly: immutable keyed reads, unique inserts, balance overwrite, original pending requests; serialized atomic callbacks, durable commits, rollback before commit, and lost responses after commit. These are external assumptions, not proved by TypeScript shape checks.",
          },
          ...m.metadata.laws.map((l) => ({ ...l, assurance: "assumed" })),
        ],
        settings: Object.fromEntries(m.metadata.settings),
        declaration: `${m.spec}#${m.declaration}`,
      })),
      scope: {
        functions: ir.functions.map((f) => `${f.file}#${f.name}`),
        transactions: ir.transactions.length,
        paths: ir.transactions.reduce((n, t) => n + t.paths.length, 0),
        completionPaths: ir.transactions.reduce(
          (n, t) => n + t.completions.length,
          0,
        ),
        semantics:
          "typed completion semantics; every structured callback execution refines the full symbolic completion relation; TypeScript lowering and pure-expression translation remain trusted",
        execution:
          "arbitrary finite serializable commits, aborts, precommit crashes, lost responses, and restarts; safety only",
        artifacts: [artifact, path.join(ws.dir, "ir.json")],
      },
    };
  } catch (error) {
    return {
      status: error instanceof Failure ? error.status : "tool-error",
      message: error instanceof Error ? error.message : String(error),
      artifact,
    };
  }
}
