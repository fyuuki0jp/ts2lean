import { types as utilTypes } from "node:util";
import {
  Failure,
  type LeanContract,
  type Result,
  type VerificationOptions,
  type PortBinding, type UseCaseEntry, type UseCaseOptions,
} from "./types.js";
import { verifyLoadedFunction } from "./verify.js";
import { FunctionGraph } from "./object-context.js";
import type { FunctionSource, ObjectSource, RegisteredObjectSource } from "./runtime-source.js";
import type { SourceSnapshot } from "./source-snapshot.js";
import { verifyEffects } from "./effects/verify.js";
import type { EffectIR } from "./effects/compiler.js";
import {reportVerification} from "./report.js";
import {verifyPortCases} from "./ports/verify.js";
import {withSourceFile} from "./native.js";
import {functionIdentity,isFunctionNode} from "./static.js";
import {createHash} from "node:crypto";

interface Registry {
  functions: WeakMap<Function, FunctionSource>;
  objects: WeakMap<object, RegisteredObjectSource>;
}
const registryKey = Symbol.for("ts2lean.runtime.v2");
const globalRegistry = globalThis as typeof globalThis & {
  [registryKey]?: Registry;
};
const registry = (globalRegistry[registryKey] ??= {
  functions: new WeakMap(),
  objects: new WeakMap(),
});
const portBindings = new WeakMap<PortBinding,{receiver:object;key:string;fn:Function;contract:LeanContract;boundary?:string}>();

/** Register an explicit adapter assumption without executing or wrapping it. */
export function bindPort<T extends object>(receiver:T,key:keyof T & string,contract:LeanContract,options:{boundary?:string}={}):PortBinding {
  if(!receiver || utilTypes.isProxy(receiver))throw new Failure("unsupported","Port receiver must be a non-Proxy object");
  if(contract?.kind!=="ts2lean.contract"||contract.profile!=="port")throw new Failure("spec-error","Import a Lean port contract");
  const fn=methodValue(receiver,key);
  if(typeof fn!=="function"||utilTypes.isProxy(fn))throw new Failure("unsupported","Port requires a data method");
  const binding=Object.freeze({kind:"ts2lean.port-binding" as const});
  portBindings.set(binding,{receiver,key,fn,contract,boundary:options.boundary});
  return binding;
}

