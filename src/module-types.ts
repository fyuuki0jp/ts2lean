import {
  Failure,
  type ApiType,
  type ContractInfo,
  type ModuleMetadata,
} from "./types.js";
export function apiType(t: ApiType): string {
  switch (t.kind) {
    case "string":
    case "bigint":
    case "boolean":
    case "void":
      return t.kind;
    case "named":
      if (!/^[A-Za-z_]\w*$/.test(t.name!))
        throw new Failure("spec-error", "Invalid API name");
      return t.name!;
    case "nullable":
      return `(${apiType(t.arguments![0]!)} | null)`;
    case "promise":
      return `Promise<${apiType(t.arguments![0]!)}>`;
    case "array":
      return `ReadonlyArray<${apiType(t.arguments![0]!)}>`;
    case "callback":
      return `(${t.arguments!.map((a, i) => `arg${i}: ${apiType(a)}`).join(", ")}) => ${apiType(t.result!)}`;
    default:
      throw new Failure("unsupported", `Unknown module API type: ${t.kind}`);
  }
}
export function moduleTypes(info: ContractInfo): string {
  const m = info.module!;
  return m.interfaces
    .map((i) => {
      if (i.aliasOf) return `export type ${i.name} = ${i.aliasOf};`;
      return `export interface ${i.name} {\n${i.fields.map(([n, t]) => `readonly ${JSON.stringify(n)}: ${apiType(t)};`).join("\n")}\n${i.methods.map((method) => `${method.name}${method.generics.length ? `<${method.generics.join(",")}>` : ""}(${method.parameters.map(([n, t]) => `${n}: ${apiType(t)}`).join(",")}): ${apiType(method.result)};`).join("\n")}\n}`;
    })
    .join("\n");
}
export function effectTypes(info: ContractInfo): string {
  const name = info.name.split(".").at(-1)!;
  const request =
    "{ readonly operationId: string; readonly from: string; readonly to: string; readonly amount: bigint }";
  return `export declare const ${name}: { readonly kind: "ts2lean.contract"; readonly profile: "${info.kind}"; readonly spec: string; readonly name: string; readonly root: string; readonly options: {}; ${info.kind === "operation" ? `readonly types?: { readonly input: ${request}; readonly output: Promise<${request}> };` : ""} };`;
}
