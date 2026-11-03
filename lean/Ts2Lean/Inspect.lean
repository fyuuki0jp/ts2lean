import Ts2Lean.Modules
import Ts2Lean.Ports

open Lean Meta Elab Command

namespace Ts2Lean

private partial def shape (type : Expr) (seen : List Name := []) : MetaM Json := do
  let type ← whnf type
  if type.isConstOf ``Int then return Json.mkObj [("kind", toJson "int")]
  if type.isConstOf ``Bool then return Json.mkObj [("kind", toJson "bool")]
  if type.isConstOf ``JSString then return Json.mkObj [("kind", toJson "jsstring")]
  if type.isConstOf ``SafeInteger then return Json.mkObj [("kind", toJson "safeinteger")]
  if type.isConstOf ``Snapshot then return Json.mkObj [("kind", toJson "snapshot")]
  if type.isAppOfArity ``List 1 then
    return Json.mkObj [("kind", toJson "array"), ("element", ← shape type.getAppArgs[0]! seen)]
  if type.isAppOfArity ``Option 1 then
    return Json.mkObj [("kind", toJson "optional"), ("element", ← shape type.getAppArgs[0]! seen)]
  if type.isConstOf ``PUnit then return Json.mkObj [("kind", toJson "unit")]
  let .const name _ := type | throwError "Only Int, Bool, and monomorphic structures are supported: {type}"
  if seen.contains name then throwError "Recursive structures are unsupported: {name}"
  let env ← getEnv
  if (getStructureInfo? env name).isNone then
    let some (.inductInfo ind) := env.find? name | throwError "Not a supported inductive type: {name}"
    if ind.numParams != 0 || ind.numIndices != 0 || ind.ctors.length < 2 then
      throwError "Unions need at least two constructors, no parameters or indices: {name}"
    let mappings := (boolUnionMappings.getState env).filter (fun entry => entry.1 == name)
    let mapping := mappings[0]?.map Prod.snd
    if mappings.any (fun entry => some entry.2 != mapping) then
      throwError "Conflicting boolean union mappings: {name}"
    let tagField := mapping.map (·.field) |>.getD "kind"
    let mut variants := #[]
    for ctorName in ind.ctors do
      let some (.ctorInfo ctor) := env.find? ctorName | throwError "Missing constructor"
      let fields ← forallTelescopeReducing ctor.type fun args _ => do
        let mut fields := #[]
        for arg in args do
          let t ← inferType arg
          if t.hasFVar then throwError "Dependent union fields are unsupported"
          let decl ← getFVarLocalDecl arg
          let field := decl.userName.toString
          if field == tagField then throwError "{tagField} is reserved for the union tag"
          fields := fields.push (Json.mkObj [("name", toJson field), ("shape", ← shape t (name :: seen))])
        return fields
      let tag := match mapping with
        | some m => toJson (ctorName == m.trueConstructor)
        | none => toJson ctorName.getString!
      variants := variants.push (Json.mkObj [("tag", tag), ("constructor", toJson ctorName.toString), ("fields", Json.arr fields)])
    return Json.mkObj [("kind", toJson "union"), ("lean", toJson name.toString), ("tag", toJson tagField), ("variants", Json.arr variants)]
  let some info := getStructureInfo? env name | throwError "Missing structure: {name}"
  if !info.parentInfo.isEmpty then throwError "Structure inheritance is unsupported: {name}"
  let ctor := getStructureCtor env name
  if ctor.numParams != 0 then throwError "Generic structures are unsupported: {name}"
  let fields ← forallTelescopeReducing ctor.type fun args _ => do
    if args.size != info.fieldNames.size then throwError "Unsupported structure fields: {name}"
    let mut fields := #[]
    for arg in args, field in info.fieldNames do
      let t ← inferType arg
      if t.hasFVar then throwError "Dependent fields are unsupported: {name}"
      fields := fields.push (Json.mkObj [("name", toJson field.toString), ("shape", ← shape t (name :: seen))])
    return fields
  return Json.mkObj [("kind", toJson "record"), ("lean", toJson name.toString), ("fields", Json.arr fields)]

