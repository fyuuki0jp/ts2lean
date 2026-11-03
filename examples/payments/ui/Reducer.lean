import Ts2Lean.Contract
namespace PaymentUI
structure State where
  amount : Int
  fromAlice : Bool
  operation : Int
  request : Int
  busy : Bool
  failed : Bool
  complete : Bool
  deriving DecidableEq
inductive Action where
  | edit (amount : Int) (fromAlice : Bool)
  | submit
  | retry
  | success (request : Int)
  | failure (request : Int)
  | reset
structure Input where
  state : State
  action : Action

def transition (s : State) (a : Action) : State :=
  match a with
  | .edit amount fromAlice =>
    if s.busy || s.failed || s.complete then s
    else { s with amount, fromAlice, busy := false, failed := false, complete := false }
  | .submit =>
    if s.busy || s.failed || s.complete || decide (s.amount ≤ 0) then s
    else { s with operation := s.operation + 1, request := s.request + 1,
                  busy := true, failed := false, complete := false }
  | .retry =>
    if !s.failed || s.busy || s.complete then s
    else { s with request := s.request + 1, busy := true, failed := false, complete := false }
  | .success request =>
    if !s.busy || decide (request ≠ s.request) then s
    else { s with busy := false, failed := false, complete := true }
  | .failure request =>
    if !s.busy || decide (request ≠ s.request) then s
    else { s with busy := false, failed := true, complete := false }
  | .reset =>
    if !s.complete then s
    else { s with busy := false, failed := false, complete := false }

def reducer : Ts2Lean.Contract Input State where
  pre := fun _ => True
  post := fun i o => o = transition i.state i.action

def invariant (s : State) : Prop :=
  0 ≤ s.operation ∧ s.operation ≤ s.request ∧
  (s.busy = true → s.failed = false ∧ s.complete = false) ∧
  (s.failed = true → s.complete = false) ∧
  (s.busy = true ∨ s.failed = true ∨ s.complete = true → 0 < s.amount ∧ 0 < s.operation)

def preservesState : Ts2Lean.Contract Input State where
  pre := fun i => invariant i.state
  post := fun _ o => invariant o

def initial : Ts2Lean.Contract Bool State where
  pre := fun _ => True
  post := fun _ o => invariant o ∧ o.operation = 0 ∧ o.request = 0 ∧
    o.busy = false ∧ o.failed = false ∧ o.complete = false ∧
    o.amount = 100 ∧ o.fromAlice = true

def staleResponse : Ts2Lean.Contract Input State where
  pre := fun i => match i.action with
    | .success request | .failure request => request ≠ i.state.request
    | _ => False
  post := fun i o => o = i.state

def retryIdentity : Ts2Lean.Contract Input State where
  pre := fun i => match i.action with | .retry => True | _ => False
  post := fun i o => o.operation = i.state.operation ∧ o.amount = i.state.amount ∧
    o.fromAlice = i.state.fromAlice
end PaymentUI
