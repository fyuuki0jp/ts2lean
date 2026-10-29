import Ts2Lean.Ledger
import Ts2Lean.Completion

namespace Ts2Lean.LedgerEffects
open Ledger Semantics

/-- The supported observable exception values. Error object identity/properties
    are not currently observable by the lowered fragment. -/
inductive ExceptionValue where
  | error (message : String)
  | string (value : String)
  | integer (value : Int)
  | boolean (value : Bool)
  | null
  | undefined
  deriving Repr, DecidableEq

abbrev Computation (α : Type) := Program State (Option Request) ExceptionValue α
abbrev Statement := Computation Unit

def requestGet (id : String) : Computation (Option Request) := Program.awaitRead (fun s => s.requests id)
def ledgerGet (id : String) : Computation (Option Request) := Program.awaitRead (fun s => lookup s.ledger id)
def balanceGet (id : String) : Computation Int := Program.awaitRead (fun s => s.balances id)
def balanceSet (id : String) (amount : Int) : Computation Unit := Program.awaitWrite (fun _ => True) (fun s => setBalance s id amount)
def requestInsert (r : Request) : Computation Unit := Program.awaitWrite (fun s => s.requests r.operationId = none) (fun s => insertRequest s r)
def ledgerInsert (r : Request) : Computation Unit := Program.awaitWrite (fun s => lookup s.ledger r.operationId = none) (fun s => insertTransfer s r)

def requestValue (r : Option Request) : Request := r.getD ⟨"", "", "", 0⟩

@[simp] theorem requestValue_present (r : Option Request) :
    r = some (requestValue r) ↔ r ≠ none := by
  cases r <;> simp [requestValue]
end Ts2Lean.LedgerEffects
