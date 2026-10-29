/- A typed fragment of ECMAScript completion semantics.
   State includes local effects: throwing does not implicitly roll it back.
   The executable relation and its sound weakest-precondition rules are defined
   together; generated proofs cannot supply an arbitrary unproved wp rule. -/
namespace Ts2Lean.Semantics

inductive Completion (α ρ ε : Type) where
  | normal (value : α)
  | returned (value : ρ)
  | thrown (error : ε)
  deriving Repr, DecidableEq

structure Program (σ ρ ε α : Type) where
  exec : σ → Completion α ρ ε → σ → Prop
  wp : (Completion α ρ ε → σ → Prop) → σ → Prop
  sound : ∀ post s, wp post s → ∀ c t, exec s c t → post c t

namespace Program
variable {σ ρ ε α β : Type}

def pure (a : α) : Program σ ρ ε α where
  exec := fun s c t => c = .normal a ∧ t = s
  wp := fun post s => post (.normal a) s
  sound := by intro post s h c t he; rcases he with ⟨rfl, rfl⟩; exact h

def returnValue (r : ρ) : Program σ ρ ε α where
  exec := fun s c t => c = .returned r ∧ t = s
  wp := fun post s => post (.returned r) s
  sound := by intro post s h c t he; rcases he with ⟨rfl, rfl⟩; exact h

def throwValue (e : ε) : Program σ ρ ε α where
  exec := fun s c t => c = .thrown e ∧ t = s
  wp := fun post s => post (.thrown e) s
  sound := by intro post s h c t he; rcases he with ⟨rfl, rfl⟩; exact h

def bind (p : Program σ ρ ε α) (next : α → Program σ ρ ε β) : Program σ ρ ε β where
  exec := fun s out t => ∃ c mid, p.exec s c mid ∧
    match c with
    | .normal a => (next a).exec mid out t
    | .returned r => out = .returned r ∧ t = mid
    | .thrown e => out = .thrown e ∧ t = mid
  wp := fun post => p.wp (fun c mid => match c with
    | .normal a => (next a).wp post mid
    | .returned r => post (.returned r) mid
    | .thrown e => post (.thrown e) mid)
  sound := by
    intro post s h out t ⟨c, mid, hp, hn⟩
    have ih := p.sound _ _ h _ _ hp
    cases c with
    | normal a => exact (next a).sound _ _ ih _ _ hn
    | returned r => rcases hn with ⟨rfl, rfl⟩; exact ih
    | thrown e => rcases hn with ⟨rfl, rfl⟩; exact ih

noncomputable def branch (condition : Prop) (yes no : Program σ ρ ε α) : Program σ ρ ε α := by
  classical exact if condition then yes else no

def tryCatch (body : Program σ ρ ε α) (handler : ε → Program σ ρ ε α) : Program σ ρ ε α where
  exec := fun s out t => ∃ c mid, body.exec s c mid ∧
    match c with
    | .thrown e => (handler e).exec mid out t
    | .normal a => out = .normal a ∧ t = mid
    | .returned r => out = .returned r ∧ t = mid
  wp := fun post => body.wp (fun c mid => match c with
    | .thrown e => (handler e).wp post mid
    | .normal a => post (.normal a) mid
    | .returned r => post (.returned r) mid)
  sound := by
    intro post s h out t ⟨c, mid, hb, hh⟩
    have ih := body.sound _ _ h _ _ hb
    cases c with
    | thrown e => exact (handler e).sound _ _ ih _ _ hh
    | normal a => rcases hh with ⟨rfl, rfl⟩; exact ih
    | returned r => rcases hh with ⟨rfl, rfl⟩; exact ih

def finish (saved : Completion α ρ ε) : Completion Unit ρ ε → Completion α ρ ε
  | .normal _ => saved
  | .returned r => .returned r
  | .thrown e => .thrown e