/** Verify the supplied implementations and all finite serial combinations. */
export function verifyUseCases(entries:readonly UseCaseEntry[],options:UseCaseOptions):Promise<Result> {
  return reportVerification(entries[0]?.contract,options,setCheck=>verifyUseCasesInternal(entries,options,setCheck));
}
async function verifyUseCasesInternal(entries:readonly UseCaseEntry[],options:UseCaseOptions,setFinalCheck:(check:()=>void)=>void):Promise<Result> {
  if(!entries.length)throw new Failure("unsupported","Supply at least one actual use-case function");
  for(const entry of entries)if(typeof entry.fn!=="function"||entry.contract?.profile!=="use-case")
    throw new Failure("spec-error","Each use-case requires an actual function and imported Lean use-case contract");
  const bound=options.ports.map(binding=>{
    const value=portBindings.get(binding);
    if(!value)throw new Failure("assumption-mismatch","Port bindings must be created by bindPort");
    return value;
  });
  if(bound.some((p,i)=>bound.some((q,j)=>i!==j&&p.receiver===q.receiver&&p.key===q.key)))
    throw new Failure("assumption-mismatch","A receiver method may have only one port contract");
  const checkMethods=()=>{
    for(const p of bound)if(methodValue(p.receiver,p.key)!==p.fn)
      throw new Failure("assumption-mismatch",`Bound port method changed: ${p.key}`);
  };
  checkMethods();
  const receiverIds=new Map<object,string>(),methodIds=new Map<Function,string>();
  const adapterEvidence=bound.map(p=>{
    if(!receiverIds.has(p.receiver))receiverIds.set(p.receiver,`receiver${receiverIds.size}`);
    if(!methodIds.has(p.fn))methodIds.set(p.fn,`method${methodIds.size}`);
    const evidence:NonNullable<NonNullable<Result["assumptions"]>[number]["adapter"]>={key:p.key,receiverId:receiverIds.get(p.receiver)!,methodId:methodIds.get(p.fn)!,boundary:p.boundary};
    const source=registry.functions.get(p.fn);
    if(source) {
      const text=source.snapshot.files[source.module];
      if(text===undefined)throw new Failure("unsupported","Missing adapter snapshot source");
      withSourceFile(source.module,text,sf=>{
        const visit=(node:import("typescript/ast").Node):void=>{
          if(isFunctionNode(node)&&functionIdentity(node)===source.name)evidence.source={
            file:source.module,name:source.name,sha256:createHash("sha256").update(text).digest("hex"),snapshot:source.snapshot.id,
            span:{start:node.getStart(),end:node.end,startLine:sf.getLineAndCharacterOfPosition(node.getStart()).line+1,endLine:sf.getLineAndCharacterOfPosition(node.end).line+1}};
          node.forEachChild(visit);
        };visit(sf);
      });
    }
    if(!evidence.source&&!p.boundary?.trim())throw new Failure("assumption-mismatch",`Unregistered port method ${p.key} needs an explicit boundary description`);
    return evidence;
  });
  const graph=new FunctionGraph(entries.map(e=>e.fn),registry,bound.map((p,index)=>({...p,index})));
  const check=()=>{checkMethods();graph.check();};
  setFinalCheck(check);
  const result=await verifyPortCases(graph,entries,bound.map(p=>p.contract),options,check,adapterEvidence);
  if(result.status!=="verified")throw new VerificationError(result);
  check();
  return result;
}

/** Generated snapshot modules freeze the exact inputs used to create their functions. */
export function defineSourceSnapshot(source: SourceSnapshot): SourceSnapshot {
  return Object.freeze({ ...source,
    files: Object.freeze({ ...source.files }), roots: Object.freeze([...source.roots]),
    resolutions: Object.freeze(source.resolutions.map((r) => Object.freeze({ ...r }))),
    specs: Object.freeze([...source.specs]), lean: Object.freeze({ ...source.lean }),
  });
}

/** Used by generated Vite instrumentation. Does not execute the function. */
export function registerFunction(fn: Function, source: FunctionSource): void {
  registry.functions.set(fn, Object.freeze({ ...source }));
}

/** Attach origin and environment readers to the newly created function instance. */
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

/** Inspect inherited data methods without invoking getters or Proxy traps. */
function methodValue(object: object, key: string): unknown {
  for (let p: object | null = object; p; p = Object.getPrototypeOf(p)) {
    if (utilTypes.isProxy(p))
      throw new Failure("unsupported", "Proxy module objects are unsupported");
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) {
      if (!("value" in d))
        throw new Failure(
          "unsupported",
          `Module accessor is unsupported: ${key}`,
        );
      return d.value;
    }
  }
}

/** Instrumented module values; registration records identity, not proof of DB laws. */
export function registerObject<T>(
  value: T,
  source: ObjectSource,
): T {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return value;
  const methods = new Map<string, unknown>();
  const seen = new Set<string>();
  for (let proto = value; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    if (utilTypes.isProxy(proto)) return value;
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (typeof descriptor.value === "function") methods.set(name, descriptor.value);
    }
  }
  registry.objects.set(value, Object.freeze({ ...source, methods }));
  return value;
}

