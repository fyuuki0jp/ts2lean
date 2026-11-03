import Ts2Lean.Contract
namespace Counter
structure Input where
  state : Int
  add : Bool

def safety : Ts2Lean.StateMachine Input Int where
  state := fun i => i.state
  initial := fun s => s = 0
  invariant := fun s => 0 ≤ s
  initialWitness := ⟨0, rfl⟩
end Counter
