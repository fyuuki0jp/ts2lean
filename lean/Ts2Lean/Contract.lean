import Lean
import Lean.Elab.Tactic.Omega

namespace Ts2Lean

/-- A specification of a total, pure function. Put state invariants in pre/post. -/
structure Contract (Input Output : Type) where
  pre : Input → Prop
  post : Input → Output → Prop

def Satisfies (c : Contract I O) (f : I → O) : Prop :=
  ∀ input, c.pre input → c.post input (f input)

end Ts2Lean