/** Used by the .lean loader. Descriptors carry specification inputs, never proof results. */
export function contractReference(
  spec: string,
  name: string,
  root: string,
  options: VerificationOptions,
  profile: LeanContract["profile"] = "pure",
  sources?: Readonly<Record<string, string>>,
): LeanContract {
  return Object.freeze({
    kind: "ts2lean.contract" as const,
    profile,
    spec,
    name,
    root,
    options: Object.freeze({ ...options }),
    sources: sources ? Object.freeze({ ...sources }) : undefined,
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

/** Runner-independent assertion. Resolves only if Lean verifies the supplied function instance. */
export function verifyFunction<Input, Output>(
  fn: (input: Input) => Output,
  contract: LeanContract<Input, Output>,
  options?: VerificationOptions,
): Promise<Result>;
export function verifyFunction<Args extends unknown[], Output>(
  fn: (...args: Args) => Output,
  contract: LeanContract<Args extends [infer Input] ? Input : unknown, Output>,
  options?: VerificationOptions,
): Promise<Result>;
export async function verifyFunction(
  fn: Function,
  contract: LeanContract,
  options: VerificationOptions = {},
): Promise<Result> {
  if (contract?.profile === "operation") return verifySystem({target:fn},contract,options);
  return reportVerification(contract,options,setCheck=>verifyFunctionInternal(fn,contract,options,setCheck));
}
async function verifyFunctionInternal(fn:Function,contract:LeanContract,options:VerificationOptions,setFinalCheck:(check:()=>void)=>void):Promise<Result> {
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
  const graph = new FunctionGraph([fn], registry);
  setFinalCheck(()=>graph.check());
  const result = await verifyLoadedFunction(graph, contract, options);
  if (!result || result.status !== "verified")
    throw new VerificationError(
      result ?? {
        status: "tool-error",
        message: "Verification returned no result.",
      },
    );
  // Recheck after the await as well, before resolving the public assertion.
  graph.check();
  return result;
}

export function verifySystem(entries:Record<string,Function>,contract:LeanContract,options:VerificationOptions={}):Promise<Result> {
  return reportVerification(contract,options,setCheck=>verifySystemInternal(entries,contract,options,setCheck));
}
async function verifySystemInternal(
  entries: Record<string, Function>,
  contract: LeanContract,
  options: VerificationOptions,
  setFinalCheck:(check:()=>void)=>void,
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
  const graph = new FunctionGraph(roots, registry);
  let checkedIR: EffectIR | undefined;
  const methodReads = new Map<string, Map<string, unknown>>();
  const check = (ir: EffectIR, inspectSettings = true): void => {
    graph.check();
    for (const law of ir.modules) {
      const entry = law.instance && graph.objects.get(law.instance);
      if (!entry) throw new Failure("unsupported", "Missing runtime module instance");
      const { object } = entry;
      let methods = methodReads.get(law.instance!);
      if (!methods) {
        methods = new Map();
        methodReads.set(law.instance!, methods);
        const required = new Set(law.metadata.interfaces
          .filter((api) => api.methods.some((m) => m.operation === "transaction"))
          .flatMap((api) => api.methods.map((m) => m.name)));
        required.add("settings");
        for (const name of required) {
          const method = graph.observe(() => methodValue(object, name), `${law.instance}.${name}`);
          if (typeof method !== "function") throw new Failure("assumption-mismatch", `Adapter needs a data method: ${name}`);
          if (utilTypes.isProxy(method)) throw new Failure("unsupported", `Proxy module methods are unsupported: ${name}`);
          if (method !== entry.source.methods.get(name))
            throw new Failure("assumption-mismatch", `Module method replaced since law registration: ${name}`);
          methods.set(name, method);
        }
      }
      if (!inspectSettings) continue;
      const settings = Reflect.apply(methods.get("settings") as Function, object, []);
      for (const [key, value] of law.metadata.settings) {
        const actual = dependencyReference(settings, [key]);
        if (!["string", "boolean", "number"].includes(typeof actual) || String(actual) !== value)
          throw new Failure("assumption-mismatch", `DB setting ${key}: expected ${value}`);
      }
    }
    graph.check();
    checkedIR = ir;
  };
  const result = await verifyEffects([], contract, options, check, graph);
  if (result.status !== "verified") throw new VerificationError(result);
  check(checkedIR!);
  setFinalCheck(()=>check(checkedIR!));
  return result;
}
