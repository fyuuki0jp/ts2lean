import Ts2Lean.JSString
import Lean.Elab.Tactic.Omega

namespace Ts2Lean

/-- A restricted JavaScript number representation. Its domain is finite safe
integers, including both signed zeros. This is not a model of all IEEE754 values. -/
structure SafeInteger where
  value : Int
  negativeZero : Bool := false
  deriving DecidableEq, Inhabited, Repr

def SafeInteger.valid (n : SafeInteger) : Prop :=
  -9007199254740991 ≤ n.value ∧ n.value ≤ 9007199254740991 ∧
  (n.negativeZero = true → n.value = 0)

def SafeInteger.neg (n : SafeInteger) : SafeInteger :=
  ⟨-n.value, if n.value = 0 then !n.negativeZero else false⟩

/-- An immutable payload atom together with its actual JSON.stringify
observation. The entire atom identifies the value: equal observations do not
identify payloads. The domain excludes throwing or effectful serializers. -/
structure Snapshot where
  identity : Nat
  json : Option JSString
  deriving DecidableEq, Inhabited

namespace JSArray

def length (xs : List α) : SafeInteger := ⟨xs.length, false⟩

def relative (length : Nat) (index : SafeInteger) : Nat :=
  if index.value < 0 then (max 0 (length + index.value)).toNat
  else min index.value.toNat length

def slice (xs : List α) (start : SafeInteger) (stop : Option SafeInteger) : List α :=
  let first := relative xs.length start
  match stop with
  | none => xs.drop first
  | some last => (xs.drop first).take (relative xs.length last - first)

def atIndex (xs : List α) (index : SafeInteger) : Int :=
  if index.value < 0 then xs.length + index.value else index.value

def inBounds (xs : List α) (index : Int) : Prop := 0 ≤ index ∧ index < xs.length

def get (xs : List α) (index : Int) (fallback : α) : α :=
  (xs[index.toNat]?).getD fallback

def validLength (xs : List α) : Prop := xs.length ≤ 4294967295

@[simp] theorem toNat_max_zero (n : Int) : (max 0 n).toNat = n.toNat := by omega

@[simp] theorem take_get_last (xs : List α) (fallback : α) (h : xs.length ≠ 0) :
    xs.take (xs.length - 1) ++ [xs[xs.length - 1]?.getD fallback] = xs := by
  have hn : xs ≠ [] := by simpa using h
  simpa [← List.getLast?_eq_getElem?, List.getLast?_eq_some_getLast hn]
    using List.take_append_getLast xs hn

@[simp] theorem get_first_drop (xs : List α) (fallback : α) (h : xs.length ≠ 0) :
    xs[0]?.getD fallback :: xs.drop 1 = xs := by
  cases xs <;> simp_all

@[simp] theorem get_first_tail (xs : List α) (h : 0 < xs.length) :
    xs[0] :: xs.tail = xs := by
  cases xs with
  | nil => simp at h
  | cons x xs => rfl

end JSArray
end Ts2Lean