private partial def userDefinitions (name : Name) (seen : Array Name := #[]) : MetaM (Array Name) := do
  if seen.contains name then return seen
  let env ← getEnv
  let some (.defnInfo info) := env.find? name | return seen
  let some idx := env.getModuleIdxFor? name | return seen
  let moduleName := env.header.moduleNames[idx.toNat]!.toString
  if ["Init", "Lean", "Std", "Ts2Lean"].any (fun p => moduleName == p || moduleName.startsWith (p ++ ".")) then return seen
  let mut result := seen.push name
  for dep in info.value.getUsedConstants do
    result ← userDefinitions dep result
  return result

elab "#ts2lean_contract " id:ident : command => liftTermElabM do
  let e ← Elab.Term.elabTerm id none
  let t ← whnf (← inferType e)
  if !t.isAppOfArity ``Contract 2 && !t.isAppOfArity ``StateMachine 2 then
    throwError "Expected Ts2Lean.Contract or StateMachine, got {t}"
  let args := t.getAppArgs
  let supportingTypes ← (boolUnionMappings.getState (← getEnv)).mapM fun entry => shape (mkConst entry.1)
  let json := Json.mkObj [("dataProfile", if (snapshotProfiles.getState (← getEnv)).contains e.constName! then toJson "snapshot" else Json.null), ("supportingTypes", Json.arr supportingTypes), ("name", toJson id.getId.toString), ("unfold", toJson ((← userDefinitions e.constName!).map Name.toString)), ("input", ← shape args[0]!), ("output", ← shape args[1]!)]
  logInfo m!"TS2LEAN_CONTRACT:{json.compress}"

elab "#ts2lean_ports_contract " id:ident : command => liftTermElabM do
  let e ← Elab.Term.elabTerm id none
  let t ← whnf (← inferType e)
  if !t.isAppOfArity ``Ports.PortContract 5 && !t.isAppOfArity ``Ports.UseCase 5 then
    throwError "Expected a port or use-case contract"
  let args := t.getAppArgs
  let typeName (a : Expr) : MetaM String := do
    let a ← whnf a
    let .const name _ := a | throwError "State, event and exception types must be monomorphic: {a}"
    return name.toString
  let supportingTypes ← (boolUnionMappings.getState (← getEnv)).mapM fun entry => shape (mkConst entry.1)
  let json := Json.mkObj [
    ("name", toJson id.getId.toString),
    ("unfold", toJson ((← userDefinitions e.constName!).map Name.toString)),
    ("supportingTypes", Json.arr supportingTypes),
    ("input", ← shape args[3]!), ("output", ← shape args[4]!),
    ("world", Json.mkObj [("state", toJson (← typeName args[0]!)),
      ("event", toJson (← typeName args[1]!)), ("error", toJson (← typeName args[2]!))])]
  logInfo m!"TS2LEAN_CONTRACT:{json.compress}"

/-- Find contracts declared in the imported source module, using Lean's environment. -/
elab "#ts2lean_contracts " moduleName:ident : command => liftTermElabM do
  let env ← getEnv
  let mut names : Array Json := #[]
  for (name, info) in env.constants.toList do
    let some idx := env.getModuleIdxFor? name | continue
    unless env.header.moduleNames[idx.toNat]! == moduleName.getId do continue
    if isPrivateName name then continue
    let t ← whnf info.type
    let kind := if t.isAppOfArity ``Contract 2 then "pure"
      else if t.isAppOfArity ``StateMachine 2 then "state-machine"
      else if t.isAppOfArity ``Ports.PortContract 5 then "port"
      else if t.isAppOfArity ``Ports.UseCase 5 then "use-case"
      else if t.isConstOf ``ModuleContract then "module"
      else if t.isConstOf ``Ledger.SystemContract then "system"
      else if t.isConstOf ``Ledger.OperationContract then "operation" else ""
    unless kind == "" do names := names.push (Json.mkObj [("name", toJson name.toString), ("kind", toJson kind)])
  logInfo m!"TS2LEAN_CONTRACTS:{(Json.arr names).compress}"

end Ts2Lean

elab "#ts2lean_audit " id:ident : command => do
  let name ← liftTermElabM do
    let e ← Elab.Term.elabTerm id none
    let .const name _ := e | throwError "Expected constant"
    return name
  let axioms ← collectAxioms name
  let allowed := #[``propext, ``Classical.choice, ``Quot.sound]
  for ax in axioms do
    unless allowed.contains ax do throwError "Disallowed axiom: {ax}"
  logInfo m!"TS2LEAN_AXIOMS:{(toJson (axioms.map Name.toString)).compress}"
