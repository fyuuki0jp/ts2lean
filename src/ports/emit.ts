import type {ModuleIR, Term} from "../compiler.js";
import {emitExpr,emitTerm,emitDataDeclarations,leanName,leanType} from "../emit.js";
import type {ContractInfo} from "../types.js";
function term(t:Term, indent=2):string {
  const pad=" ".repeat(indent);
  switch(t.kind) {
    case "return":return `${pad}Ts2Lean.Semantics.Program.returnValue ${emitExpr(t.value)}`;
    case "let":return `${pad}let ${t.name} : ${leanType(t.value.shape)} := ${emitExpr(t.value)}\n${term(t.next,indent)}`;
    case "if":return `${pad}if ${emitExpr(t.condition)} then\n${term(t.yes,indent+2)}\n${pad}else\n${term(t.no,indent+2)}`;
    case "match":return `${pad}match ${emitExpr(t.object)} with\n${t.branches.map(b=>`${pad}| ${leanName(b.constructor)} ${b.names.join(" ")} =>\n${term(b.body,indent+2)}`).join("\n")}`;
    case "await": {
      const operation=t.call.kind==="port"
        ? `Ts2Lean.Ports.awaitPort ${leanName(t.call.target)} ${emitExpr(t.call.argument)}`
        : `Ts2Lean.Ports.invoke (Ts2LeanGenerated.${t.call.target} ${emitExpr(t.call.argument)})`;
      return `${pad}Ts2Lean.Semantics.Program.bind (${operation}) (fun ${t.name} =>\n${term(t.next,indent+2)})`;
    }
  }
}
export function portModel(ir:ModuleIR,c:ContractInfo,index:number):string {
  const w=c.world!;
  return `namespace Case${index}\nnamespace Ts2LeanGenerated\n`+
    emitDataDeclarations(ir)+
    ir.functions.map(f=>`def ${f.name} (${f.parameter} : ${leanType(f.input)}) : ${f.async ? `Ts2Lean.Semantics.Program (Ts2Lean.Ports.World ${leanName(w.state)} ${leanName(w.event)}) ${leanType(f.output)} ${leanName(w.error)} Unit` : leanType(f.output)} :=\n${f.async?term(f.body):emitTerm(f.body)}\n`).join("\n")+
    `end Ts2LeanGenerated\nend Case${index}\n`;
}
export function portProof(cases:{ir:ModuleIR;contract:ContractInfo}[], ports:ContractInfo[],heartbeats:number):string {
  const unfold=[...new Set([...cases.flatMap(c=>c.contract.unfold),...ports.flatMap(p=>p.unfold)].map(leanName))];
  const system=`${leanName(cases[0]!.contract.name)}.system`;
  const w=cases[0]!.contract.world!;
  const world=`Ts2Lean.Ports.World ${leanName(w.state)} ${leanName(w.event)}`;
  const definitions=cases.flatMap((c,i)=>c.ir.functions.map(f=>`Case${i}.Ts2LeanGenerated.${f.name}`));
  const defs=[...unfold,...definitions,"Ts2Lean.Semantics.Program.wp_bind","Ts2Lean.Semantics.Program.wp_returnValue","Ts2Lean.Ports.wp_awaitPort","Ts2Lean.Ports.after","Ts2Lean.Ports.outcomeCompletion","Ts2Lean.Ports.wp_invoke"];
  const simplify=`simp_all (maxSteps := ${heartbeats}) [${defs.join(", ")}]`;
  const tactic=`by\n  ${simplify}\n  all_goals intros\n  all_goals repeat' (first | intro _ | (split at * <;> try ${simplify}))\n  all_goals try simp_all\n  all_goals first | omega | grind`;
  let code=`import Model\nset_option linter.unusedSimpArgs false\nset_option maxHeartbeats ${heartbeats}\n`;
  code+=`theorem initial_nonempty : ∃ w, ${system}.initial w := ${system}.initialWitness\n`;
  code+=`theorem initial_safe : ∀ w, ${system}.initial w → ${system}.invariant w := ${tactic}\n`;
  for(const [i,c] of cases.entries()) {
    const contract=leanName(c.contract.name),f=`Case${i}.Ts2LeanGenerated.${c.ir.target}`;
    code+=`theorem system_${i}_same : ${contract}.system = ${system} := rfl\n`;
    code+=`theorem case_${i}_wp : ∀ input w, ${system}.invariant w → (${f} input).wp (fun out t => ${system}.invariant t ∧ ${contract}.post input w out t) w := ${tactic}\n`;
    code+=`theorem case_${i}_all : ∀ input w out t, ${system}.invariant w → (${f} input).exec w out t → ${system}.invariant t ∧ ${contract}.post input w out t := by\n  intro input w out t hi he\n  exact (${f} input).sound _ _ (case_${i}_wp input w hi) _ _ he\n`;
    code+=`#ts2lean_audit case_${i}_all\n`;
  }
  code+=`def operationStep (s t : ${world}) : Prop := ${cases.map((c,i)=>`Ts2Lean.Ports.transition Case${i}.Ts2LeanGenerated.${c.ir.target} s t`).join(" ∨ ")}\n`;
  code+=`theorem step_preserves : ∀ s t, ${system}.invariant s → operationStep s t → ${system}.invariant t := by\n  intro s t hi he\n  ${cases.length>1?`rcases he with ${cases.map((_,i)=>`h${i}`).join(" | ")}`:""}\n`;
  for(const [i] of cases.entries())code+=`${cases.length>1?"  ·":" "} obtain ⟨input, out, exec⟩ := ${cases.length>1?`h${i}`:"he"}\n${cases.length>1?"    ":"  "}exact (case_${i}_all input s out t hi exec).1\n`;
  code+=`theorem all_executions : ∀ s t, ${system}.initial s → Ts2Lean.FiniteSteps operationStep s t → ${system}.invariant t := by\n  intro s t hi hs\n  exact Ts2Lean.Ports.finite_safe _ _ _ initial_safe step_preserves hi hs\n#ts2lean_audit initial_nonempty\n#ts2lean_audit initial_safe\n#ts2lean_audit all_executions\n`;
  return code;
}
