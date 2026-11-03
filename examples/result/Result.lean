import Ts2Lean.Contract

namespace ResultExample

inductive Problem where
  | negative (amount : Int)
  | tooLarge (amount : Int)

inductive Success where
  | accepted (amount : Int)
  | unchanged

inductive Validation where
  | ok (value : Bool)
  | err (error : Problem)

inductive Outcome where
  | ok (value : Success)
  | err (error : Problem)

#ts2lean_bool_union Validation "ok" Validation.ok Validation.err
#ts2lean_bool_union Outcome "ok" Outcome.ok Outcome.err

def validate : Ts2Lean.Contract Int Validation where
  pre := fun _ => True
  post := fun input output => output =
    if input < 0 then .err (.negative input) else .ok true

def run : Ts2Lean.Contract Int Outcome where
  pre := fun _ => True
  post := fun input output => output =
    if input < 0 then .err (.negative input)
    else if input > 10 then .err (.tooLarge input)
    else .ok (.accepted (input + 1))

end ResultExample

namespace ResultExample
inductive NumberResult where
  | ok (value : Int)
  | err (error : Problem)
#ts2lean_bool_union NumberResult "ok" NumberResult.ok NumberResult.err

def advance : Ts2Lean.Contract NumberResult NumberResult where
  pre := fun _ => True
  post := fun input output => output = match input with
    | .ok value => .ok (value + 1)
    | .err error => .err error
end ResultExample
