import type { Expr, Term, ModuleIR } from "./compiler.js";
import type { Shape } from "./types.js";
export const leanName = (name: string): string =>
  name
    .split(".")
    .map((n) => `«${n}»`)
    .join(".");
export const leanType = (shape: Shape): string =>
  shape.kind === "array" ? `(List ${leanType(shape.element)})` : shape.kind === "optional" ? `(Option ${leanType(shape.element)})` :
  shape.kind === "safeinteger" ? "Ts2Lean.SafeInteger" : shape.kind === "snapshot" ? "Ts2Lean.Snapshot" :
  shape.kind === "unit" ? "Unit" : shape.kind === "jsstring" ? "Ts2Lean.JSString" : shape.kind === "int"
    ? "Int"
    : shape.kind === "never"
      ? "Empty"
    : shape.kind === "literal" && typeof shape.value === "boolean"
      ? "Bool"
    : shape.kind === "string" || shape.kind === "literal"
      ? "String"
      : shape.kind === "bool"
        ? "Bool"
        : leanName(shape.lean);

/** Only a totalization placeholder: every executed access has an independently
audited in-bounds obligation, so this value cannot affect a certified execution. */
export function defaultValue(shape:Shape):string {
  switch(shape.kind) {
    case "int":return "(0 : Int)";
    case "bool":return "false";
    case "unit":return "()";
    case "jsstring":return "({units := []} : Ts2Lean.JSString)";
    case "safeinteger":return "({value := 0} : Ts2Lean.SafeInteger)";
    case "snapshot":return "({identity := 0, json := none} : Ts2Lean.Snapshot)";
    case "string":return '""';
    case "literal":return typeof shape.value==="boolean"?String(shape.value):JSON.stringify(shape.value);
    case "array":return `([] : ${leanType(shape)})`;
    case "optional":return `(none : ${leanType(shape)})`;
    case "record":return `({${shape.fields.map(f=>`${leanName(f.name)} := ${defaultValue(f.shape)}`).join(", ")}} : ${leanType(shape)})`;
    case "union": {const v=shape.variants[0]!;return `(${leanName(v.constructor)} ${v.fields.map(f=>defaultValue(f.shape)).join(" ")})`;}
    case "never":throw Error("Cannot totalize an uninhabited array element");
  }
}
export function emitExpr(expr: Expr): string {
  switch (expr.kind) {
    case "evaluated":return `(let _ := ${emitExpr(expr.before)}; ${emitExpr(expr.value)})`;
    case "builtin": {
      const a=expr.args.map(emitExpr);
      switch(expr.operation) {
        case "array":return `([${a.join(", ")}] : ${leanType(expr.shape)})`;
        case "append":return `(${a[0]} ++ ${a[1]})`;
        case "length":return `(Ts2Lean.JSArray.length ${a[0]})`;
        case "slice":return `(Ts2Lean.JSArray.slice ${a[0]} ${a[1]} ${a[2]?`(some ${a[2]})`:"none"})`;
        case "index":case "at":return `(Ts2Lean.JSArray.get ${a[0]} ${expr.operation==="at"?`(Ts2Lean.JSArray.atIndex ${a[0]} ${a[1]})`:`(${a[1]}).value`} ${defaultValue(expr.shape)})`;
        case "stringify":return `(${a[0]}).json`;
        case "some":return `(some ${a[0]})`;
      }
    }
    case "literal":
      return expr.shape.kind === "safeinteger" ? `({value := ${expr.value}} : Ts2Lean.SafeInteger)` : expr.shape.kind === "jsstring"
        ? `({ units := [${Array.from({length:expr.value.length}, (_, i) => expr.value.charCodeAt(i)).join(", ")}] } : Ts2Lean.JSString)`
        : expr.shape.kind === "int"
        ? `(${expr.value} : Int)`
        : expr.shape.kind === "literal" && typeof expr.shape.value === "string"
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
      if(expr.shape.kind==="safeinteger")return `(Ts2Lean.SafeInteger.neg ${emitExpr(expr.value)})`;
      return `(${expr.operator}${emitExpr(expr.value)})`;
    case "binary": {
      const op = expr.operator;
      const leanOp: Record<string, string> = {
        "===": "=",
        "!==": "≠",
        "<=": "≤",
        ">=": "≥",
      };
      const left=emitExpr(expr.left),right=emitExpr(expr.right);
      const code = expr.left.shape.kind==="safeinteger"
        ? `((${left}).value ${leanOp[op]??op} (${right}).value)`
        : `(${left} ${leanOp[op] ?? op} ${right})`;
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

const and=(parts:string[]):string=>parts.length?`(${parts.join(" ∧ ")})`:"True";
export function shapeDomain(shape:Shape,value:string,depth=0):string {
  if(shape.kind==="safeinteger")return `Ts2Lean.SafeInteger.valid (${value})`;
  if(shape.kind==="array")return and([`Ts2Lean.JSArray.validLength (${value})`,`∀ x${depth} ∈ (${value}), ${shapeDomain(shape.element,`x${depth}`,depth+1)}`]);
  if(shape.kind==="optional")return `∀ x${depth} ∈ (${value}), ${shapeDomain(shape.element,`x${depth}`,depth+1)}`;
  if(shape.kind==="record")return and(shape.fields.map(f=>shapeDomain(f.shape,`(${value}).${leanName(f.name)}`,depth+1)));
  if(shape.kind==="union")return `(match ${value} with ${shape.variants.map(v=>{
    const names=v.fields.map((_,i)=>`d${depth}_${i}`);
    return `| ${leanName(v.constructor)} ${names.join(" ")} => ${and(v.fields.map((f,i)=>shapeDomain(f.shape,names[i]!,depth+1)))}`;
  }).join(" ")})`;
  return "True";
}
export function emitExprSafe(expr:Expr):string {
  switch(expr.kind) {
    case "evaluated":return and([emitExprSafe(expr.before),emitExprSafe(expr.value)]);
    case "variable":case "literal":return "True";
    case "field":return emitExprSafe(expr.object);
    case "unary":return emitExprSafe(expr.value);
    case "record":return and(expr.fields.map(f=>emitExprSafe(f.value)));
    case "variant":return and(expr.values.map(emitExprSafe));
    case "call":return and([emitExprSafe(expr.argument),`Ts2LeanGenerated.${expr.fn}_safe ${emitExpr(expr.argument)}`]);
    case "conditional":return and([emitExprSafe(expr.condition),`if ${emitExpr(expr.condition)} then ${emitExprSafe(expr.yes)} else ${emitExprSafe(expr.no)}`]);
    case "match":return and([emitExprSafe(expr.object),`(match ${emitExpr(expr.object)} with ${expr.branches.map(b=>`| ${leanName(b.constructor)} ${b.names.join(" ")} => ${emitExprSafe(b.value)}`).join(" ")})`]);
    case "binary":return and([emitExprSafe(expr.left),expr.operator==="&&"?`if ${emitExpr(expr.left)} then ${emitExprSafe(expr.right)} else True`:expr.operator==="||"?`if ${emitExpr(expr.left)} then True else ${emitExprSafe(expr.right)}`:emitExprSafe(expr.right)]);
    case "builtin": {
      const checks=expr.args.map(emitExprSafe),a=expr.args.map(emitExpr);
      if(expr.operation==="index"||expr.operation==="at")checks.push(`Ts2Lean.JSArray.inBounds ${a[0]} ${expr.operation==="at"?`(Ts2Lean.JSArray.atIndex ${a[0]} ${a[1]})`:`(${a[1]}).value`}`);
      if(expr.operation==="array"||expr.operation==="append")checks.push(`Ts2Lean.JSArray.validLength ${emitExpr(expr)}`);
      return and(checks);
    }
  }
}
export function emitTermSafe(term:Term):string {
  switch(term.kind) {
    case "return":return emitExprSafe(term.value);
    case "let":return and([emitExprSafe(term.value),`(let ${term.name} : ${leanType(term.value.shape)} := ${emitExpr(term.value)}; ${emitTermSafe(term.next)})`]);
    case "if":return and([emitExprSafe(term.condition),`if ${emitExpr(term.condition)} then ${emitTermSafe(term.yes)} else ${emitTermSafe(term.no)}`]);
    case "match":return and([emitExprSafe(term.object),`(match ${emitExpr(term.object)} with ${term.branches.map(b=>`| ${leanName(b.constructor)} ${b.names.join(" ")} => ${emitTermSafe(b.body)}`).join(" ")})`]);
    case "await":throw Error("Snapshot safety for async terms is not supported");
  }
}
export function emitTerm(term: Term, indent = 2): string {
  const pad = " ".repeat(indent);
  switch (term.kind) {
    case "await": throw new Error("Async term requires the port emitter");
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
export function emitDataDeclarations(ir: ModuleIR): string {
  return (ir.declarations ?? ir.records).map(s => s.kind === "record"
    ? `structure ${leanName(s.lean.split(".").at(-1)!)} where\n${s.fields.map(f => `  ${leanName(f.name)} : ${leanType(f.shape)}`).join("\n")}\n`
    : `inductive ${leanName(s.lean.split(".").at(-1)!)} where\n${s.variants.map(v =>
      `  | ${leanName(v.constructor.split(".").at(-1)!)}${v.fields.map(f => ` (${leanName(f.name)} : ${leanType(f.shape)})`).join("")}`).join("\n")}\n`
  ).join("\n");
}

export function emitModel(ir: ModuleIR, specModule: string): string {
  return (
    `import Ts2Lean.Inspect\nimport ${specModule}\n\nnamespace Ts2LeanGenerated\n\n` +
    emitDataDeclarations(ir) +
    ir.functions
      .map(
        (f) =>
          `\n-- Source: ${JSON.stringify(f.source)}\ndef ${f.name} (${f.parameter} : ${leanType(f.input)}) : ${leanType(f.output)} :=\n${emitTerm(f.body)}\n`+
          (ir.dataProfile?`\ndef ${f.name}_safe (${f.parameter} : ${leanType(f.input)}) : Prop :=\n  ${emitTermSafe(f.body)}\n`:""),
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
  if(ir.dataProfile)return emitSnapshotProof(ir,contract,heartbeats,definitions,false);
  const unfold = [
    "Ts2Lean.Satisfies",
    ...definitions.map(leanName),
    leanName(contract),
    ...ir.functions.map((f) => `Ts2LeanGenerated.${f.name}`),
  ];
  // Keep the arithmetic fast path; grind also discharges boolean implications
  // and disjunctions that omega alone cannot derive. Both produce checked proofs.
  return `import Model\n\nset_option maxHeartbeats ${heartbeats}\n\ntheorem ts2lean_verified : Ts2Lean.Satisfies ${leanName(contract)} Ts2LeanGenerated.${ir.target} := by\n  simp_all [${unfold.join(", ")}]\n  all_goals intros\n  all_goals repeat' (split at *)\n  all_goals try simp_all [Bool.and_assoc, Bool.or_assoc]\n  all_goals first | omega | grind\n\n#ts2lean_audit ts2lean_verified\n`;
}

export function emitStateMachineProof(ir: ModuleIR, contract: string, heartbeats: number, definitions: string[]): string {
  if(ir.dataProfile)return emitSnapshotProof(ir,contract,heartbeats,definitions,true);
  const c = leanName(contract), f = `Ts2LeanGenerated.${ir.target}`;
  const unfold = [...new Set([c, ...definitions.map(leanName), ...ir.functions.map(f=>`Ts2LeanGenerated.${f.name}`)])];
  const proof = `by\n  simp_all [${unfold.join(", ")}]\n  all_goals intros\n  all_goals repeat' (split at *)\n  all_goals try simp_all [Bool.and_assoc, Bool.or_assoc]\n  all_goals first | omega | grind`;
  return `import Model
set_option maxHeartbeats ${heartbeats}
theorem ts2lean_initial_nonempty : ∃ s, ${c}.initial s := ${c}.initialWitness
theorem ts2lean_state_projection : ${c}.state = (fun i => i.state) := rfl
theorem ts2lean_initial_safe : ∀ s, ${c}.initial s → ${c}.invariant s := ${proof}
theorem ts2lean_step_preserves : ∀ i, ${c}.admissible i → ${c}.invariant (${c}.state i) → ${c}.invariant (${f} i) := ${proof}
theorem ts2lean_all_executions : ∀ s t, ${c}.initial s →
    Ts2Lean.FiniteSteps (${c}.transition ${f}) s t → ${c}.invariant t := by
  intro s t initial steps
  exact Ts2Lean.StateMachine.finite_safe ${c} ${f} ts2lean_initial_safe ts2lean_step_preserves initial steps
#ts2lean_audit ts2lean_initial_nonempty
#ts2lean_audit ts2lean_state_projection
#ts2lean_audit ts2lean_initial_safe
#ts2lean_audit ts2lean_step_preserves
#ts2lean_audit ts2lean_all_executions
`;
}

function emitSnapshotProof(ir:ModuleIR,contract:string,heartbeats:number,definitions:string[],machine:boolean):string {
  const c=leanName(contract),f=`Ts2LeanGenerated.${ir.target}`,target=ir.functions.find(fn=>fn.name===ir.target)!;
  const unfold=[c,...definitions.map(leanName),...ir.functions.flatMap(f=>[`Ts2LeanGenerated.${f.name}`,`Ts2LeanGenerated.${f.name}_safe`]),
    "Ts2Lean.JSArray.length","Ts2Lean.JSArray.slice","Ts2Lean.JSArray.relative","Ts2Lean.JSArray.atIndex",
    "Ts2Lean.JSArray.inBounds","Ts2Lean.JSArray.get","Ts2Lean.JSArray.validLength","Ts2Lean.SafeInteger.neg","Ts2Lean.SafeInteger.valid"];
  const proof=`by\n  simp_all [${unfold.join(", ")}]\n  all_goals intros\n  all_goals repeat' (split at *)\n  all_goals simp_all [← List.length_eq_zero_iff, ← Int.sub_eq_add_neg]\n  all_goals try simp (disch := omega) [Nat.min_eq_left, ← List.length_eq_zero_iff, List.getLast?_eq_getElem?, List.head?_eq_getElem?, List.dropLast_eq_take] at *\n  all_goals first | omega | grind`;
  const header=`import Model\nset_option maxHeartbeats ${heartbeats}\n`;
  const domain=shapeDomain(target.input,"i"),outDomain=shapeDomain(target.output,`${f} i`);
  if(!machine)return header+`theorem ts2lean_verified : ∀ i, ${domain} → ${c}.pre i →
    ${f}_safe i ∧ ${outDomain} ∧ ${c}.post i (${f} i) := ${proof}
#ts2lean_audit ts2lean_verified
`;
  return header+`theorem ts2lean_initial_nonempty : ∃ s, ${c}.initial s := ${c}.initialWitness
theorem ts2lean_state_projection : ${c}.state = (fun i => i.state) := rfl
theorem ts2lean_initial_safe : ∀ s, ${c}.initial s → ${c}.invariant s := ${proof}
theorem ts2lean_step_checked : ∀ i, ${domain} → ${c}.admissible i → ${c}.invariant (${c}.state i) →
    ${f}_safe i ∧ ${outDomain} ∧ ${c}.invariant (${f} i) := ${proof}
def ts2lean_transition (s t : ${leanType(target.output)}) : Prop :=
  ∃ i, ${domain} ∧ ${c}.admissible i ∧ ${c}.state i = s ∧ ${f} i = t
theorem ts2lean_all_executions : ∀ s t, ${c}.initial s →
    Ts2Lean.FiniteSteps ts2lean_transition s t → ${c}.invariant t := by
  intro s t initial steps
  induction steps with
  | refl => exact ts2lean_initial_safe _ initial
  | next _ step ih =>
    obtain ⟨i, domain, allowed, rfl, rfl⟩ := step
    exact (ts2lean_step_checked i domain allowed ih).2.2
#ts2lean_audit ts2lean_initial_nonempty
#ts2lean_audit ts2lean_state_projection
#ts2lean_audit ts2lean_initial_safe
#ts2lean_audit ts2lean_step_checked
#ts2lean_audit ts2lean_all_executions
`;
}
