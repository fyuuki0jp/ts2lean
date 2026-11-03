export interface UnionVariant {
  tag: string | boolean;
  constructor: string;
  fields: { name: string; shape: Shape }[];
}
export type UnionShape = {
  kind: "union";
  lean: string;
  tag: string;
  variants: UnionVariant[];
};
export type Shape =
  | { kind: "int" }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "jsstring" }
  | { kind: "safeinteger" }
  | { kind: "snapshot" }
  | { kind: "array"; element: Shape }
  | { kind: "optional"; element: Shape }
  | { kind: "unit" }
  | { kind: "never" }
  | { kind: "literal"; value: string | boolean }
  | UnionShape
  | { kind: "record"; lean: string; fields: { name: string; shape: Shape }[] };
export interface Binding {
  module: string;
  export: string;
  spec: string;
  contract: string;
}
export interface VerificationOptions {
  /** TypeScript project file, relative to root. Defaults to root/tsconfig.json when present. */
  tsconfig?: string;
  /** One complete result per invocation, after final live-reference checks. */
  report?: {directory:string; runId:string};
  /** Directories containing imported Lean modules, relative to the config. */
  leanPaths?: string[];
  lean?: string;
  timeoutMs?: number;
  maxHeartbeats?: number;
}
export interface Config extends VerificationOptions {
  bindings: Binding[];
}
export interface ResolvedConfig extends Config {
  root: string;
  configFile: string;
  leanPaths: string[];
  timeoutMs: number;
  maxHeartbeats: number;
}
export interface ContractInfo {
  dataProfile?: "snapshot" | null;
  kind?: "pure" | "module" | "operation" | "system" | "state-machine" | "port" | "use-case";
  world?: {state:string; event:string; error:string};
  module?: ModuleMetadata;
  name: string;
  input: Shape;
  output: Shape;
  unfold: string[];
  /** Explicitly mapped intermediate boolean unions from the Lean environment. */
  supportingTypes?: Shape[];
}
export type Status =
  | "verified"
  | "extracted"
  | "unproved"
  | "unsupported"
  | "spec-error"
  | "type-error"
  | "tool-error"
  | "timeout"
  | "assumption-mismatch"
  | "counterexample";
export interface Result {
  status: Status;
  module?: string;
  export?: string;
  message: string;
  artifact?: string;
  axioms?: string[];
  /** Function spans identify translated source, not whole-file or branch coverage. */
  evidence?: {
    dataProfile?: {
      name:"snapshot";
      assumptions:string[];
      numberDomain:string;
      safety:string;
    };
    profile: string;
    contract: { file: string; name: string };
    contracts?: {file:string; name:string; target?:string}[];
    leanSources: { file: string; sha256: string }[];
    functions: {
      file: string; name: string; sha256: string; snapshot?: string; instance?: string;
      modelName?:string; modelSha256?:string;
      captures?: {reference:string;type:"int"|"bool";value:string}[];
      span: { start: number; end: number; startLine: number; endLine: number };
    }[];
  };
  assumptions?: {
    identity: string;
    assurance: "assumed" | "proved";
    laws: { name: string; statement: string; assurance: string }[];
    settings: Record<string, string>;
    declaration: string;
    adapter?: {
      key:string; receiverId:string; methodId:string;
      boundary?:string;
      source?: NonNullable<Result["evidence"]>["functions"][number];
    };
  }[];
  scope?: {
    functions: string[];
    transactions: number;
    paths: number;
    completionPaths?: number;
    semantics?: string;
    execution: string;
    artifacts: string[];
  };
}
export class Failure extends Error {
  constructor(
    public status: Status,
    message: string,
  ) {
    super(message);
  }
}
export const defineConfig = (config: Config): Config => config;
export function shapeKey(s: Shape): string {
  if (s.kind === "array" || s.kind === "optional") return JSON.stringify([s.kind,shapeKey(s.element)]);
  if (s.kind === "literal") return JSON.stringify(["literal", s.value]);
  if (s.kind === "union")
    return JSON.stringify([
      "union",
      s.tag,
      s.variants
        .map((v) => [
          v.tag,
          shapeKey({ kind: "record", lean: "", fields: v.fields }),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]);
  return s.kind === "record"
    ? JSON.stringify(
        s.fields
          .map((f) => [f.name, shapeKey(f.shape)])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      )
    : s.kind;
}
export function tsType(s: Shape): string {
  if (s.kind === "safeinteger") return "number";
  if (s.kind === "snapshot") return "unknown";
  if (s.kind === "array") return `readonly (${tsType(s.element)})[]`;
  if (s.kind === "optional") return `(${tsType(s.element)} | undefined)`;
  if (s.kind === "unit") return "undefined";
  if (s.kind === "never") return "never";
  if (s.kind === "literal") return JSON.stringify(s.value);
  if (s.kind === "union")
    return s.variants
      .map(
        (v) =>
          `{ readonly ${JSON.stringify(s.tag)}: ${JSON.stringify(v.tag)}; ${v.fields.map((f) => `readonly ${JSON.stringify(f.name)}: ${tsType(f.shape)}`).join("; ")} }`,
      )
      .join(" | ");
  return s.kind === "int"
    ? "bigint"
    : s.kind === "string" || s.kind === "jsstring"
      ? "string"
      : s.kind === "bool"
        ? "boolean"
        : `{ ${s.fields.map((f) => `readonly ${JSON.stringify(f.name)}: ${tsType(f.shape)}`).join("; ")} }`;
}

/** A runtime reference to a Lean contract, created by the Vite plugin. */
export interface LeanContract<Input = unknown, Output = unknown> {
  readonly kind: "ts2lean.contract";
  readonly profile?: ContractInfo["kind"];
  readonly spec: string;
  readonly name: string;
  readonly root: string;
  readonly options: VerificationOptions;
  /** The Lean sources associated with an imported contract value. */
  readonly sources?: Readonly<Record<string, string>>;
  /** Phantom type information; no input is sampled or executed. */
  readonly types?: { readonly input: Input; readonly output: Output };
}
export interface PortBinding { readonly kind: "ts2lean.port-binding" }
export interface UseCaseEntry { readonly fn: Function; readonly contract: LeanContract }
export interface UseCaseOptions extends VerificationOptions { readonly ports: readonly PortBinding[] }

export interface ApiType {
  kind: string;
  name?: string;
  arguments?: ApiType[];
  result?: ApiType;
}
export interface ApiMethod {
  name: string;
  parameters: [string, ApiType][];
  result: ApiType;
  operation: string;
  generics: string[];
}
export interface ApiInterface {
  name: string;
  fields: [string, ApiType][];
  methods: ApiMethod[];
  aliasOf?: string | null;
}
export interface ModuleMetadata {
  identity: string;
  profile: string;
  interfaces: ApiInterface[];
  laws: { name: string; statement: string; assurance: string }[];
  settings: [string, string][];
}
