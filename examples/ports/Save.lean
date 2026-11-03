import Ts2Lean.Ports
namespace Save
open Ts2Lean.Ports Ts2Lean.Semantics
structure Input where
  allowed : Bool
  amount : Int
inductive Problem where
  | denied
  | conflict
  deriving DecidableEq
inductive Reply where
  | ok (value : Int)
  | err (error : Problem)
  deriving DecidableEq
#ts2lean_bool_union Reply "ok" Reply.ok Reply.err
inductive Event where
  | authorize (allowed : Bool)
  | authorized
  | denied
  | commit (amount : Int)
  | committed
  | conflict
  | rejected
  | threw
  deriving DecidableEq

def authorization : PortContract Int Event Unit Input Reply where
  identity := "example.authorization"
  callEvent := fun i => .authorize i.allowed
  outcomeEvent := fun _ o => match o with
    | .fulfilled (.ok _) => .authorized
    | .fulfilled (.err _) => .denied
    | .rejected _ => .rejected
    | .threw _ => .threw
  step := fun s i o t => t = s ∧ match o with
    | .fulfilled r => (i.allowed = true ∧ r = .ok 0) ∨ r = .err .denied
    | .rejected _ => True
    | .threw _ => True
  fulfills := by intro s i; exact ⟨.err .denied, s, rfl, Or.inr rfl⟩
  rejects := by intro s i e; exact ⟨s, rfl, trivial⟩
  throws := by intro s i e; exact ⟨s, rfl, trivial⟩

def storage : PortContract Int Event Unit Input Reply where
  identity := "example.storage"
  callEvent := fun i => .commit i.amount
  outcomeEvent := fun _ o => match o with
    | .fulfilled (.ok _) => .committed
    | .fulfilled (.err _) => .conflict
    | .rejected _ => .rejected
    | .threw _ => .threw
  step := fun s i o t => match o with
    | .fulfilled r => (r = .ok i.amount ∧ t = s + 1) ∨ (r = .err .conflict ∧ t = s)
    | .rejected _ => t = s ∨ t = s + 1
    | .threw _ => t = s ∨ t = s + 1
  fulfills := by intro s i; exact ⟨.ok i.amount, s + 1, Or.inl ⟨rfl, rfl⟩⟩
  rejects := by intro s i e; exact ⟨s, Or.inl rfl⟩
  throws := by intro s i e; exact ⟨s, Or.inl rfl⟩

def system : SystemContract Int Event where
  initial := fun w => w.state = 0 ∧ w.trace = []
  invariant := fun w => 0 ≤ w.state
  initialWitness := ⟨⟨0, []⟩, rfl, rfl⟩

def save : UseCase Int Event Unit Input Reply where
  system := system
  post := fun i w out t => match out with
    | .returned (.ok amount) => amount = i.amount ∧ i.allowed = true ∧
        t.trace = w.trace ++ [.authorize i.allowed, .authorized, .commit i.amount, .committed]
    | .returned (.err .denied) => t.trace = w.trace ++ [.authorize i.allowed, .denied]
    | .returned (.err .conflict) => t.trace = w.trace ++ [.authorize i.allowed, .authorized, .commit i.amount, .conflict]
    | .thrown _ => True
    | .normal _ => False
end Save
