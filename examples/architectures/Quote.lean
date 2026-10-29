import Ts2Lean.Contract
namespace Quote
structure Input where
  amount : Int
  discount : Int
  deriving Repr, DecidableEq

def nonnegativeQuote : Ts2Lean.Contract Input Int where
  pre := fun input => 0 ≤ input.amount ∧ 0 ≤ input.discount
  post := fun input result => result = max 0 (input.amount - input.discount)
end Quote
