import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { types as utilTypes } from "node:util";
import * as ts from "typescript/ast";
import { API } from "typescript/sync";
import { openSnapshotProgram, type NativeContext } from "./native.js";
import { isFunctionNode, functionIdentity, type StaticFunction, type StaticExternal, type StaticValue } from "./static.js";
import { Failure, type ContractInfo, type ResolvedConfig } from "./types.js";
import type { FunctionSource, RegisteredObjectSource } from "./runtime-source.js";
import type { SourceSnapshot } from "./source-snapshot.js";
import { LeanWorkspace } from "./lean.js";
import { contractTypes } from "./verify.js";

export interface ObjectContext extends NativeContext {
  declarations: Map<string, ContractInfo[]>;
  snapshot: SourceSnapshot;
}

/** Compiler callbacks operate on actual instances, never on export bindings. */
export interface ObjectCompilation {
  roots: StaticFunction[];
  context(value: StaticFunction | StaticExternal): ObjectContext;
  resolve(owner: StaticFunction, expression: ts.Expression): StaticValue;
  identity(value: StaticFunction | StaticExternal): string;
}

interface RegistryView {
  functions: WeakMap<Function, FunctionSource>;
  objects: WeakMap<object, RegisteredObjectSource>;
}

/** Runtime reads used by one proof, with no mutation of the registered objects. */
export class FunctionGraph {
  readonly sources = new Map<Function, FunctionSource>();
  readonly snapshots = new Map<string, SourceSnapshot>();
  readonly callees = new Map<Function, Map<string, unknown>>();
  readonly receivers = new Map<Function, Map<string, unknown>>();
  private readonly reads: { read: () => unknown; value: unknown; label: string }[] = [];
  private readonly scalars = new Map<Function, Map<string, unknown>>();
  private readonly objectIds = new Map<object, string>();
  readonly objects = new Map<string, { object: object; source: RegisteredObjectSource }>();

  constructor(readonly targets: Function[], readonly registry: RegistryView) {
    for (const fn of targets) this.collect(fn);
  }

  observe(read: () => unknown, label: string): unknown {
    const value = read();
    this.reads.push({ read, value, label });
    return value;
  }

  check(): void {
    for (const observation of this.reads)
      if (!Object.is(observation.read(), observation.value))
        throw new Failure("unsupported", `Verification environment changed: ${observation.label}`);
  }

  private collect(fn: Function): void {
    if (this.sources.has(fn)) return;
    if (utilTypes.isProxy(fn)) throw new Failure("unsupported", "Proxy functions are unsupported");
    const source = this.registry.functions.get(fn);
    if (!source?.snapshot)
      throw new Failure("unsupported", "The function has no source snapshot. Enable ts2lean() for the module that creates it.");
    this.sources.set(fn, source);
    this.snapshots.set(source.snapshot.id, source.snapshot);
    const callees = new Map<string, unknown>();
    this.callees.set(fn, callees);
    for (const reference of Object.keys(source.callees())) {
      const actual = this.observe(() => source.callees()[reference], reference);
      callees.set(reference, actual);
      if (typeof actual === "function" && this.registry.functions.has(actual)) this.collect(actual);
    }
    const receivers = new Map<string, unknown>();
    this.receivers.set(fn, receivers);
    for (const reference of Object.keys(source.receivers?.() ?? {})) {
      const object = this.observe(() => source.receivers!()[reference], reference);
      receivers.set(reference, object);
      if (object && typeof object === "object") this.registerObject(object);
    }
  }

  registerObject(object: object): string | undefined {
    if (utilTypes.isProxy(object)) throw new Failure("unsupported", "Proxy module objects are unsupported");
    const source = this.registry.objects.get(object);
    if (!source?.snapshot) return;
    let id = this.objectIds.get(object);
    if (!id) {
      id = `object${this.objectIds.size}`;
      this.objectIds.set(object, id);
      this.objects.set(id, { object, source });
      this.snapshots.set(source.snapshot.id, source.snapshot);
    }
    return id;
  }

  scalar(fn: Function, reference: string): unknown {
    let values = this.scalars.get(fn);
    if (!values) this.scalars.set(fn, values = new Map());
    if (!values.has(reference)) {
      const source = this.sources.get(fn)!;
      values.set(reference, this.observe(() => source.captures?.()[reference], reference));
    }
    return values.get(reference);
  }

