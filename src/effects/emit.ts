import type { EffectIR, Parameter } from "./compiler.js";
import { emitStatements } from "./structured.js";

const binders = (ps: Parameter[]) =>
  ps.map((p) => `(${p.name} : ${p.type})`).join(" ");
const names = (ps: Parameter[]) => ps.map((p) => p.name).join(" ");

/** Every relation alternative is an actual successful symbolic callback path. */
export function emitEffects(
  ir: EffectIR,
  module: string,
  contract: string,
  operation: boolean,
  heartbeats: number,
  semanticsOnly = false,
): string {
  const sys = operation ? `(${contract}).system` : contract;
  const out = [
    `import ${module}`,
    `import Ts2Lean.Inspect`,
    `import Ts2Lean.LedgerEffects`,
    `open Ts2Lean.Ledger`,
    `open Ts2Lean.Semantics Ts2Lean.LedgerEffects`,
    `set_option maxHeartbeats ${heartbeats}`,
    `set_option linter.unusedVariables false`,
    `set_option linter.unusedSimpArgs false`,
    `namespace GeneratedEffects`,
    `def spec : SystemContract := ${sys}`,
  ];
  const proofs: string[] = [];
  for (const site of ir.transactions) {
    out.push(
      `noncomputable def callback_${site.id} ${binders(site.captures)} : Statement := ${emitStatements(site.program)}`,
    );
    if (semanticsOnly) continue;
    for (const [i, p] of site.paths.entries()) {
      const id = `path_${site.id}_${i}`;
      const params = [...site.captures, ...p.variables];
      const hypotheses = p.conditions
        .map((c, j) => `(h${j} : ${c})`)
        .join("\n    ");
      const receipt =
        p.result.type === "request"
          ? `spec.receipt (${p.state}) ${p.result.lean}`
          : "True";
      out.push(`-- ${site.file}:${site.line}\n-- ${p.trace.join(" -> ")}`);
      out.push(`theorem ${id} (s : State) ${binders(params)} (h : spec.invariant s)\n    ${hypotheses} : spec.invariant (${p.state}) ∧ ${receipt} := by
  change invariant s at h
  ${p.conditions.map((_, j) => `try have reg${j} := registered_self h h${j}\n  try have key${j} := registered_id h h${j}\n  try have post${j} := ledger_registered h h${j}`).join("\n  ")}
  constructor
  · first
    | exact h
    | apply register_safe s _ h <;> first | assumption | (simp_all [valid] <;> omega)
    | apply settle_safe s _ h <;> first | assumption | omega
  · first
    | trivial
    | exact settled_persisted s _
    | exact lookup_mem (by assumption)`);
      if (p.result.type === "request" && site.expected) {
        out.push(`theorem ${id}_response (s : State) ${binders(params)} (h : spec.invariant s) ${hypotheses} : ${p.result.lean} = ${site.expected} := by
  change invariant s at h
  ${p.conditions.map((_, j) => `try have key${j} := registered_id h h${j}`).join("\n  ")}
  ${p.conditions.flatMap((_, j) => p.conditions.map((_, k) => `try have eq${j}_${k} := lookup_registered_eq h h${j} h${k}`)).join("\n  ")}
  simp only [not_or] at *
  cases ${site.expected}
  ${p.variables
    .filter((v) => v.type === "Request")
    .map((v) => `cases ${v.name}`)
    .join("\n  ")}
  simp_all`);
        proofs.push(`${id}_response`);
      }
      proofs.push(id);
    }
  }
  const constructors: string[] = [];
  const cases: string[] = [];
  const historyCases: string[] = [];
  for (const site of ir.transactions)
    for (const [i, p] of site.paths.entries()) {
      const params = [...site.captures, ...p.variables],
        id = `p${site.id}_${i}`;
      constructors.push(
        `  | ${id} (s : State) ${binders(params)} ${p.conditions.map((c, j) => `(h${j} : ${c})`).join(" ")} : CallbackModel s ${p.result.type === "request" ? `(some ${p.result.lean})` : "none"} (${p.state})`,
      );
      cases.push(
        `  | ${id} ${["s", ...params.map((p) => p.name), ...p.conditions.map((_, j) => `h${j}`)].join(" ")} =>\n    exact path_${site.id}_${i} s ${names(params)} h ${p.conditions.map((_, j) => `h${j}`).join(" ")}`,
      );
      historyCases.push(
        `  | ${id} => simp_all [persisted, insertTransfer, insertRequest, setBalance]`,
      );
    }
  out.push(
    `inductive CallbackModel : Callback where\n${constructors.join("\n")}`,
  );
  const completionConstructors: string[] = [],
    normalCases: string[] = [],
    returnCases: string[] = [];
  for (const site of ir.transactions) {
    let pathIndex = 0;
    for (const [i, p] of site.completions.entries()) {
      const params = [...site.captures, ...p.variables];
      const completed =
        p.control === "throw"
          ? `(.thrown (${p.result.lean}))`
          : p.control === "return"
            ? `(.returned ${p.result.type === "request" ? `(some ${p.result.lean})` : "none"})`
            : "(.normal ())";
      completionConstructors.push(
        `  | c${site.id}_${i} (s : State) ${binders(params)} ${p.conditions.map((c, j) => `(h${j} : ${c})`).join(" ")} : CompletionModel s ${completed} (${p.state})`,
      );
      if (p.control !== "throw") {
        const branch = `  | c${site.id}_${i} ${[...params.map((p) => p.name), ...p.conditions.map((_, j) => `h${j}`)].join(" ")} => exact CallbackModel.p${site.id}_${pathIndex} s ${names(params)} ${p.conditions.map((_, j) => `h${j}`).join(" ")}`;
        (p.control === "normal" ? normalCases : returnCases).push(branch);
        pathIndex++;
      }
    }
  }
  out.push(
    `inductive CompletionModel : State → Completion Unit (Option Request) ExceptionValue → State → Prop where\n${completionConstructors.join("\n")}`,
  );
  out.push(`theorem completion_normal (s t : State) (execution : CompletionModel s (.normal ()) t) : CallbackModel s none t := by
  cases execution ${normalCases.length ? "with" : ""}
${normalCases.join("\n")}`);
  out.push(`theorem completion_returned (s t : State) (r : Option Request) (execution : CompletionModel s (.returned r) t) : CallbackModel s r t := by
  cases execution ${returnCases.length ? "with" : ""}
${returnCases.join("\n")}`);
  const reduction =
    "Program.bind, Program.pure, Program.returnValue, Program.throwValue, Program.branch, Program.tryCatch, Program.tryFinally, Program.finish, Program.awaitRead, Program.awaitWrite, Program.successPost, requestGet, ledgerGet, balanceGet, balanceSet, requestInsert, ledgerInsert";
  for (const site of ir.transactions) {
    const alternatives = site.completions
      .map((p, i) => {
        const substitutions = new Map<string, string>();
        const replace = (s: string) =>
          s.replace(/\bv\d+\b/g, (name) => substitutions.get(name) ?? name);
        for (const v of p.variables) {
          const read = p.conditions.find((c) =>
            c.endsWith(` = some ${v.name}`),
          );
          substitutions.set(
            v.name,
            v.type === "ExceptionValue"
              ? new RegExp(`\\b${v.name}\\b`).test(p.result.lean)
                ? "_"
                : "ExceptionValue.undefined"
              : read
                ? `(requestValue (${replace(read.slice(0, -` = some ${v.name}`.length))}))`
                : v.name,
          );
        }
        return `| (apply CompletionModel.c${site.id}_${i} s ${names(site.captures)} ${p.variables.map((v) => substitutions.get(v.name)).join(" ")} <;> (solve | simp_all))`;
      })
      .join(" ");
    out.push(`theorem callback_${site.id}_covered ${binders(site.captures)} (s : State) :
    (callback_${site.id} ${names(site.captures)}).wp (fun c t => CompletionModel s c t) s := by
  classical
  simp only [callback_${site.id}, ${reduction}]
  repeat' first
    | (solve | simp_all [Program.finish])
    | (solve | first ${alternatives || "| assumption"})
    | apply And.intro
    | intro h
    | split`);
    out.push(`theorem callback_${site.id}_completion_refines ${binders(site.captures)} (s t : State) (c : Completion Unit (Option Request) ExceptionValue)
    (execution : (callback_${site.id} ${names(site.captures)}).exec s c t) : CompletionModel s c t := by
  exact (callback_${site.id} ${names(site.captures)}).sound _ s (callback_${site.id}_covered ${names(site.captures)} s) c t execution`);
    out.push(`theorem callback_${site.id}_refines ${binders(site.captures)} (s t : State) (r : Option Request)
    (execution : (callback_${site.id} ${names(site.captures)}).successful s r t) : CallbackModel s r t := by
  rcases execution with ⟨rfl, he⟩ | he
  · exact completion_normal s t (callback_${site.id}_completion_refines ${names(site.captures)} s t _ he)
  · exact completion_returned s t r (callback_${site.id}_completion_refines ${names(site.captures)} s t _ he)`);
    proofs.push(
      `callback_${site.id}_completion_refines`,
      `callback_${site.id}_refines`,
    );
  }
  if (semanticsOnly) {
    out.push(
      "-- Extraction certificate only: this does not establish the application invariant.",
      ...proofs.map((p) => `#ts2lean_audit ${p}`),
      "end GeneratedEffects",
    );
    return out.join("\n\n") + "\n";
  }
  out.push(
    `inductive ExtractedCallback : Callback where\n${ir.transactions.map((site) => `  | site${site.id} ${binders(site.captures)} (s t : State) (r : Option Request) (execution : (callback_${site.id} ${names(site.captures)}).successful s r t) : ExtractedCallback s r t`).join("\n")}`,
  );
  out.push(`theorem callback_refines_paths (s t : State) (r : Option Request) (execution : ExtractedCallback s r t) : CallbackModel s r t := by
  cases execution with
${ir.transactions.map((site) => `  | site${site.id} ${names(site.captures)} s t r execution => exact callback_${site.id}_refines ${names(site.captures)} s t r execution`).join("\n")}`);
  out.push(`theorem callback_safe (s t : State) (r : Option Request) (h : spec.invariant s)
    (execution : ExtractedCallback s r t) : spec.invariant t ∧ (match r with | none => True | some v => spec.receipt t v) := by
  have execution := callback_refines_paths s t r execution
  cases execution ${cases.length ? "with" : ""}
${cases.join("\n")}`);
  out.push(`theorem callback_retains_receipt (s t : State) (result : Option Request) (r : Request)
    (h : persisted s r) (execution : ExtractedCallback s result t) : persisted t r := by
  have execution := callback_refines_paths s t result execution
  cases execution ${historyCases.length ? "with" : ""}
${historyCases.join("\n")}`);
  out.push(`def Step (db : DatabaseRuntime) (s t : State) : Prop :=
  ∃ phase result, spec.allow phase ∧ db.run ExtractedCallback phase s result t

theorem step_safe (db : DatabaseRuntime) (laws : DatabaseLaws db) (s t : State)
    (h : spec.invariant s) (step : Step db s t) : spec.invariant t := by
  obtain ⟨phase, result, _, he⟩ := step
  cases phase with
  | committed | returned | lostResponse =>
    exact (callback_safe s t result h (laws.atomic _ _ _ _ _ he (by simp))).1
  | aborted | crashedBeforeCommit | restarted =>
    obtain ⟨rfl, _⟩ := laws.rollback _ _ _ _ _ he (by simp)
    exact h

theorem all_executions (db : DatabaseRuntime) (laws : DatabaseLaws db) (s t : State)
    (start : spec.initial s) (execution : Reachable (Step db) s t) : spec.invariant t := by
  have hs : spec.invariant s := initial_safe s start
  exact induction_safe spec.invariant (Step db) (step_safe db laws) hs execution

theorem successful_response (db : DatabaseRuntime) (laws : DatabaseLaws db) (s t : State) (r : Request)
    (h : spec.invariant s) (execution : db.run ExtractedCallback .returned s (some r) t) : spec.receipt t r := by
  exact (callback_safe s t (some r) h (laws.atomic _ _ _ _ _ execution (by simp))).2`);
  out.push(`theorem step_retains_receipt (db : DatabaseRuntime) (laws : DatabaseLaws db)
    (r : Request) (s t : State) (h : persisted s r) (step : Step db s t) : persisted t r := by
  obtain ⟨phase, result, _, he⟩ := step
  cases phase with
  | committed | returned | lostResponse =>
    exact callback_retains_receipt s t result r h (laws.atomic _ _ _ _ _ he (by simp))
  | aborted | crashedBeforeCommit | restarted =>
    obtain ⟨rfl, _⟩ := laws.rollback _ _ _ _ _ he (by simp)
    exact h

theorem durable_receipts (db : DatabaseRuntime) (laws : DatabaseLaws db) (s t : State) (r : Request)
    (posted : persisted s r) (execution : Reachable (Step db) s t) : persisted t r := by
  exact induction_safe (fun s => persisted s r) (Step db) (step_retains_receipt db laws r) posted execution`);
  for (const [i, o] of ir.retryObligations.entries()) {
    out.push(
      `theorem retry_${i} (s : State) ${binders(o.parameters)} (h : spec.invariant s) ${(o.conditions ?? []).map((c, j) => `(h${j} : ${c})`).join(" ")} : ${o.actual} = ${o.original} := by
  change invariant s at h
  ${(o.conditions ?? []).map((_, j) => `try have key${j} := registered_id h h${j}`).join("\n  ")}
  simp_all`,
    );
    proofs.push(`retry_${i}`);
  }
  for (const [i, o] of ir.returnObligations.entries()) {
    out.push(
      `theorem return_${i} (s : State) ${binders(o.parameters)} (h : spec.invariant s) : spec.receipt s ${o.result} := by simp_all [spec]`,
    );
    proofs.push(`return_${i}`);
  }
  out.push(
    ...[
      ...proofs,
      "all_executions",
      "successful_response",
      "durable_receipts",
    ].map((p) => `#ts2lean_audit ${p}`),
  );
  out.push("end GeneratedEffects");
  return out.join("\n\n") + "\n";
}
