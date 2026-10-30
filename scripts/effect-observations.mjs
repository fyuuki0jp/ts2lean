import { ts } from "@ts-morph/common";
export const input = {
  operationId: "case",
  from: "alice",
  to: "bob",
  amount: 1n,
};
export const wrap = (body) => `import { db } from "../database.ts";
import type { TransferRequest } from "../Database.lean";
export async function scenario(requestInput: TransferRequest) {
  const input={...requestInput};
  return await db.transaction(async tx => {${body}});
}`;

function tag(value, thrown) {
  if (thrown) {
    if (value instanceof Error) return "throw:error:" + value.message;
    if (value === null) return "throw:null";
    if (value === undefined) return "throw:undefined";
    return (
      `throw:${typeof value === "bigint" ? "integer" : typeof value}:` +
      String(value)
    );
  }
  return value === undefined
    ? "return:undefined"
    : `return:request:${value.operationId}:${value.from}:${value.to}:${value.amount}`;
}

export async function nativeObservations(source, sites) {
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const observations = new Set();
  // Every encountered primitive can succeed, reject before, or reject after
  // its effect. Unused suffixes are harmless and deduplicated.
  for (let mask = 0; mask < 3 ** sites; mask++) {
    let remaining = mask,
      cursor = 0;
    const decisions = Array.from({ length: sites }, () => {
      const v = remaining % 3;
      remaining = Math.floor(remaining / 3);
      return v;
    });
    const balances = new Map([
        ["alice", 10n],
        ["bob", 0n],
      ]),
      requests = new Map(),
      ledger = [];
    const events = [];
    const argument = (v) =>
      v && typeof v === "object"
        ? JSON.stringify([v.operationId, v.from, v.to, String(v.amount)])
        : String(v);
    const effect = async (operation, args, action) => {
      const choice = decisions[cursor++] ?? 0;
      try {
        if (choice === 1) throw new Error("fault");
        const result = action();
        if (choice === 2) throw new Error("fault");
        events.push([operation, "ok", args.map(argument)]);
        return result;
      } catch (error) {
        events.push([operation, "throw", args.map(argument)]);
        throw error;
      }
    };
    const tx = {
      getBalance: (id) =>
        effect("balance.get", [id], () => balances.get(id) ?? 0n),
      setBalance: (id, amount) =>
        effect("balance.set", [id, amount], () => {
          balances.set(id, amount);
        }),
      getRequest: (id) =>
        effect("request.get", [id], () => requests.get(id) ?? null),
      insertRequest: (r) =>
        effect("request.insert", [r], () => {
          if (requests.has(r.operationId)) throw new Error("duplicate");
          requests.set(r.operationId, { ...r });
        }),
      getTransfer: (id) =>
        effect(
          "ledger.get",
          [id],
          () => ledger.find((r) => r.operationId === id) ?? null,
        ),
      insertTransfer: (r) =>
        effect("ledger.insert", [r], () => {
          if (ledger.some((p) => p.operationId === r.operationId))
            throw new Error("duplicate");
          ledger.push({ ...r });
        }),
    };
    const exports = {};
    new Function("require", "exports", code)(
      () => ({ db: { transaction: (cb) => cb(tx) } }),
      exports,
    );
    let completion;
    try {
      completion = tag(await exports.scenario({ ...input }), false);
    } catch (error) {
      completion = tag(error, true);
    }
    observations.add(
      JSON.stringify([
        completion,
        String(balances.get("alice")),
        String(balances.get("bob")),
        String([...balances.values()].reduce((a, b) => a + b, 0n)),
        requests.has("case") ? "yes" : "no",
        String(ledger.length),
        JSON.stringify(events),
        JSON.stringify(
          [...requests.values()].map((r) => [
            r.operationId,
            r.from,
            r.to,
            String(r.amount),
          ]),
        ),
        JSON.stringify(
          ledger.map((r) => [r.operationId, r.from, r.to, String(r.amount)]),
        ),
      ]),
    );
  }
  return [...observations].sort();
}

export function observationProgram(site) {
  const definitions = site.completions.map((p, i) => {
    const parameters = [...site.captures, ...p.variables]
      .map(
        (v) =>
          `let ${v.name} : ${v.type} := ${v.type === "Request" ? "request" : v.type === "ExceptionValue" ? 'ExceptionValue.error "fault"' : v.type === "Int" ? "0" : '""'}`,
      )
      .join("\n  ");
    const result =
      p.control === "throw"
        ? `exceptionTag (${p.result.lean})`
        : p.result.type === "request"
          ? `receiptTag (${p.result.lean})`
          : '"return:undefined"';
    return `def observation${i} : Option (List String) :=
  let s := initialState
  ${parameters}
  if ${p.conditions.length ? p.conditions.join(" ∧ ") : "True"} then
    let finalState := ${p.state}
    some [${result}, toString (finalState.balances "alice"), toString (finalState.balances "bob"), toString finalState.total, if finalState.requests "case" = none then "no" else "yes", toString finalState.ledger.length,
      (Lean.toJson ([${(p.events ?? []).join(",")}] : List Lean.Json)).compress,
      (Lean.toJson ((finalState.requests "case").toList.map requestFields)).compress,
      (Lean.toJson (finalState.ledger.map requestFields)).compress]
  else none`;
  });
  return `import Ts2Lean.Modules
import Ts2Lean.LedgerEffects
open Ts2Lean.Ledger Ts2Lean.LedgerEffects
def request : Request := ⟨"case","alice","bob",1⟩
def initialState : State := {opening := fun a => if a = "alice" then 10 else 0, balances := fun a => if a = "alice" then 10 else 0, initialTotal := 10, total := 10, requests := fun _ => none, ledger := []}
def exceptionTag : ExceptionValue → String
  | .error s => "throw:error:" ++ s
  | .string s => "throw:string:" ++ s
  | .integer n => "throw:integer:" ++ toString n
  | .boolean b => "throw:boolean:" ++ toString b
  | .null => "throw:null"
  | .undefined => "throw:undefined"
def requestFields (r : Request) : List String := [r.operationId,r.from,r.to,toString r.amount]
def receiptTag (r : Request) : String := "return:request:" ++ r.operationId ++ ":" ++ r.from ++ ":" ++ r.to ++ ":" ++ toString r.amount
${definitions.join("\n")}
#eval IO.println ("OBS:" ++ (Lean.toJson ([${site.completions.map((_, i) => `observation${i}`).join(",")}].filterMap id)).compress)
`;
}
