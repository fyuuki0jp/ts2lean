import Ts2Lean.Ledger

namespace Ts2Lean
open Lean

inductive ApiType where
  | scalar (name : String)
  | named (name : String)
  | app (name : String) (arguments : List ApiType)
  | callback (arguments : List ApiType) (result : ApiType)

partial def ApiType.json : ApiType → Json
  | .scalar n => Json.mkObj [("kind", toJson n)]
  | .named n => Json.mkObj [("kind", toJson "named"), ("name", toJson n)]
  | .app n args => Json.mkObj [("kind", toJson n), ("arguments", toJson (args.map ApiType.json))]
  | .callback args result => Json.mkObj [("kind", toJson "callback"), ("arguments", toJson (args.map ApiType.json)), ("result", result.json)]
instance : ToJson ApiType := ⟨ApiType.json⟩

structure ApiMethod where
  name : String
  parameters : List (String × ApiType)
  result : ApiType
  operation : String
  generics : List String := []
  deriving ToJson

structure ApiInterface where
  name : String
  fields : List (String × ApiType) := []
  methods : List ApiMethod := []
  aliasOf : Option String := none
  deriving ToJson

structure ModuleAssumption where
  name : String
  statement : String
  assurance : String := "assumed"
  deriving ToJson

/-- API metadata plus the identity of a proved abstract primitive semantics.
Actual adapters must refine these operations; shape compatibility is not evidence. -/
structure ModuleContract where
  identity : String
  profile : String := "ledger-v1"
  interfaces : List ApiInterface
  laws : List ModuleAssumption
  settings : List (String × String)
  deriving ToJson

end Ts2Lean
