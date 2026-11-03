import { createProject } from "./project.js";
import type { FunctionGraph } from "./object-context.js";
import { moduleTypes, effectTypes } from "./module-types.js";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { LeanWorkspace } from "./lean.js";
import {
  compileTypeScript,
  compileFunctionObject,
  importedLeanFiles,
  type ModuleIR,
} from "./compiler.js";
import { emitModel, emitProof } from "./emit.js";
import {
  Failure,
  tsType,
  type ResolvedConfig,
  type Result,
  type ContractInfo,
  type Binding,
  type LeanContract,
  type VerificationOptions,
} from "./types.js";
export function contractExportName(info: ContractInfo): string {
  const name = info.name.split(".").at(-1)!;
  if (
    !/^[A-Za-z_]\w*$/.test(name) ||
    [
      "default",
      "class",
      "function",
      "const",
      "let",
      "var",
      "export",
      "import",
      "return",
      "new",
      "delete",
      "await",
      "yield",
      "enum",
      "extends",
      "implements",
      "package",
      "private",
      "protected",
      "public",
      "static",
      "interface",
      "switch",
      "case",
      "break",
      "continue",
      "if",
      "else",
      "for",
      "while",
      "do",
      "try",
      "catch",
      "finally",
      "throw",
      "with",
      "void",
      "typeof",
      "instanceof",
      "in",
      "super",
      "this",
      "true",
      "false",
      "null",
      "debugger",
    ].includes(name)
  ) {
    throw new Failure(
      "spec-error",
      `Contract cannot be exported as a JavaScript identifier: ${info.name}`,
    );
  }
  return name;
}
export function contractTypes(infos: ContractInfo[]): string {
  const seen = new Set<string>();
  return (
    infos
      .map((c) => {
        const name = contractExportName(c);
        if (seen.has(name))
          throw new Failure("spec-error", `Duplicate contract export: ${name}`);
        seen.add(name);
        if (c.kind === "module") return moduleTypes(c);
        if (c.kind === "operation" || c.kind === "system")
          return effectTypes(c);
        return `export type ${name} = { readonly input: ${tsType(c.input)}; readonly output: ${tsType(c.output)} };\nexport declare const ${name}: { readonly kind: "ts2lean.contract"; readonly spec: string; readonly name: string; readonly root: string; readonly options: {}; readonly types?: ${name} };`;
      })
      .join("\n") + "\n"
  );
}
export async function processBindings(
  config: ResolvedConfig,
  mode: "verify" | "extract",
  checkSources?: (ir: ModuleIR) => void,
): Promise<Result[]> {
  const results: Result[] = [];
  for (const binding of config.bindings) {
    try {
      const ws = await LeanWorkspace.create(config);
      const infos = new Map<string, ContractInfo[]>();
      let target: ContractInfo | undefined;
      // All imported specifications are checked by Lean before constructing virtual TS types.
      const specs = new Set([
        ...config.bindings.map((b) => path.resolve(config.root, b.spec)),
        ...importedLeanFiles(path.resolve(config.root, binding.module)),
      ]);
      for (const spec of specs) {
        const list = await ws.discover(spec);
        infos.set(spec + ".ts", list);
        if (spec === path.resolve(config.root, binding.spec))
          target = list.find((info) => info.name === binding.contract);
      }
      if (!target)
        throw new Failure(
          "spec-error",
          `No public contract named ${binding.contract} in ${binding.spec}.`,
        );
      const virtual = new Map(
        [...infos].map(([file, info]) => [file, contractTypes(info)]),
      );
      const ir = compileTypeScript(
        path.resolve(config.root, binding.module),
        binding.export,
        target!,
        virtual,
      );
      checkSources?.(ir);
      results.push(await proveModule(ws, ir, binding, target, mode, checkSources));
    } catch (error) {
      results.push({
        status: error instanceof Failure ? error.status : "tool-error",
        module: binding.module,
        export: binding.export,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
async function proveModule(
  ws: LeanWorkspace,
  ir: ModuleIR,
  binding: Binding,
  target: ContractInfo,
  mode: "verify" | "extract",
  check?: (ir: ModuleIR) => void,
): Promise<Result> {
  check?.(ir);
  const model = path.join(ws.dir, "Model.lean");
  await writeFile(model, emitModel(ir, ws.module(binding.spec)));
  await writeFile(path.join(ws.dir, "ir.json"), JSON.stringify(ir, null, 2) + "\n");
  await ws.compile("Model.lean");
  if (mode === "extract") return {
    status: "extracted", module: binding.module, export: binding.export,
    message: "Lean model generated and typechecked; no proof has been claimed.", artifact: model,
  };
  const proof = path.join(ws.dir, "Proof.lean");
  await writeFile(proof, emitProof(ir, binding.contract, ws.config.maxHeartbeats, target.unfold));
  const outcome = await ws.exec([proof]);
  if (outcome.code !== 0 || outcome.output.includes("declaration uses `sorry`"))
    return { status: "unproved", module: binding.module, export: binding.export,
      message: outcome.output, artifact: proof };
  const line = outcome.output.split("\n").find((l) => l.includes("TS2LEAN_AXIOMS:"));
  if (!line) throw new Failure("tool-error", "Proof finished without an axiom audit.");
  const axioms = JSON.parse(line.slice(line.indexOf("TS2LEAN_AXIOMS:") + 15)) as string[];
  check?.(ir);
  return { status: "verified", module: binding.module, export: binding.export,
    message: "Lean checked the generated model and its axiom dependencies.", artifact: proof, axioms };
}

export async function verifyLoadedFunction(
  graph: FunctionGraph,
  contract: LeanContract,
  options: VerificationOptions,
): Promise<Result> {
  const source = graph.sources.get(graph.targets[0]!)!;
  const binding = { module: source.module, export: source.name, spec: contract.spec, contract: contract.name };
  try {
    const config = createProject(contract.root, { ...contract.options, ...options });
    const ws = await LeanWorkspace.create(config, undefined, contract.sources);
    const target = (await ws.discover(contract.spec)).find((info) => info.name === contract.name);
    if (!target || (target.kind && target.kind !== "pure"))
      throw new Failure("spec-error", "Expected a pure function contract");
    const contexts = await graph.prepare(config);
    const ir = graph.compile(contexts, (session) => compileFunctionObject(session, target));
    return await proveModule(ws, ir, binding, target, "verify", () => graph.check());
  } catch (error) {
    return { status: error instanceof Failure ? error.status : "tool-error",
      module: source.module, export: source.name,
      message: error instanceof Error ? error.message : String(error) };
  }
}

export const verify = (config: ResolvedConfig): Promise<Result[]> =>
  processBindings(config, "verify");
export const extract = (config: ResolvedConfig): Promise<Result[]> =>
  processBindings(config, "extract");
