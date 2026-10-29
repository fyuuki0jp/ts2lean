import Ts2Lean.Contract
namespace Inventory
structure Input where
  available : Int
  quantity : Int
def reservationPolicy : Ts2Lean.Contract Input Bool where
  pre := fun _ => True
  post := fun input result => result = decide (0 < input.quantity ∧ input.quantity ≤ 5 ∧ input.quantity ≤ input.available)
end Inventory
