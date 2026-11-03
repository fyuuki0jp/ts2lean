import Ts2Lean.Contract

namespace History

structure State where
  past : List Ts2Lean.Snapshot
  present : Ts2Lean.Snapshot
  future : List Ts2Lean.Snapshot
  deriving DecidableEq

inductive Action where
  | change (value : Ts2Lean.Snapshot)
  | undo
  | redo

structure Input where
  state : State
  action : Action
  maximumPast : Ts2Lean.SafeInteger

def bounded : Ts2Lean.StateMachine Input State where
  state := fun i => i.state
  initial := fun s => s.past = [] ∧ s.future = []
  initialWitness := ⟨⟨[], ⟨0, none⟩, []⟩, rfl, rfl⟩
  invariant := fun s => s.past.length + s.future.length ≤ 80
  admissible := fun i => i.maximumPast.value = 80

#ts2lean_snapshot_profile bounded

def bounded50 : Ts2Lean.StateMachine Input State :=
  { bounded with
    invariant := fun s => s.past.length + s.future.length ≤ 50
    admissible := fun i => i.maximumPast.value = 50 }

#ts2lean_snapshot_profile bounded50

def create : Ts2Lean.Contract Ts2Lean.Snapshot State where
  pre := fun _ => True
  post := fun initial result => bounded.initial result ∧ result.present = initial

#ts2lean_snapshot_profile create

theorem create_initial (initial : Ts2Lean.Snapshot) (s : State)
    (h : create.post initial s) : bounded.initial s ∧ bounded50.initial s :=
  ⟨h.1, h.1⟩

/-- Exact history movement, independently stated as sequence decomposition. -/
def step : Ts2Lean.Contract Input State where
  pre := fun i => bounded.admissible i ∧ bounded.invariant i.state
  post := fun i o => match i.action with
    | .change value =>
      if value.json = i.state.present.json then o = i.state
      else o.past = (i.state.past ++ [i.state.present]).drop (i.state.past.length + 1 - 80) ∧
        o.present = value ∧ o.future = []
    | .undo =>
      if i.state.past = [] then o = i.state
      else i.state.past = o.past ++ [o.present] ∧ o.future = i.state.present :: i.state.future
    | .redo =>
      if i.state.future = [] then o = i.state
      else i.state.future = o.present :: o.future ∧ o.past = i.state.past ++ [i.state.present]

#ts2lean_snapshot_profile step

end History
