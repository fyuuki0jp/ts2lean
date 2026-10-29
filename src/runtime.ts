import { types as utilTypes } from "node:util";
import {
  Failure,
  type LeanContract,
  type Result,
  type VerificationOptions,
} from "./types.js";
import { createProject } from "./project.js";
import { processBindings } from "./verify.js";
import type { ModuleIR } from "./compiler.js";
import { verifyEffects } from "./effects/verify.js";
import type { EffectIR } from "./effects/compiler.js";

interface FunctionSource {
  module: string;
  export?: string;
  name: string;
  hash: string;
  callees: () => Record<string, Function>;
  captures?: () => Record<string, unknown>;
  objects?: () => Record<string, object>;
}
interface Registry {
  functions: WeakMap<Function, FunctionSource>;
  bindings: WeakMap<Function, { module: string; export: string }>;
  modules: Map<
    string,
    { hash: string; references: () => Record<string, Function> }
  >;
  objects: WeakMap<
    object,
    {
      module: string;
      name: string;
      hash: string;
      methods: Map<string, unknown>;
    }
  >;
}
const registryKey = Symbol.for("ts2lean.runtime.v1");
const globalRegistry = globalThis as typeof globalThis & {
  [registryKey]?: Registry;
};
const registry = (globalRegistry[registryKey] ??= {
  functions: new WeakMap(),
  bindings: new WeakMap(),
  modules: new Map(),
  objects: new WeakMap(),
});

/** Used by generated Vite instrumentation. Does not execute the function. */
export function registerFunction(fn: Function, source: FunctionSource): void {
  registry.functions.set(fn, Object.freeze({ ...source }));
}

/** Registers origin at closure creation, separately from its exported binding. */
export function registerClosure<T extends Function>(
  fn: T,
  source: FunctionSource,
): T {
  registerFunction(fn, source);
  return fn;
}
export function registerMethods<T extends object>(
  object: T,
  sources: Record<string, FunctionSource>,
): T {
  for (const [key, source] of Object.entries(sources)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (typeof descriptor?.value === "function")
      registerFunction(descriptor.value, source);
  }
  return object;
}
export function registerExport(
  value: unknown,
  source: { module: string; export: string },
  seen = new Set<object>(),
): void {
  if (typeof value === "function") {
    registry.bindings.set(value, source);
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    seen.has(value) ||
    utilTypes.isProxy(value)
  )
    return;
  seen.add(value);
  for (const [name, d] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  ))
    if ("value" in d)
      registerExport(
        d.value,
        { module: source.module, export: source.export + "." + name },
        seen,
      );
}
export function registerModule(
  module: string,
  hash: string,
  references: () => Record<string, Function>,
): void {
  registry.modules.set(module, { hash, references });
}
/** Read dependency paths without executing user getters. */
export function dependencyReference(root: unknown, keys: string[]): unknown {
  let value = root;
  for (const key of keys) {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      throw new Failure("unsupported", "Invalid dependency object");
    if (utilTypes.isProxy(value))
      throw new Failure(
        "unsupported",
        "Proxy dependency objects are unsupported",
      );
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d))
      throw new Failure(
        "unsupported",
        `Dependency accessor or inherited property is unsupported: ${key}`,
      );
    value = d.value;
  }
  return value;
}

/** Instrumented module values; registration records identity, not proof of DB laws. */
export function registerObject(
  value: unknown,
  source: { module: string; name: string; hash: string },
): void {
  if (!value || typeof value !== "object") return;
  const methods = new Map<string, unknown>();
  for (
    let proto = value;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(proto),
    )) {
      if (typeof descriptor.value === "function" && !methods.has(name))
        methods.set(name, descriptor.value);
    }
  registry.objects.set(value, { ...source, methods });
}

/** Used by the .lean loader. Descriptors carry locations, never proof results. */
export function contractReference(
  spec: string,
  name: string,
  root: string,
  options: VerificationOptions,
  profile: LeanContract["profile"] = "pure",
): LeanContract {
  return Object.freeze({
    kind: "ts2lean.contract" as const,
    profile,
    spec,
    name,
    root,
    options: Object.freeze({ ...options }),
  });
}

export class VerificationError extends Error {
  constructor(readonly result: Result) {
    super(
      `[ts2lean:${result.status}] ${result.module ?? ""}#${result.export ?? ""}\n${result.message}${result.artifact ? `\nArtifact: ${result.artifact}` : ""}`,
    );
    this.name = "VerificationError";
  }
}

