import Ts2Lean.Completion
import Ts2Lean.Contract

namespace Ts2Lean.Ports
open Semantics

/-- Both synchronous throws and awaited rejections are abrupt completions.
    Exception values are opaque: their properties and identity are not observed. -/
inductive Outcome (Value Error : Type) where
  | fulfilled (value : Value)
  | rejected (error : Error)
  | threw (error : Error)

structure World (State Event : Type) where
  state : State
  trace : List Event

structure PortContract (State Event Error Input Output : Type) where
  identity : String
  callEvent : Input → Event
  outcomeEvent : Input → Outcome Output Error → Event
  step : State → Input → Outcome Output Error → State → Prop
  fulfills : ∀ s i, ∃ o t, step s i (.fulfilled o) t
  rejects : ∀ s i e, ∃ t, step s i (.rejected e) t
  throws : ∀ s i e, ∃ t, step s i (.threw e) t

structure SystemContract (State Event : Type) where
  initial : World State Event → Prop
  invariant : World State Event → Prop
  initialWitness : ∃ w, initial w

structure UseCase (State Event Error Input Output : Type) where
  system : SystemContract State Event
  post : Input → World State Event → Completion Unit Output Error → World State Event → Prop

def outcomeCompletion : Outcome α ε → Completion α ρ ε
  | .fulfilled a => .normal a
  | .rejected e => .thrown e
  | .threw e => .thrown e

def after (p : PortContract S Ev E I O) (i : I) (w : World S Ev)
    (o : Outcome O E) (s : S) : World S Ev :=
  {state := s, trace := w.trace ++ [p.callEvent i, p.outcomeEvent i o]}

def awaitPort (p : PortContract S Ev E I O) (i : I) : Program (World S Ev) R E O where
  exec := fun w c t => ∃ o s, p.step w.state i o s ∧ c = outcomeCompletion o ∧ t = after p i w o s
  wp := fun post w => ∀ o s, p.step w.state i o s → post (outcomeCompletion o) (after p i w o s)
  sound := by
    intro post w h c t he
    obtain ⟨o, s, step, rfl, rfl⟩ := he
    exact h o s step

/-- A callee return becomes the caller's normal value. An exception propagates.
    Generated async functions must return on every path; normal Unit is excluded
    by the generated shape, not converted into an invented return value. -/
def invoke (p : Program σ O E Unit) : Program σ R E O where
  exec := fun s c t => (∃ o, p.exec s (.returned o) t ∧ c = .normal o) ∨
    (∃ e, p.exec s (.thrown e) t ∧ c = .thrown e)
  wp := fun post => p.wp (fun c t => match c with
    | .returned o => post (.normal o) t
    | .thrown e => post (.thrown e) t
    | .normal _ => False)
  sound := by
    intro post s h c t he
    rcases he with ⟨o, hp, rfl⟩ | ⟨e, hp, rfl⟩
    · exact p.sound _ _ h _ _ hp
    · exact p.sound _ _ h _ _ hp

/-- Every completed invocation, including exceptions, is an operation step.
    Safety is never used to filter the transition relation. -/
def transition (p : I → Program σ O E Unit) (s t : σ) : Prop :=
  ∃ i c, (p i).exec s c t

theorem finite_safe (initial invariant : σ → Prop) (step : σ → σ → Prop)
    (initial_safe : ∀ w, initial w → invariant w)
    (preserves : ∀ w t, invariant w → step w t → invariant t)
    {s t : σ} (hi : initial s) (hs : Ts2Lean.FiniteSteps step s t) : invariant t := by
  induction hs with
  | refl => exact initial_safe _ hi
  | next _ h ih => exact preserves _ _ ih h
end Ts2Lean.Ports
