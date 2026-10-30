import Ts2Lean.Contract
namespace Inventory
structure Input where
  available : Int
  quantity : Int
def reservationPolicy : Ts2Lean.Contract Input Bool where
  pre := fun _ => True
  post := fun input result => result = decide (0 < input.quantity ∧ input.quantity ≤ 5 ∧ input.quantity ≤ input.available)
inductive Decision where
 | reserved (remaining : Int)
 | rejected
def reservation : Ts2Lean.Contract Input Decision where
 pre := fun _ => True
 post := fun input result => result = if 0 < input.quantity ∧ input.quantity ≤ 5 ∧ input.quantity ≤ input.available
  then .reserved (input.available - input.quantity) else .rejected
def remaining : Ts2Lean.Contract Decision Int where
 pre := fun _ => True
 post := fun input result => result = match input with
  | .reserved n => n
  | .rejected => 0
end Inventory
