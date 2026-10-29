import Ts2Lean.Contract

namespace Balance
structure Input where
  balance : Int
  amount : Int

def invariant (balance : Int) : Prop := 0 ≤ balance

def withdraw : Ts2Lean.Contract Input Int where
  pre := fun i => invariant i.balance ∧ 0 ≤ i.amount ∧ i.amount ≤ i.balance
  post := fun i result => invariant result ∧ result = i.balance - i.amount
end Balance