  async prepare(config: ResolvedConfig): Promise<Map<string, Map<string, ContractInfo[]>>> {
    const prepared = new Map<string, Map<string, ContractInfo[]>>();
    const cache = new Map<string, Map<string, ContractInfo[]>>();
    for (const source of this.snapshots.values()) {
      const key = createHash("sha256").update(JSON.stringify([source.specs, source.lean])).digest("hex");
      let declarations = cache.get(key);
      if (!declarations) {
        declarations = new Map();
        if (source.specs.length) {
          const ws = await LeanWorkspace.create(config, undefined, source.lean);
          try {
            for (const spec of source.specs) declarations.set(spec, await ws.discover(spec));
          } finally { await rm(ws.dir, { recursive: true, force: true }); }
        }
        cache.set(key, declarations);
      }
      prepared.set(source.id, declarations);
    }
    this.check();
    return prepared;
  }

  compile<T>(
    declarations: Map<string, Map<string, ContractInfo[]>>,
    run: (session: ObjectCompilation) => T,
  ): T {
    const api = new API();
    const contexts = new Map<string, ObjectContext>();
    const functions = new Map<Function, StaticFunction>();
    const actuals = new Map<StaticFunction, Function>();
    const origins = new Map<StaticFunction | StaticExternal, ObjectContext>();
    const identities = new Map<StaticFunction | StaticExternal, string>();
    const external = new Map<object, StaticExternal>();
    const context = (snapshot: SourceSnapshot): ObjectContext => {
      let found = contexts.get(snapshot.id);
      if (!found) {
        const infos = declarations.get(snapshot.id);
        if (!infos) throw new Failure("unsupported", "Dependency snapshot was not prepared");
        const virtual = new Map([...infos].map(([file, info]) => [file + ".ts", contractTypes(info)]));
        found = { ...openSnapshotProgram(api, snapshot, virtual), declarations: infos, snapshot };
        contexts.set(snapshot.id, found);
      }
      return found;
    };
    const functionValue = (fn: Function): StaticFunction => {
      const old = functions.get(fn);
      if (old) return old;
      const source = this.sources.get(fn);
      if (!source) throw new Failure("unsupported", "Unregistered function dependency has no source snapshot or contract");
      const ctx = context(source.snapshot);
      const sf = ctx.program.getSourceFile(source.module);
      let node: StaticFunction["node"] | undefined;
      const visit = (n: ts.Node): void => {
        if (isFunctionNode(n) && functionIdentity(n) === source.name) node = n;
        n.forEachChild(visit);
      };
      if (sf) visit(sf);
      if (!node) throw new Failure("unsupported", "Registered function is absent from its source snapshot");
      const value: StaticFunction = { kind: "function", node, env: new Map() };
      functions.set(fn, value);
      actuals.set(value, fn);
      origins.set(value, ctx);
      identities.set(value, `function${functions.size - 1}`);
      return value;
    };
    try {
      const session: ObjectCompilation = {
        roots: this.targets.map(functionValue),
        context: (value) => origins.get(value)!,
        identity: (value) => identities.get(value)!,
        resolve: (owner, expression) => {
          const fn = actuals.get(owner)!;
          const reference = expression.getText();
          const callees = this.callees.get(fn)!;
          const receivers = this.receivers.get(fn)!;
          const actual = callees.has(reference) ? callees.get(reference)
            : receivers.has(reference) ? receivers.get(reference) : this.scalar(fn, reference);
          if (typeof actual === "function") return functionValue(actual);
          if (typeof actual === "bigint" || typeof actual === "boolean")
            return { kind: "scalar", type: typeof actual === "bigint" ? "int" : "bool", value: String(actual) };
          if (actual && typeof actual === "object") {
            const id = this.registerObject(actual);
            if (!id) return { kind: "object", fields: new Map() };
            const old = external.get(actual);
            if (old) return old;
            const source = this.objects.get(id)!.source;
            const ctx = context(source.snapshot);
            const sf = ctx.program.getSourceFile(source.module)!;
            const declaration = sf.statements.filter(ts.isVariableStatement)
              .flatMap((s) => s.declarationList.declarations)
              .find((d) => ts.isIdentifier(d.name) && d.name.text === source.name);
            if (!declaration) throw new Failure("unsupported", "Module declaration is absent from its source snapshot");
            const value: StaticExternal = { kind: "external", declaration };
            external.set(actual, value);
            origins.set(value, ctx);
            identities.set(value, id);
            return value;
          }
          throw new Failure("unsupported", `Unsupported captured value: ${reference}`);
        },
      };
      const result = run(session);
      this.check();
      return result;
    } finally {
      try {
        const errors: unknown[] = [];
        for (const ctx of contexts.values()) try { ctx.dispose(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Native context cleanup failed");
      } finally { api.close(); }
    }
  }
}
