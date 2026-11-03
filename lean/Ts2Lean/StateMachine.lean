namespace Ts2Lean

/-- The input is the actual reducer input, including its old state and action.
    A machine contract introduces no independent implementation model. -/
structure StateMachine (Input State : Type) where
  state : Input → State
  initial : State → Prop
  invariant : State → Prop
  initialWitness : ∃ s, initial s

inductive FiniteSteps (step : State → State → Prop) : State → State → Prop where
  | refl (s) : FiniteSteps step s s
  | next {s t u} : FiniteSteps step s t → step t u → FiniteSteps step s u

def StateMachine.transition (c : StateMachine I S) (f : I → S) (s t : S) : Prop :=
  ∃ i, c.state i = s ∧ f i = t

theorem StateMachine.finite_safe (c : StateMachine I S) (f : I → S)
    (initial_safe : ∀ s, c.initial s → c.invariant s)
    (preserves : ∀ i, c.invariant (c.state i) → c.invariant (f i))
    {s t : S} (initial : c.initial s) (steps : FiniteSteps (c.transition f) s t) :
    c.invariant t := by
  induction steps with
  | refl => exact initial_safe _ initial
  | next _ step ih =>
    obtain ⟨i, rfl, rfl⟩ := step
    exact preserves i ih

end Ts2Lean
