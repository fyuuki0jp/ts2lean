import type { Expr, Term, ModuleIR } from "./compiler.js";
import type { Shape } from "./types.js";
export const leanName = (name: string): string =>
  name
    .split(".")
    .map((n) => `«${n}»`)
    .join(".");
export const leanType = (shape: Shape): string =>
  shape.kind === "int"
    ? "Int"
    : shape.kind === "string" || shape.kind === "literal"
      ? "String"
      : shape.kind === "bool"
        ? "Bool"
        : leanName(shape.lean);
export function emitExpr(expr: Expr): string {
  switch (expr.kind) {
    case "literal":
      return expr.shape.kind === "int"
        ? `(${expr.value} : Int)`
        : expr.shape.kind === "literal"
          ? JSON.stringify(expr.value)
          : expr.value;
    case "variant":
      return `(${leanName(expr.constructor)} ${expr.values.map(emitExpr).join(" ")})`;
    case "match":
      return `(match ${emitExpr(expr.object)} with ${expr.branches.map((b) => `| ${leanName(b.constructor)} ${b.names.join(" ")} => ${emitExpr(b.value)}`).join(" ")})`;
    case "variable":
      return expr.name;
    case "field":
      return `(${emitExpr(expr.object)}).${leanName(expr.name)}`;
    case "record":
      return `({ ${expr.fields.map((f) => `${leanName(f.name)} := ${emitExpr(f.value)}`).join(", ")} } : ${leanType(expr.shape)})`;
    case "unary":
      return `(${expr.operator}${emitExpr(expr.value)})`;
    case "binary": {
      const op = expr.operator;
      const leanOp: Record<string, string> = {
        "===": "=",
        "!==": "≠",
        "<=": "≤",
        ">=": "≥",
      };
      const code = `(${emitExpr(expr.left)} ${leanOp[op] ?? op} ${emitExpr(expr.right)})`;
      return ["===", "!==", "<", "<=", ">", ">="].includes(op)
        ? `(decide ${code})`
        : code;
    }
    case "call":
      return `(Ts2LeanGenerated.${expr.fn} ${emitExpr(expr.argument)})`;
    case "conditional":
      return `(if ${emitExpr(expr.condition)} then ${emitExpr(expr.yes)} else ${emitExpr(expr.no)})`;
  }
}
function emitTerm(term: Term, indent = 2): string {
  const pad = " ".repeat(indent);
  switch (term.kind) {
    case "match":
      return `${pad}match ${emitExpr(term.object)} with\n${term.branches.map((b) => `${pad}| ${leanName(b.constructor)} ${b.names.join(" ")} =>\n${emitTerm(b.body, indent + 2)}`).join("\n")}`;
    case "return":
      return `${pad}${emitExpr(term.value)}`;
    case "let":
      return `${pad}let ${term.name} : ${leanType(term.value.shape)} := ${emitExpr(term.value)}\n${emitTerm(term.next, indent)}`;
    case "if":
      return `${pad}if ${emitExpr(term.condition)} then\n${emitTerm(term.yes, indent + 2)}\n${pad}else\n${emitTerm(term.no, indent + 2)}`;
  }
}
export function emitModel(ir: ModuleIR, specModule: string): string {
  return (
    `import Ts2Lean.Inspect\nimport ${specModule}\n\nnamespace Ts2LeanGenerated\n\n` +
    ir.records
      .map(
        (r) =>
          `structure ${leanName(r.lean.split(".").at(-1)!)} where\n${r.fields.map((f) => `  ${leanName(f.name)} : ${leanType(f.shape)}`).join("\n")}\n`,
      )
      .join("\n") +
    ir.functions
      .map(
        (f) =>
          `\n-- Source: ${JSON.stringify(f.source)}\ndef ${f.name} (${f.parameter} : ${leanType(f.input)}) : ${leanType(f.output)} :=\n${emitTerm(f.body)}\n`,
      )
      .join("") +
    "\nend Ts2LeanGenerated\n"
  );
}
export function emitProof(
  ir: ModuleIR,
  contract: string,
  heartbeats: number,
  definitions: string[],
): string {
  const unfold = [
    "Ts2Lean.Satisfies",
    ...definitions.map(leanName),
    leanName(contract),
    ...ir.functions.map((f) => `Ts2LeanGenerated.${f.name}`),
  ];
  return `import Model\n\nset_option maxHeartbeats ${heartbeats}\n\ntheorem ts2lean_verified : Ts2Lean.Satisfies ${leanName(contract)} Ts2LeanGenerated.${ir.target} := by\n  simp_all [${unfold.join(", ")}]\n  all_goals intros\n  all_goals repeat' (split at *)\n  all_goals try simp_all [Bool.and_assoc, Bool.or_assoc]\n  all_goals omega\n\n#ts2lean_audit ts2lean_verified\n`;
}