def tryFinally (body : Program σ ρ ε α) (finalizer : Program σ ρ ε Unit) : Program σ ρ ε α where
  exec := fun s out t => ∃ saved mid final,
    body.exec s saved mid ∧ finalizer.exec mid final t ∧ out = finish saved final
  wp := fun post => body.wp (fun saved mid => finalizer.wp (fun final t => post (finish saved final) t) mid)
  sound := by
    intro post s h out t he
    rcases he with ⟨saved, mid, final, hb, hf, rfl⟩
    exact finalizer.sound _ _ (body.sound _ _ h _ _ hb) _ _ hf

/-- Await an external read: fulfillment produces the read value, rejection throws.
    The rejection value is universally quantified, not a fixed synthetic error. -/
def awaitRead (read : σ → α) : Program σ ρ ε α where
  exec := fun s c t => t = s ∧ (c = .normal (read s) ∨ ∃ e, c = .thrown e)
  wp := fun post s => post (.normal (read s)) s ∧ ∀ e, post (.thrown e) s
  sound := by
    intro post s h c t he
    rcases he with ⟨rfl, hc⟩
    rcases hc with rfl | ⟨e, rfl⟩
    · exact h.1
    · exact h.2 e

/-- Writes may reject before or after their local effect. Whether the callback
    eventually commits or rolls back is a separate database boundary. -/
def awaitWrite (allowed : σ → Prop) (update : σ → σ) : Program σ ρ ε Unit where
  exec := fun s c t =>
    (allowed s ∧ c = .normal () ∧ t = update s) ∨
    (∃ e, c = .thrown e ∧ (t = s ∨ (allowed s ∧ t = update s)))
  wp := fun post s =>
    (allowed s → post (.normal ()) (update s)) ∧
    (∀ e, post (.thrown e) s) ∧
    (allowed s → ∀ e, post (.thrown e) (update s))
  sound := by
    intro post s h c t he
    rcases he with ⟨ha, rfl, rfl⟩ | ⟨e, rfl, rfl | ⟨ha, rfl⟩⟩
    · exact h.1 ha
    · exact h.2.1 e
    · exact h.2.2 ha e

def successful (p : Program σ (Option α) ε Unit) (s : σ) (result : Option α) (t : σ) : Prop :=
  (result = none ∧ p.exec s (.normal ()) t) ∨ p.exec s (.returned result) t

def successPost (post : Option α → σ → Prop) : Completion Unit (Option α) ε → σ → Prop
  | .normal _, s => post none s
  | .returned r, s => post r s
  | .thrown _, _ => True

theorem successful_sound (p : Program σ (Option α) ε Unit) (post : Option α → σ → Prop)
    (s : σ) (h : p.wp (successPost post) s) (r : Option α) (t : σ)
    (execution : p.successful s r t) : post r t := by
  rcases execution with ⟨rfl, he⟩ | he
  · exact p.sound _ _ h _ _ he
  · exact p.sound _ _ h _ _ he

-- These rules make the crucial abrupt-completion behavior independently auditable.
theorem bind_return (r : ρ) (next : α → Program σ ρ ε β) :
    (bind (returnValue r) next).exec = (returnValue r).exec := by
  funext s c t
  apply propext
  constructor
  · intro he
    rcases he with ⟨c', mid, hp, hn⟩
    rcases hp with ⟨rfl, rfl⟩
    exact hn
  · intro he
    exact ⟨.returned r, s, ⟨rfl, rfl⟩, he⟩

theorem bind_throw (e : ε) (next : α → Program σ ρ ε β) :
    (bind (throwValue e) next).exec = (throwValue e).exec := by
  funext s c t
  apply propext
  constructor
  · intro he
    rcases he with ⟨c', mid, hp, hn⟩
    rcases hp with ⟨rfl, rfl⟩
    exact hn
  · intro he
    exact ⟨.thrown e, s, ⟨rfl, rfl⟩, he⟩

theorem finally_normal (saved : Completion α ρ ε) : finish saved (.normal ()) = saved := rfl
theorem finally_return (saved : Completion α ρ ε) (r : ρ) : finish saved (.returned r) = .returned r := rfl
theorem finally_throw (saved : Completion α ρ ε) (e : ε) : finish saved (.thrown e) = .thrown e := rfl

end Program
end Ts2Lean.Semantics
