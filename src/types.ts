export type Shape =
  | { kind: "int" }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "record"; lean: string; fields: { name: string; shape: Shape }[] };
export interface Binding {
  module: string;
  export: string;
  spec: string;
  contract: string;
}
export interface VerificationOptions {
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
  kind?: "pure" | "module" | "operation" | "system";
  module?: ModuleMetadata;
  name: string;
  input: Shape;
  output: Shape;
  unfold: string[];
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
  assumptions?: {
    identity: string;
    assurance: "assumed" | "proved";
    laws: { name: string; statement: string; assurance: string }[];
    settings: Record<string, string>;
    declaration: string;
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
  return s.kind === "record"
    ? JSON.stringify(
        s.fields
          .map((f) => [f.name, shapeKey(f.shape)])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      )
    : s.kind;
}
export function tsType(s: Shape): string {
  return s.kind === "int"
    ? "bigint"
    : s.kind === "string"
      ? "string"
      : s.kind === "bool"
        ? "boolean"
        : `{ ${s.fields.map((f) => `readonly ${JSON.stringify(f.name)}: ${tsType(f.shape)}`).join("; ")} }`;
}

/** A runtime reference to a Lean contract, created by the Vite plugin. */
export interface LeanContract<Input = unknown, Output = unknown> {
  readonly kind: "ts2lean.contract";
  readonly profile?: "pure" | "module" | "operation" | "system";
  readonly spec: string;
  readonly name: string;
  readonly root: string;
  readonly options: VerificationOptions;
  /** Phantom type information; no input is sampled or executed. */
  readonly types?: { readonly input: Input; readonly output: Output };
}

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