/** Runner-independent assertion. Resolves only if Lean verifies the imported function. */
export async function verifyFunction<Input, Output>(
  fn: (input: Input) => Output,
  contract: LeanContract<Input, Output>,
  options: VerificationOptions = {},
): Promise<Result> {
  if (contract?.profile === "operation")
    return verifySystem({ target: fn }, contract, options);
  const source =
    typeof fn === "function" ? registry.functions.get(fn) : undefined;
  const binding =
    typeof fn === "function" &&
    (registry.bindings.get(fn) ??
      (source?.export
        ? { module: source.module, export: source.export }
        : undefined));
  if (!source || !binding)
    throw new Failure(
      "unsupported",
      "The function has no source registration. Enable ts2lean() from ts2lean/vite and import a named exported function directly. Mocks, wrappers and bound functions cannot be verified.",
    );
  if (
    !contract ||
    contract.kind !== "ts2lean.contract" ||
    !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(contract.name)
  ) {
    throw new Failure(
      "spec-error",
      "Import the Lean contract as a value from its .lean file.",
    );
  }
  const config = createProject(contract.root, {
    ...contract.options,
    ...options,
  });
  config.bindings = [
    {
      module: binding.module,
      export: binding.export,
      spec: contract.spec,
      contract: contract.name,
    },
  ];
  let verifiedIR: ModuleIR | undefined;
  const checkSources = (ir: ModuleIR): void => {
    for (const module of ir.runtimeModules ?? Object.keys(ir.sourceHashes)) {
      const hash = ir.sourceHashes[module];
      if (registry.modules.get(module)?.hash !== hash)
        throw new Failure(
          "unsupported",
          `Loaded module source differs from verification input: ${module}`,
        );
    }
    for (const c of ir.compositionChecks ?? []) {
      const actual = registry.modules.get(c.source)?.references()[c.reference];
      const origin = actual && registry.functions.get(actual);
      if (
        !origin ||
        origin.module !== c.targetSource ||
        origin.name !== c.targetName ||
        origin.hash !== ir.sourceHashes[c.targetSource]
      )
        throw new Failure(
          "unsupported",
          `Factory dependency changed: ${c.source}#${c.reference}`,
        );
    }
    const checked = new Map<string, Function>();
    const check = (name: string, actual: Function): void => {
      if (checked.get(name) === actual) return;
      checked.set(name, actual);
      const f = ir.functions.find((f) => f.name === name)!;
      const loaded = registry.functions.get(actual);
      if (
        !loaded ||
        loaded.module !== f.source ||
        loaded.name !== f.localName ||
        loaded.hash !== ir.sourceHashes[f.source]
      ) {
        throw new Failure(
          "unsupported",
          `Loaded source differs from the file being verified, or a function dependency was mocked or not instrumented: ${f.source}#${f.localName}. Reload the test modules before verifying.`,
        );
      }
      for (const capture of f.captures ?? []) {
        const actual = loaded.captures?.()[capture.reference];
        const expected =
          capture.type === "int"
            ? BigInt(capture.value)
            : capture.value === "true";
        if (actual !== expected)
          throw new Failure(
            "unsupported",
            `Captured setting changed: ${capture.reference}`,
          );
      }
      const callees = loaded.callees();
      for (const call of f.calls) {
        const callee = callees[call.reference];
        if (!callee)
          throw new Failure(
            "unsupported",
            `Unregistered function dependency: ${f.source}#${call.reference}`,
          );
        check(call.target, callee);
      }
    };
    check(ir.target, fn);
    verifiedIR = ir;
  };
  const [result] = await processBindings(config, "verify", checkSources);
  if (!result || result.status !== "verified")
    throw new VerificationError(
      result ?? {
        status: "tool-error",
        message: "Verification returned no result.",
      },
    );
  // Recheck after the await as well, before resolving the public assertion.
  checkSources(verifiedIR!);
  return result;
}

export async function verifySystem(
  entries: Record<string, Function>,
  contract: LeanContract,
  options: VerificationOptions = {},
): Promise<Result> {
  if (
    !contract ||
    contract.kind !== "ts2lean.contract" ||
    !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(contract.name)
  )
    throw new Failure("spec-error", "Import a Lean system contract");
  const roots = Object.values(entries);
  if (!roots.length)
    throw new Failure("unsupported", "Supply at least one entrypoint");
  const sources = roots.map((fn) => {
    const source = registry.functions.get(fn);
    if (!source?.export)
      throw new Failure(
        "unsupported",
        "Entrypoints must be original instrumented exported functions",
      );
    return { file: source.module, name: source.export };
  });
  let checkedIR: EffectIR | undefined;
  const check = (ir: EffectIR) => {
    const seen = new Set<Function>();
    const visit = (fn: Function, key: string) => {
      const actual = registry.functions.get(fn),
        expected = ir.functions.find((f) => `${f.file}#${f.name}` === key);
      if (
        !actual ||
        !expected ||
        actual.module !== expected.file ||
        actual.name !== expected.name ||
        actual.hash !== expected.hash
      )
        throw new Failure(
          "unsupported",
          `Function source or dependency changed: ${key}`,
        );
      if (seen.has(fn)) return;
      seen.add(fn);
      for (const call of expected.calls)
        visit(actual.callees()[call.reference]!, call.target);
      for (const name of expected.objects) {
        const object = actual.objects?.()[name],
          loaded = object && registry.objects.get(object);
        const law = ir.modules.find((m) => m.reference === name);
        if (
          !object ||
          !loaded ||
          !law ||
          loaded.module !== law.file ||
          loaded.name !== law.name ||
          loaded.hash !== law.hash
        )
          throw new Failure("unsupported", `Module identity mismatch: ${name}`);
        for (const api of law.metadata.interfaces.filter((i) =>
          i.methods.some((m) => m.operation === "transaction"),
        ))
          for (const method of api.methods)
            if (!loaded.methods.has(method.name))
              throw new Failure(
                "unsupported",
                `Module method is an accessor or was not registered: ${method.name}`,
              );
        for (const [method, original] of loaded.methods)
          if ((object as Record<string, unknown>)[method] !== original)
            throw new Failure(
              "unsupported",
              `Module method replaced: ${name}.${method}`,
            );
        const settings = (
          object as { settings?: () => Record<string, unknown> }
        ).settings?.();
        if (!settings)
          throw new Failure(
            "assumption-mismatch",
            `Adapter must expose settings() evidence: ${name}`,
          );
        for (const [key, value] of law.metadata.settings)
          if (String(settings[key]) !== value)
            throw new Failure(
              "assumption-mismatch",
              `DB setting ${key}: expected ${value}, got ${settings[key]}`,
            );
      }
    };
    roots.forEach((fn, i) =>
      visit(fn, `${sources[i]!.file}#${sources[i]!.name}`),
    );
    checkedIR = ir;
  };
  const result = await verifyEffects(sources, contract, options, check);
  if (result.status !== "verified") throw new VerificationError(result);
  check(checkedIR!);
  return result;
}
