import Lean
import Lean.Elab.Tactic.Omega
import Ts2Lean.JSString
import Ts2Lean.StateMachine

namespace Ts2Lean

open Lean Meta Elab Command

/-- Explicit JavaScript representation of a two-constructor inductive. -/
structure BoolUnionMapping where
  field : String
  trueConstructor : Name
  falseConstructor : Name
  deriving Inhabited, BEq

initialize boolUnionMappings : SimplePersistentEnvExtension
    (Name × BoolUnionMapping) (Array (Name × BoolUnionMapping)) ←
  registerSimplePersistentEnvExtension {
    addEntryFn := fun entries entry => entries.push entry
    addImportedFn := fun imports => imports.foldl (fun entries more => entries ++ more) #[]
  }

/-- Specify the real TS discriminant, rather than inferring it from constructor names. -/
elab "#ts2lean_bool_union " typeName:ident fieldName:str
    trueCtor:ident falseCtor:ident : command => do
  let resolve (id : Syntax) : CommandElabM Name := liftTermElabM do
    let e ← Elab.Term.elabTerm id none
    let .const name _ := e | throwError "Expected a constant name"
    return name
  let name ← resolve typeName
  let yes ← resolve trueCtor
  let no ← resolve falseCtor
  let env ← getEnv
  let some (.inductInfo info) := env.find? name | throwError "Expected an inductive type"
  if info.numParams != 0 || info.numIndices != 0 || info.ctors.length != 2 ||
      yes == no || !info.ctors.contains yes || !info.ctors.contains no then
    throwError "Boolean unions require exactly two distinct constructors of a monomorphic type"
  if (boolUnionMappings.getState env).any (fun entry => entry.1 == name) then
    throwError "Duplicate boolean union mapping: {name}"
  modifyEnv fun env => boolUnionMappings.addEntry env
    (name, { field := fieldName.getString, trueConstructor := yes, falseConstructor := no })

/-- A specification of a total, pure function. Put state invariants in pre/post. -/
structure Contract (Input Output : Type) where
  pre : Input → Prop
  post : Input → Output → Prop

def Satisfies (c : Contract I O) (f : I → O) : Prop :=
  ∀ input, c.pre input → c.post input (f input)

end Ts2Lean
