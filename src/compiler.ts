import type { ObjectCompilation } from "./object-context.js";
import { readFileSync } from "node:fs";
import { projectCompilerOptions, withAPI, withProgram, type TypeScriptProject } from "./native.js";
import {
  SymbolFlags,
  TypeFlags,
  SignatureKind,
  IndexKind,
  type Symbol as CompilerSymbol,
  type Type,
  type Program,
  type Checker,
} from "typescript/sync";
import { createHash } from "node:crypto";
import * as ts from "typescript/ast";
import path from "node:path";
import {
  Failure,
  shapeKey,
  type Shape,
  type ContractInfo,
  type UnionShape,
} from "./types.js";
import {
  staticResolver,
  functionIdentity,
  type StaticFunction,
  type CompositionCheck,
} from "./static.js";

export type Expr = { shape: Shape } & (
  | { kind: "evaluated"; before: Expr; value: Expr }
  | { kind: "builtin"; operation: "array" | "append" | "length" | "slice" | "index" | "at" | "stringify" | "some"; args: Expr[] }
  | { kind: "literal"; value: string }
  | { kind: "variant"; constructor: string; values: Expr[] }
  | {
      kind: "match";
      object: Expr;
      branches: { constructor: string; names: string[]; value: Expr }[];
    }
  | { kind: "variable"; name: string }
  | { kind: "field"; object: Expr; name: string }
  | { kind: "record"; fields: { name: string; value: Expr }[] }
  | { kind: "unary"; operator: "-" | "!"; value: Expr }
  | { kind: "binary"; operator: string; left: Expr; right: Expr }
  | { kind: "call"; fn: string; argument: Expr }
  | { kind: "conditional"; condition: Expr; yes: Expr; no: Expr }
);
export type Term =
  | {kind:"await"; name:string; call:{kind:"port"|"function"; target:string; argument:Expr; output:Shape}; next:Term}
  | {
      kind: "match";
      object: Expr;
      branches: { constructor: string; names: string[]; body: Term }[];
    }
  | { kind: "return"; value: Expr }
  | { kind: "let"; name: string; value: Expr; next: Term }
  | { kind: "if"; condition: Expr; yes: Term; no: Term };
export interface FunctionIR {
  async?: boolean;
  localName: string;
  sourceHash: string;
  span: {start:number; end:number; startLine:number; endLine:number};
  captures?: { reference: string; type: "int" | "bool"; value: string }[];
  calls: { target: string; reference: string }[];
  name: string;
  source: string;
  snapshot?: string;
  instance?: string;
  parameter: string;
  /** Declaration order for packing multiple JS arguments into the Lean input record. */
  parameterNames?: string[];
  input: Shape;
  output: Shape;
  body: Term;
  dependencies: string[];
}
export interface ModuleIR {
  dataProfile?: "snapshot";
  sourceHashes: Record<string, string>;
  functions: FunctionIR[];
  records: Extract<Shape, { kind: "record" }>[];
  /** Generated data declarations in dependency order, including intermediate sums. */
  declarations?: Extract<Shape, { kind: "record" | "union" }>[];
  target: string;
  compositionChecks?: CompositionCheck[];
  runtimeModules?: string[];
}
const int: Shape = { kind: "int" },
  bool: Shape = { kind: "bool" };

export function compileTypeScript(
  module: string,
  exported: string,
  contract: ContractInfo,
  virtualFiles: Map<string, string>,
  project?: TypeScriptProject,
): ModuleIR {
  module = path.resolve(module);
  return withProgram(
    [module],
    virtualFiles,
    projectCompilerOptions(project),
    (program, checker) =>
      lowerTypeScript(
        module,
        exported,
        contract,
        virtualFiles,
        program,
        checker,
      ),
  );
}

/** Lower the loaded instance using its own immutable type context. */
export function compileFunctionObject(runtime: ObjectCompilation, contract: ContractInfo, ports?: ContractInfo[]): ModuleIR {
  const root = runtime.roots[0]!;
  const context = runtime.context(root);
  return lowerTypeScript(root.node.getSourceFile().fileName, "", contract,
    new Map([...context.declarations.keys()].map((file) => [file + ".ts", ""])),
    context.program, context.checker, runtime, ports);
}

function lowerTypeScript(
  module: string,
  exported: string,
  contract: ContractInfo,
  virtualFiles: Map<string, string>,
  program: Program,
  checker: Checker,
  runtime?: ObjectCompilation,
  ports?: ContractInfo[],
): ModuleIR {
  const records = new Map<string, Extract<Shape, { kind: "record" }>>();
  const generated: Extract<Shape, { kind: "record" }>[] = [];
  const declarations: Extract<Shape, { kind: "record" | "union" }>[] = [];
  const unions = new Map<string, UnionShape>();
  let typeBindings = new Map<Type, Shape>();
  const register = (s: Shape): Shape => {
    if (s.kind === "array" || s.kind === "optional") { register(s.element); return s; }
    if (s.kind === "union") {
      const old = unions.get(shapeKey(s));
      if (old && old.lean !== s.lean)
        throw new Failure(
          "unsupported",
          "Structurally identical Lean unions must share a type",
        );
      unions.set(shapeKey(s), s);
      for (const v of s.variants) for (const f of v.fields) register(f.shape);
      return s;
    }
    if (s.kind !== "record") return s;
    for (const f of s.fields) register(f.shape);
    const key = shapeKey(s),
      old = records.get(key);
    if (old && old.lean !== s.lean)
      throw new Failure(
        "unsupported",
        `Structurally identical Lean records must share a type: ${old.lean}, ${s.lean}`,
      );
    records.set(key, s);
    return s;
  };
  register(contract.input);
  register(contract.output);
  for (const shape of contract.supportingTypes ?? []) register(shape);
  for (const port of ports ?? []) {
    register(port.input); register(port.output);
    for (const shape of port.supportingTypes ?? []) register(shape);
  }
  const fail = (node: ts.Node, message: string): never => {
    const sf = node.getSourceFile(),
      pos = sf.getLineAndCharacterOfPosition(node.getStart());
    throw new Failure(
      "unsupported",
      `${sf.fileName}:${pos.line + 1}:${pos.character + 1}: ${message}`,
    );
  };
  const intern = (fields: { name: string; shape: Shape }[]): Shape => {
    const s: Extract<Shape, { kind: "record" }> = {
      kind: "record",
      lean: `Ts2LeanGenerated.Record${generated.length}`,
      fields,
    };
    const key = shapeKey(s),
      old = records.get(key);
    if (old) return old;
    generated.push(s);
    declarations.push(s);
    records.set(key, s);
    return s;
  };
  const typeShape = (
    type: Type,
    node: ts.Node,
    seen = new Set<Type>(),
  ): Shape => {
    if (type.flags & TypeFlags.TypeParameter) {
      const binding = typeBindings.get(type);
      if (!binding) return fail(node, "Generic type parameters must be concretized at a verified call");
      return binding;
    }
    if (type.flags & TypeFlags.Never) return {kind:"never"};
    if (type.flags & TypeFlags.Undefined) return {kind:"unit"};
    if (type.isBooleanLiteralType())
      return {kind:"literal", value:type.value};
    if (type.flags & TypeFlags.BooleanLike) return bool;
    if (type.isStringLiteralType()) {
      if (!/^[A-Za-z_]\w*$/.test(type.value)) return {kind:"jsstring"};
      return { kind: "literal", value: type.value };
    }
    if (type.flags & TypeFlags.String) return {kind:"jsstring"};
    if (type.flags & TypeFlags.NumberLike) return {kind:"safeinteger"};
    if (type.flags & TypeFlags.Unknown) return {kind:"snapshot"};
    if (seen.has(type)) return fail(node, "Recursive data types are unsupported.");
    if (type.isUnionType()) {
      // Instantiated/awaited native types may retain nested union aliases.
      const flatten = (t: Type, parents = new Set<Type>()): Type[] => {
        if (!t.isUnionType()) return [t];
        if (parents.has(t)) return fail(node, "Recursive union aliases are unsupported");
        return t.getTypes().flatMap(member => flatten(member, new Set(parents).add(t)));
      };
      const alternatives = flatten(type);
      const defined = alternatives.filter(t => !(t.flags & TypeFlags.Undefined));
      if (defined.length === 1 && defined.length !== alternatives.length)
        return {kind:"optional",element:typeShape(defined[0]!,node,new Set(seen).add(type))};
      const members = alternatives.map((t) => {
        const r = typeShape(t, node, seen);
        if (r.kind === "never") return undefined;
        if (r.kind !== "record")
          return fail(node, "Unions require readonly record variants");
        return r;
      }).filter((r): r is Extract<Shape, {kind:"record"}> => !!r);
      if (!members.length) return {kind:"never"};
      if (members.length === 1) return members[0]!;
      const matches = [...unions.values()].filter((candidate) => {
        const variants = members.map(r => {
          const tag = r.fields.find(f => f.name === candidate.tag)?.shape;
          return tag?.kind === "literal" ? {tag:tag.value, constructor:"",
            fields:r.fields.filter(f => f.name !== candidate.tag)} : undefined;
        });
        return variants.every(v => v !== undefined) &&
          shapeKey({kind:"union",lean:"",tag:candidate.tag,variants:variants as UnionShape["variants"]}) === shapeKey(candidate);
      });
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1)
        return fail(node, `Ambiguous Lean union representation for ${checker.typeToString(type)}`);
      // Intermediate Result instantiations and narrower error sets need their
      // own sum, rather than borrowing a larger contract type and its values.
      const tags = new Set(["kind", ...[...unions.values()].map(s => s.tag)]);
      const discriminants = [...tags].filter(tag => {
        const values = members.map(r => r.fields.find(f => f.name === tag)?.shape);
        return values.every(s => s?.kind === "literal") &&
          new Set(values.map(s => JSON.stringify((s as Extract<Shape,{kind:"literal"}>).value))).size === members.length;
      });
      if (discriminants.length !== 1)
        return fail(node, `Declare an unambiguous matching union and discriminant in the Lean contract: ${checker.typeToString(type)}`);
      const tag = discriminants[0]!, lean = `Ts2LeanGenerated.Union${declarations.length}`;
      const result: UnionShape = {kind:"union",lean,tag,variants:members.map((r,i) => ({
        tag:(r.fields.find(f=>f.name===tag)!.shape as Extract<Shape,{kind:"literal"}>).value,
        constructor:`${lean}.case${i}`,fields:r.fields.filter(f=>f.name!==tag),
      }))};
      unions.set(shapeKey(result),result);
      declarations.push(result);
      return result;
    }
    if (type.flags & TypeFlags.BigIntLike) return int;
    if (checker.isArrayType(type)) {
      if (checker.isTupleType(type)) return fail(node,"Tuple arrays are not supported");
      const element = checker.getIndexTypeOfType(type,IndexKind.Number);
      if (!element) return fail(node,"Array element type is missing");
      return {kind:"array",element:typeShape(element,node,new Set(seen).add(type))};
    }
    if (
      !(type.flags & TypeFlags.Object) ||
      type.isUnionType() ||
      type.isIntersectionType()
    )
      return fail(
        node,
        `Expected a supported bigint, boolean, string, undefined, or readonly data type; got ${checker.typeToString(type)}.`,
      );
    if (seen.has(type)) return fail(node, "Recursive records are unsupported.");
    if (
      checker.getSignaturesOfType(type, SignatureKind.Call).length ||
      checker.getSignaturesOfType(type, SignatureKind.Construct).length ||
      checker.getIndexInfosOfType(type).length
    )
      return fail(node, "Callable types and index signatures are unsupported.");
    const next = new Set(seen).add(type);
    const props = checker.getPropertiesOfType(type);
    if (!props.length) return fail(node, "Empty records are unsupported.");
    const fields = props.map((p) => {
        const decls = p.declarations.map((d) => d.resolve()!);
        if (
          p.flags & SymbolFlags.Optional ||
          !decls.length ||
          !decls.every(
            (d) =>
              ts.isPropertySignatureDeclaration(d) &&
              d.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
              ),
          )
        )
          return fail(
            node,
            `Property ${p.name} must be a required readonly property signature.`,
          );
        if (p.name === "__proto__" || !/^[A-Za-z_]\w*$/.test(p.name))
          return fail(node, "Record field names must be simple identifiers.");
        return {
          name: p.name,
          shape: typeShape(
            checker.getTypeOfSymbolAtLocation(p, node),
            node,
            next,
          ),
        };
      });
    // A required never payload makes a variant uninhabited (e.g. Result<T, never>).
    return fields.some(f => f.shape.kind === "never") ? {kind:"never"} : intern(fields);
  };
  const booleanShape = (s: Shape) => s.kind === "bool" || (s.kind === "literal" && typeof s.value === "boolean");
  const same = (a: Shape, b: Shape, node: ts.Node): void => {
    if (booleanShape(a) && booleanShape(b)) return;
    if (shapeKey(a) !== shapeKey(b))
      fail(node, "Expression and declared contract types differ.");
  };
  const symbol = (node: ts.Node): CompilerSymbol => {
    let s = checker.getSymbolAtLocation(node);
    if (!s) return fail(node, "Unresolved symbol.");
    if (s.flags & SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const statics = staticResolver(checker, fail, {allowGenerics:true,allowAsync:!!ports});
  const sourceFiles = program
    .getSourceFileNames()
    .map((file) => program.getSourceFile(file)!)
    .filter(
      (sf) =>
        !sf.isDeclarationFile && !virtualFiles.has(path.resolve(sf.fileName)),
    );
  if (!runtime) for (const sf of sourceFiles) {
    if (sf.fileName.includes(`${path.sep}node_modules${path.sep}`))
      fail(sf, "External runtime modules are unsupported.");
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        if (!st.importClause) fail(st, "Side-effect imports are unsupported.");
        if (
          (st.moduleSpecifier as ts.StringLiteral).text.endsWith(".lean") &&
          st.importClause!.phaseModifier !== ts.SyntaxKind.TypeKeyword
        )
          fail(st, "Lean imports must use import type.");
        continue;
      }
      if (
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEmptyStatement(st) ||
        ts.isExportDeclaration(st)
      )
        continue;
      // Declarations have no module initialization effect. Validate only called bodies.
      if (ts.isFunctionDeclaration(st) && st.name) continue;
      if (
        ts.isVariableStatement(st) &&
        st.declarationList.flags & ts.NodeFlags.Const
      ) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer)
            fail(d, "Module composition uses initialized const identifiers");
          statics.resolveSymbol(symbol(d.name), d, new Map());
        }
        continue;
      }
      fail(
        st,
        "Module scope permits functions, static dependency composition, types, imports, and reexports only",
      );
    }
  }
  let targetValue: import("./static.js").StaticValue;
  if (runtime) targetValue = runtime.roots[0]!;
  else {
  const sf = program.getSourceFile(module)!;
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const [exportName, ...members] = exported.split(".");
  let targetSymbol =
    moduleSymbol &&
    checker.getExportsOfModule(moduleSymbol).find((s) => s.name === exportName);
  if (!targetSymbol)
    throw new Failure("unsupported", `No exported binding ${exported}`);
  if (targetSymbol.flags & SymbolFlags.Alias)
    targetSymbol = checker.getAliasedSymbol(targetSymbol);
  targetValue = statics.resolveSymbol(targetSymbol, sf, new Map());
  for (const key of members) targetValue = statics.member(targetValue, key, sf);
  if (targetValue.kind !== "function")
    fail(sf, "Select an exported function or service method");
  }
  const functions: FunctionIR[] = [];
  const compiled = new Map<StaticFunction, Map<string, FunctionIR>>();
  const compiling = new Set<StaticFunction>();
  let functionSerial = 0;
  const compileFunction = (value: StaticFunction, arguments_: Shape[] = []): FunctionIR => {
    const specialization = JSON.stringify(arguments_.map(shapeKey));
    const previous = compiled.get(value)?.get(specialization);
    if (previous) return previous;
    const previousProgram = program, previousChecker = checker, previousBindings = typeBindings;
    if (runtime) ({ program, checker } = runtime.context(value));
    try {
    const node = value.node;
    if ((node.typeParameters?.length ?? 0) !== arguments_.length)
      return fail(node, "Generic functions require concrete type arguments at a verified call");
    typeBindings = new Map((node.typeParameters ?? []).map((p, i) =>
      [checker.getTypeAtLocation(p), arguments_[i]!]));
    if (compiling.has(value))
      return fail(node, "Recursive calls are unsupported");
    compiling.add(value);
    statics.validateFunction(node);
    if (!node.parameters.length && !ports)
      return fail(
        node,
        "Verified functions require at least one data input",
      );
    const parameter = node.parameters[0]!;
    const parameterFields = node.parameters.length > 1 ? node.parameters.map((p) => {
      if (!ts.isIdentifier(p.name) || p.name.text === "this")
        return fail(p, "Multiple data parameters require simple identifiers");
      return { name: p.name.text, shape: typeShape(checker.getTypeAtLocation(p), p) };
    }) : undefined;
    const signature = checker.getSignatureFromDeclaration(node)!;
    const asyncFunction = !!node.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword);
    const returnedType = checker.getReturnTypeOfSignature(signature);
    const fn = {
      node,
      name: `fn${functionSerial++}`,
      parameter: "v0",
      input: parameterFields ? intern(parameterFields) : parameter ? typeShape(checker.getTypeAtLocation(parameter), parameter) : {kind:"unit"} as Shape,
      output: typeShape(asyncFunction ? checker.getAwaitedType(returnedType)! : returnedType, node),
    };
    if (fn.input.kind === "never" || fn.output.kind === "never")
      return fail(node, "Uninhabited function signatures are unsupported");
    let counter = 1;
    const locals = new Map<CompilerSymbol, Expr>();
    const bindData = (
      name: ts.BindingName,
      value: Expr,
      scope: typeof locals,
    ): void => {
      if (ts.isIdentifier(name)) {
        scope.set(symbol(name), value);
        return;
      }
      if (!ts.isObjectBindingPattern(name))
        return fail(name, "Only object destructuring is supported");
      for (const e of name.elements) {
        if (
          !e.name ||
          e.dotDotDotToken ||
          e.initializer ||
          (e.propertyName && !ts.isIdentifier(e.propertyName))
        )
          return fail(e, "Use static destructuring without rest or defaults");
        const key =
          e.propertyName?.getText() ??
          (ts.isIdentifier(e.name) ? e.name.text : undefined);
        const field =
          value.shape.kind === "record" &&
          value.shape.fields.find((f) => f.name === key);
        if (!field) return fail(e, "Unknown destructured field");
        bindData(
          e.name,
          {
            kind: "field",
            object: value,
            name: field.name,
            shape: field.shape,
          },
          scope,
        );
      }
    };
    const input: Expr = { kind: "variable", name: "v0", shape: fn.input };
    if (parameterFields)
      node.parameters.forEach((p, i) => bindData(p.name, {
        kind: "field", object: input, name: parameterFields[i]!.name,
        shape: parameterFields[i]!.shape,
      }, locals));
    else if(parameter) bindData(parameter.name, input, locals);
    const mutable = new Set<CompilerSymbol>(locals.keys());
    const captures = new Map<
      string,
      { reference: string; type: "int" | "bool"; value: string }
    >();
    const dependencies = new Set<string>();
    const calls = new Map<string, { target: string; reference: string }>();
    const trivial=(e:Expr):boolean=>{
      switch(e.kind) {
        case "literal":case "variable":return true;
        case "field":return trivial(e.object);
        case "record":return e.fields.every(f=>trivial(f.value));
        case "variant":return e.values.every(trivial);
        case "unary":return trivial(e.value);
        case "binary":return trivial(e.left)&&trivial(e.right);
        case "conditional":return trivial(e.condition)&&trivial(e.yes)&&trivial(e.no);
        case "match":return trivial(e.object)&&e.branches.every(b=>trivial(b.value));
        case "evaluated":return trivial(e.before)&&trivial(e.value);
        case "call":case "builtin":return false;
      }
    };
    const evaluated=(before:Expr,value:Expr):Expr=>trivial(before)?value:({kind:"evaluated",before,value,shape:value.shape});
    const coerce = (expr: Expr, target: Shape, at: ts.Node): Expr => {
      if (shapeKey(expr.shape) === shapeKey(target)) return expr;
      if (target.kind === "jsstring" && expr.shape.kind === "literal" && typeof expr.shape.value === "string")
        return evaluated(expr,{kind:"literal", value:expr.shape.value, shape:target});
      if (target.kind === "bool" && booleanShape(expr.shape)) return {...expr, shape:target};
      if (target.kind === "optional") {
        if (expr.shape.kind === "unit") return evaluated(expr,{kind:"literal",value:"none",shape:target});
        return {kind:"builtin",operation:"some",args:[coerce(expr,target.element,at)],shape:target};
      }
      if (target.kind === "array" && expr.shape.kind === "array" && expr.kind === "builtin" && expr.operation === "array")
        return {...expr,shape:target,args:expr.args.map(e=>coerce(e,target.element,at))};
      if (target.kind === "literal")
        return fail(at, "Literal payload must retain the exact declared value");
      if (target.kind === "union" && expr.shape.kind === "union" && target.tag === expr.shape.tag) {
        return {kind:"match",object:expr,shape:target,branches:expr.shape.variants.map(source => {
          const destination=target.variants.find(v=>v.tag===source.tag);
          if(!destination || destination.fields.length!==source.fields.length)
            return fail(at,"Union widening must retain every source variant and payload");
          const names=source.fields.map(()=>`v${counter++}`);
          const values=destination.fields.map(field=>{
            const index=source.fields.findIndex(f=>f.name===field.name);
            if(index<0)return fail(at,"Union widening cannot rename a payload field");
            return coerce({kind:"variable",name:names[index]!,shape:source.fields[index]!.shape},field.shape,at);
          });
          return {constructor:source.constructor,names,value:{kind:"variant",constructor:destination.constructor,values,shape:target}};
        })};
      }
      const projectField = (name: string, shape: Shape): Expr =>
        expr.kind === "record" ? expr.fields.find(f => f.name === name)!.value :
          shape.kind === "literal" ? {kind:"literal", value:String(shape.value), shape} :
          {kind:"field", object:expr, name, shape};
      if (target.kind === "union" && expr.shape.kind === "record") {
        const fields = expr.shape.fields;
        const tag = fields.find(f => f.name === target.tag)?.shape;
        const variant = tag?.kind === "literal" && target.variants.find(v => v.tag === tag.value);
        if (variant && fields.length === variant.fields.length + 1) {
          const values = variant.fields.map(f => {
            const field = fields.find(e => e.name === f.name);
            if (!field) return fail(at, "Missing union payload field");
            return coerce(projectField(field.name, field.shape), f.shape, at);
          });
          return evaluated(expr,{kind:"variant", constructor:variant.constructor, values, shape:target});
        }
      }
      if (target.kind === "record" && expr.shape.kind === "record" &&
          target.fields.length === expr.shape.fields.length) {
        const source = expr.shape;
        return evaluated(expr,{kind:"record", shape:target, fields:target.fields.map(f => {
          const field = source.fields.find(e => e.name === f.name);
          if (!field) return fail(at, "Missing record payload field");
          return {name:f.name, value:coerce(projectField(field.name, field.shape), f.shape, at)};
        })});
      }
      same(expr.shape, target, at);
      return expr;
    };
    const discriminant = (
      n: ts.Expression,
      scope: typeof locals,
    ): { key: CompilerSymbol; object: Expr; shape: UnionShape } | undefined => {
      if (ts.isParenthesizedExpression(n))
        return discriminant(n.expression, scope);
      if (
        ts.isPrefixUnaryExpression(n) &&
        n.operator === ts.SyntaxKind.ExclamationToken
      )
        return discriminant(n.operand, scope);
      if (
        ts.isBinaryExpression(n) &&
        ["&&", "||"].includes(n.operatorToken.getText())
      )
        return discriminant(n.left, scope) ?? discriminant(n.right, scope);
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        const key = symbol(n.expression), object = scope.get(key);
        if (object?.shape.kind === "union" && object.shape.tag === n.name.text)
          return {key, object, shape:object.shape};
      }
      if (ts.isBinaryExpression(n) && ["===", "!=="].includes(n.operatorToken.getText()))
        return discriminant(n.left, scope) ?? discriminant(n.right, scope);
    };
    const narrowed = (
      d: NonNullable<ReturnType<typeof discriminant>>,
      scope: typeof locals,
    ) =>
      d.shape.variants.map((v) => {
        const names = v.fields.map(() => `v${counter++}`);
        const fields = [
          {
            name: d.shape.tag,
            value: {
              kind: "literal",
              shape: { kind: "literal", value: v.tag },
              value: String(v.tag),
            } as Expr,
          },
          ...v.fields.map((f, i) => ({
            name: f.name,
            value: {
              kind: "variable",
              name: names[i]!,
              shape: f.shape,
            } as Expr,
          })),
        ];
        const inner = new Map(scope);
        inner.set(d.key, {
          kind: "record",
          shape: intern(
            fields.map((f) => ({ name: f.name, shape: f.value.shape })),
          ),
          fields,
        });
        return { constructor: v.constructor, names, scope: inner };
      });
    const expression = (
      node: ts.Expression,
      scope: typeof locals,
      expected?: Shape,
    ): Expr => {
      if (ts.isIdentifier(node) && node.text === "undefined" && !symbol(node).valueDeclaration)
        return {kind:"literal",value:"()",shape:{kind:"unit"}};
      if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
        return expression(node.expression, scope, expected);
      if (ts.isNonNullExpression(node)) {
        if (!ts.isElementAccessExpression(node.expression) && !(ts.isCallExpression(node.expression) &&
            ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "at"))
          return fail(node,"Non-null assertions currently require a proved array index");
        return expression(node.expression,scope,expected);
      }
      if (ts.isNumericLiteral(node)) {
        const n = Number(node.text.replaceAll("_",""));
        if (!Number.isSafeInteger(n)) return fail(node,"Only exact safe-integer number literals are supported");
        return {kind:"literal",shape:{kind:"safeinteger"},value:String(n)};
      }
      if (ts.isArrayLiteralExpression(node)) {
        const contextual = expected?.kind === "array" ? expected : undefined;
        let element = contextual?.element;
        const parts: Expr[] = [];
        for (const item of node.elements) {
          if (ts.isOmittedExpression(item)) return fail(item,"Sparse arrays are unsupported");
          if (ts.isSpreadElement(item)) {
            const part=expression(item.expression,scope,contextual);
            if(part.shape.kind!=="array")return fail(item,"Array spread requires a dense array");
            element ??= part.shape.element;
            same(part.shape.element,element,item);
            parts.push(part);
          } else {
            const itemValue=expression(item,scope,element);
            element ??= itemValue.shape;
            parts.push({kind:"builtin",operation:"array",shape:{kind:"array",element},args:[coerce(itemValue,element,item)]});
          }
        }
        const shape:Shape={kind:"array",element:element??{kind:"never"}};
        return parts.length ? parts.reduce((a,b)=>({kind:"builtin",operation:"append",args:[a,b],shape}))
          : {kind:"builtin",operation:"array",args:[],shape};
      }
      if (ts.isElementAccessExpression(node)) {
        const object=expression(node.expression,scope), index=expression(node.argumentExpression,scope);
        if(object.shape.kind!=="array"||index.shape.kind!=="safeinteger")return fail(node,"Indexing requires an array and safe-integer number");
        return {kind:"builtin",operation:"index",args:[object,index],shape:object.shape.element};
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return {
          kind: "literal",
          shape: /^[A-Za-z_]\w*$/.test(node.text) ? { kind: "literal", value: node.text } : {kind:"jsstring"},
          value: node.text,
        };
      }
      if (ts.isBigIntLiteral(node))
        return {
          kind: "literal",
          shape: int,
          value: BigInt(node.text.replaceAll("_", "").slice(0, -1)).toString(),
        };
      if (
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword
      )
        return {
          kind: "literal",
          shape: {kind:"literal", value:node.kind === ts.SyntaxKind.TrueKeyword},
          value: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false",
        };
      let base: ts.Expression = node;
      while (ts.isPropertyAccessExpression(base)) base = base.expression;
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
        ts.isIdentifier(base) &&
        !scope.has(symbol(base))
      ) {
        const resolved = runtime ? runtime.resolve(value, node) : statics.resolve(node, value.env);
        if (resolved.kind !== "scalar")
          return fail(
            node,
            "Only scalar dependency values may be read as data",
          );
        const reference = node.getText();
        captures.set(reference, {
          reference,
          type: resolved.type,
          value: resolved.value,
        });
        return {
          kind: "literal",
          shape: resolved.type === "int" ? int : bool,
          value: resolved.value,
        };
      }
      if (ts.isIdentifier(node)) {
        const local = scope.get(symbol(node));
        if (!local)
          return fail(
            node,
            "Only local variables and the input parameter may be read.",
          );
        return local;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const object = expression(node.expression, scope);
        if (object.shape.kind === "array" && node.name.text === "length")
          return {kind:"builtin",operation:"length",args:[object],shape:{kind:"safeinteger"}};
        if (object.kind === "record") {
          const f = object.fields.find((f) => f.name === node.name.text);
          if (f) return evaluated(object,f.value);
        }
        const field =
          object.shape.kind === "record" &&
          object.shape.fields.find((f) => f.name === node.name.text);
        if (!field) return fail(node, "Unknown record field.");
        if (field.shape.kind === "literal")
          return evaluated(object,{kind:"literal", value:String(field.shape.value), shape:field.shape});
        return { kind: "field", object, name: field.name, shape: field.shape };
      }
      if (ts.isObjectLiteralExpression(node)) {
        const fields = node.properties.map((p) => {
          if (ts.isShorthandPropertyAssignment(p)) {
            const s = checker.getShorthandAssignmentValueSymbol(p);
            const local = s && scope.get(s);
            if (
              !local ||
              !ts.isIdentifier(p.name) ||
              p.objectAssignmentInitializer
            )
              return fail(p, "Unsupported shorthand property.");
            return {
              name: p.name.text,
              value: local,
            };
          }
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name))
            return fail(
              p,
              "Only explicit record fields and shorthand properties are supported.",
            );
          if (p.name.text === "__proto__")
            return fail(
              p,
              "The JavaScript __proto__ setter syntax is unsupported.",
            );
          const fieldName=p.name.text;
          const fieldShape=expected?.kind==="record"?expected.fields.find(f=>f.name===fieldName)?.shape:undefined;
          return { name: p.name.text, value: expression(p.initializer, scope,fieldShape) };
        });
        if (
          !fields.length ||
          new Set(fields.map((f) => f.name)).size !== fields.length
        )
          return fail(
            node,
            "Empty records and duplicate fields are unsupported.",
          );
        return {
          kind: "record",
          fields,
          shape: intern(
            fields.map((f) => ({ name: f.name, shape: f.value.shape })),
          ),
        };
      }
      if (ts.isPrefixUnaryExpression(node)) {
        const value = expression(node.operand, scope);
        if (node.operator === ts.SyntaxKind.MinusToken) {
          if(value.shape.kind==="safeinteger")return {kind:"unary",operator:"-",value,shape:value.shape};
          same(value.shape, int, node);
          return { kind: "unary", operator: "-", value, shape: int };
        }
        if (node.operator === ts.SyntaxKind.ExclamationToken) {
          if(value.shape.kind==="safeinteger")return {kind:"binary",operator:"===",left:value,right:{kind:"literal",value:"0",shape:value.shape},shape:bool};
          same(value.shape, bool, node);
          if (value.kind === "literal")
            return {
              kind: "literal",
              shape: bool,
              value: String(value.value !== "true"),
            };
          return { kind: "unary", operator: "!", value, shape: bool };
        }
        return fail(node, "Unsupported unary operator.");
      }
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.getText();
        if (
          ![
            "+",
            "-",
            "*",
            "<",
            "<=",
            ">",
            ">=",
            "===",
            "!==",
            "&&",
            "||",
          ].includes(operator)
        )
          return fail(node, `Unsupported operator: ${operator}`);
        let left = expression(node.left, scope);
        if (
          ["&&", "||"].includes(operator) &&
          left.kind === "literal" &&
          booleanShape(left.shape)
        ) {
          if (
            (operator === "&&" && left.value === "false") ||
            (operator === "||" && left.value === "true")
          )
            return left;
          const right = expression(node.right, scope);
          same(right.shape, bool, node);
          return right;
        }
        let right = expression(node.right, scope);
        if (["===", "!=="].includes(operator)) {
          if (left.shape.kind === "jsstring") right = coerce(right, left.shape, node.right);
          if (right.shape.kind === "jsstring") left = coerce(left, right.shape, node.left);
        }
        if (
          ["===", "!=="].includes(operator) &&
          left.shape.kind === "literal" &&
          right.shape.kind === "literal"
        ) {
          const equal = left.shape.value === right.shape.value;
          return evaluated(left,evaluated(right,{
            kind: "literal",
            shape: bool,
            value: String(operator === "===" ? equal : !equal),
          }));
        }
        same(left.shape, right.shape, node);
        if (["&&", "||"].includes(operator)) same(left.shape, bool, node);
        else if (["===", "!=="].includes(operator)) {
          if(left.shape.kind==="optional" && !["int","bool","jsstring","string","unit","literal"].includes(left.shape.element.kind))
            return fail(node,"Optional equality currently supports primitive non-number values only");
          if (["record", "union", "array", "snapshot"].includes(left.shape.kind))
            return fail(node, "Object identity comparisons are unsupported.");
        } else if(left.shape.kind==="safeinteger") {
          if(["+","-","*"].includes(operator))return fail(node,"General IEEE754 arithmetic is unsupported; safe-integer numbers currently support comparisons and unary negation only");
        } else same(left.shape, int, node);
        return {
          kind: "binary",
          operator,
          left,
          right,
          shape: ["+", "-", "*"].includes(operator) ? int : bool,
        };
      }
      if (ts.isConditionalExpression(node)) {
        const d = discriminant(node.condition, scope);
        if (d) {
          const branches = narrowed(d, scope).map((b) => ({
            ...b,
            value: expression(node, b.scope, expected),
          }));
          const target = expected ?? branches[0]!.value.shape;
          return {
            kind: "match",
            object: d.object,
            shape: target,
            branches: branches.map((b) => ({
              ...b,
              value: coerce(b.value, target, node),
            })),
          };
        }
        const condition = expression(node.condition, scope);
        same(condition.shape, bool, node.condition);
        if (condition.kind === "literal")
          return expression(
            condition.value === "true" ? node.whenTrue : node.whenFalse,
            scope,
            expected,
          );
        let yes = expression(node.whenTrue, scope, expected),
          no = expression(node.whenFalse, scope, expected);
        const target =
          expected ??
          (shapeKey(yes.shape) === shapeKey(no.shape)
            ? yes.shape
            : typeShape(checker.getTypeAtLocation(node), node));
        yes = coerce(yes, target, node);
        no = coerce(no, target, node);
        return { kind: "conditional", condition, yes, no, shape: target };
      }
      if (ts.isCallExpression(node)) {
        if(ts.isPropertyAccessExpression(node.expression)) {
          const access=node.expression;
          if(ts.isIdentifier(access.expression)&&access.expression.text==="JSON"&&access.name.text==="stringify") {
            const global=symbol(access.expression);
            if(!global.declarations.length || !global.declarations.every(d=>program.isSourceFileDefaultLibrary(d.resolve()!.getSourceFile())) || node.arguments.length!==1)
              return fail(node,"Use the standard one-argument JSON.stringify");
            const input=expression(node.arguments[0]!,scope);
            if(input.shape.kind!=="snapshot")return fail(node,"JSON.stringify requires an explicitly modeled immutable Snapshot payload");
            return {kind:"builtin",operation:"stringify",args:[input],shape:{kind:"optional",element:{kind:"jsstring"}}};
          }
          if(["slice","at"].includes(access.name.text) && checker.isArrayType(checker.getTypeAtLocation(access.expression))) {
            const receiver=expression(access.expression,scope);
            if(receiver.shape.kind!=="array")return fail(node,"Array methods require a dense array");
            if(node.typeArguments?.length || node.arguments.some(ts.isSpreadElement) ||
              node.arguments.length<1 || node.arguments.length>(access.name.text==="slice"?2:1))
              return fail(node,"Unsupported array method arguments");
            const args=node.arguments.map(a=>expression(a,scope));
            for(const a of args)same(a.shape,{kind:"safeinteger"},node);
            return {kind:"builtin",operation:access.name.text as "slice"|"at",args:[receiver,...args],
              shape:access.name.text==="slice"?receiver.shape:receiver.shape.element};
          }
        }
        if (
          node.arguments.some(ts.isSpreadElement)
        )
          return fail(node, "Verified calls require explicit data arguments without spread");
        const resolved = runtime ? runtime.resolve(value, node.expression) : statics.resolve(node.expression, value.env);
        if (resolved.kind !== "function")
          return fail(node, "Call target must resolve to a function");
        const signature = checker.getResolvedSignature(node);
        if (!signature) return fail(node, "Unresolved call signature");
        const typeArguments = (resolved.node.typeParameters ?? []).map((parameter, i) => {
          const explicit = node.typeArguments?.[i];
          if (explicit) return typeShape(checker.getTypeFromTypeNode(explicit), explicit);
          // The native signature API exposes instantiated value parameters, not
          // a generic mapper. Infer only a direct T parameter, never by ordinal.
          const position = resolved.node.parameters.findIndex(p =>
            p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName) &&
            p.type.typeName.text === parameter.name.text && !p.type.typeArguments?.length);
          if (position < 0) return fail(node,
            "Generic helpers need explicit type arguments or a direct type-parameter input");
          return typeShape(checker.getParameterType(signature, position), node);
        });
        const returnShape = typeShape(checker.getReturnTypeOfSignature(signature), node);
        const callee = compileFunction(resolved, typeArguments);
        same(callee.output, returnShape, node);
        if (node.arguments.length !== resolved.node.parameters.length)
          return fail(node, "Verified call argument count must match the declaration");
        const argument: Expr = callee.parameterNames ? {
          kind: "record", shape: callee.input,
          fields: callee.parameterNames.map((name, i) => {
            const field = (callee.input as Extract<Shape, {kind: "record"}>).fields.find(f => f.name === name)!;
            return { name, value: coerce(expression(node.arguments[i]!, scope, field.shape), field.shape, node.arguments[i]!) };
          }),
        } : !node.arguments.length ? {kind:"literal",shape:{kind:"unit"},value:"()"} : coerce(
          expression(node.arguments[0]!, scope, callee.input),
          callee.input,
          node,
        );
        same(argument.shape, callee.input, node);
        dependencies.add(callee.name);
        const reference = node.expression.getText();
        calls.set(reference, { target: callee.name, reference });
        return {
          kind: "call",
          fn: callee.name,
          argument,
          shape: callee.output,
        };
      }
      return fail(node, `Unsupported expression: ${ts.SyntaxKind[node.kind]}`);
    };
    const awaited = (node: ts.AwaitExpression, scope: typeof locals): Extract<Term,{kind:"await"}>["call"] => {
      if (!ports || !runtime || !asyncFunction) return fail(node,"Await requires a verified async use-case");
      const call = node.expression;
      if (!ts.isCallExpression(call) || call.arguments.some(ts.isSpreadElement))
        return fail(node,"Await a direct port or async helper call with pure arguments");
      const resolved = runtime.resolve(value, call.expression);
      const signature = checker.getResolvedSignature(call);
      if (!signature) return fail(call,"Unresolved awaited call signature");
      const params = signature.getParameters();
      if (params.length !== call.arguments.length) return fail(call,"Awaited calls require all declared arguments");
      const outputType = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
      if (!outputType) return fail(call,"Unsupported promise/thenable result");
      const output = typeShape(outputType,call);
      const argumentShape = params.length === 0 ? {kind:"unit"} as Shape : params.length===1
        ? typeShape(checker.getParameterType(signature,0),call)
        : intern(params.map((p,i)=>({name:p.name,shape:typeShape(checker.getParameterType(signature,i),call)})));
      let target: string, kind: "port"|"function", expectedInput: Shape, expectedOutput:Shape;
      if (resolved.kind === "port") {
        const port=ports[resolved.index];
        if (!port) return fail(call,"Missing bound port contract");
        target=port.name; kind="port"; expectedInput=port.input; expectedOutput=port.output;
      } else if (resolved.kind === "function") {
        if (!resolved.node.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword))
          return fail(call,"Awaited helpers must be declared async; pure helpers are ordinary calls");
        const types=(resolved.node.typeParameters??[]).map((_,i)=> {
          const t=call.typeArguments?.[i];
          if(!t)return fail(call,"Async generic helpers require explicit concrete type arguments");
          return typeShape(checker.getTypeFromTypeNode(t),t);
        });
        const callee=compileFunction(resolved,types);
        dependencies.add(callee.name);
        calls.set(call.expression.getText(),{target:callee.name,reference:call.expression.getText()});
        target=callee.name; kind="function"; expectedInput=callee.input;expectedOutput=callee.output;
      } else return fail(call,"Await target must be an explicitly bound port or registered async helper");
      same(argumentShape,expectedInput,call); same(output,expectedOutput,call);
      const argument:Expr = params.length===0 ? {kind:"literal",shape:{kind:"unit"},value:"()"} : params.length===1
        ? coerce(expression(call.arguments[0]!,scope,expectedInput),expectedInput,call)
        : {kind:"record",shape:expectedInput,fields:params.map((p,i)=>{
          const field=(expectedInput as Extract<Shape,{kind:"record"}>).fields.find(f=>f.name===p.name)!;
          return {name:p.name,value:coerce(expression(call.arguments[i]!,scope,field.shape),field.shape,call)};
        })};
      return {kind,target,argument,output:expectedOutput};
    };
    // A continuation captures the enclosing scope. Early returns never evaluate it.
    const sequence = (
      statements: readonly ts.Statement[],
      scope: typeof locals,
      continuation: (scope: typeof locals) => Term,
    ): Term => {
      const [st, ...rest] = statements;
      if (!st) return continuation(scope);
      const project = (updated: typeof locals) =>
        new Map(
          [...scope].map(([key, value]) => [key, updated.get(key) ?? value]),
        );
      const next = (updated: typeof locals = scope): Term =>
        sequence(rest, project(updated), continuation);
      if (ts.isReturnStatement(st)) {
        if (!st.expression) {
          if(fn.output.kind !== "unit")return fail(st,"Return a value.");
          if(rest.length)return fail(rest[0]!,"Unreachable statements are unsupported.");
          return {kind:"return",value:{kind:"literal",shape:{kind:"unit"},value:"()"}};
        }
        if (rest.length)
          return fail(rest[0]!, "Unreachable statements are unsupported.");
        if (ts.isAwaitExpression(st.expression)) {
          const call=awaited(st.expression,scope), name=`v${counter++}`;
          return {kind:"await",call,name,next:{kind:"return",value:coerce({kind:"variable",name,shape:call.output},fn.output,st)}};
        }
        const value = coerce(
          expression(st.expression, scope, fn.output),
          fn.output,
          st,
        );
        same(value.shape, fn.output, st);
        return { kind: "return", value };
      }
      if (ts.isVariableStatement(st)) {
        if (!(st.declarationList.flags & ts.NodeFlags.BlockScoped))
          return fail(st, "Use const or let; var hoisting is unsupported.");
        const inner = new Map(scope);
        const bindings = st.declarationList.declarations.map((d) => {
          if (!d.initializer)
            return fail(d, "Only initialized const bindings are supported.");
          const declared = d.type
            ? typeShape(checker.getTypeFromTypeNode(d.type), d.type)
            : undefined;
          if (ts.isAwaitExpression(d.initializer)) {
            const call=awaited(d.initializer,inner),name=`v${counter++}`;
            if(declared)same(call.output,declared,d);
            bindData(d.name,{kind:"variable",name,shape:call.output},inner);
            if (!(st.declarationList.flags & ts.NodeFlags.Const))
              for (const key of inner.keys()) if(!scope.has(key))mutable.add(key);
            return {name,call};
          }
          let value = expression(d.initializer, inner, declared);
          if (declared) value = coerce(value, declared, d);
          const name = `v${counter++}`;
          bindData(
            d.name,
            { kind: "variable", name, shape: value.shape },
            inner,
          );
          if (!(st.declarationList.flags & ts.NodeFlags.Const))
            for (const key of inner.keys())
              if (!scope.has(key)) mutable.add(key);
          return { name, value };
        });
        return bindings.reduceRight<Term>(
          (next, b) => b.call ? {kind:"await",name:b.name,call:b.call,next} : ({ kind: "let", name:b.name,value:b.value!, next }),
          sequence(rest, inner, continuation),
        );
      }
      if (ts.isExpressionStatement(st)) {
        const e = st.expression;
        if (ts.isAwaitExpression(e)) return {kind:"await",name:`v${counter++}`,call:awaited(e,scope),next:next()};
        let target: ts.Expression, value: Expr;
        if (
          ts.isBinaryExpression(e) &&
          ["=", "+=", "-=", "*="].includes(e.operatorToken.getText())
        ) {
          target = e.left;
          const right = expression(e.right, scope),
            op = e.operatorToken.getText();
          if (op === "=") value = right;
          else {
            const left = expression(target, scope);
            same(left.shape, int, e);
            same(right.shape, int, e);
            value = {
              kind: "binary",
              operator: op.slice(0, -1),
              left,
              right,
              shape: int,
            };
          }
        } else if (
          (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) &&
          (e.operator === ts.SyntaxKind.PlusPlusToken ||
            e.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          target = e.operand;
          const left = expression(target, scope);
          same(left.shape, int, e);
          value = {
            kind: "binary",
            operator: e.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-",
            left,
            right: { kind: "literal", value: "1", shape: int },
            shape: int,
          };
        } else
          return fail(
            e,
            "Only local assignments and standalone increments are supported as expression statements",
          );
        if (!ts.isIdentifier(target))
          return fail(target, "Heap and property mutations are unsupported");
        const key = symbol(target),
          old = scope.get(key);
        if (!old || !mutable.has(key))
          return fail(target, "Assignment requires a local mutable binding");
        same(old.shape, value.shape, e);
        const name = `v${counter++}`,
          inner = new Map(scope);
        inner.set(key, { kind: "variable", name, shape: value.shape });
        return {
          kind: "let",
          name,
          value,
          next: sequence(rest, inner, continuation),
        };
      }
      if (ts.isIfStatement(st)) {
        const d = discriminant(st.expression, scope);
        if (d)
          return {
            kind: "match",
            object: d.object,
            branches: narrowed(d, scope).map((b) => ({
              ...b,
              body: sequence(statements, b.scope, continuation),
            })),
          };
        const condition = expression(st.expression, scope);
        same(condition.shape, bool, st.expression);
        const branch = (s: ts.Statement | undefined): Term =>
          sequence(
            s ? (ts.isBlock(s) ? s.statements : [s]) : [],
            new Map(scope),
            next,
          );
        if (condition.kind === "literal")
          return branch(
            condition.value === "true" ? st.thenStatement : st.elseStatement,
          );
        return {
          kind: "if",
          condition,
          yes: branch(st.thenStatement),
          no: branch(st.elseStatement),
        };
      }
      if (ts.isBlock(st)) return sequence(st.statements, new Map(scope), next);
      return fail(st, `Unsupported statement: ${ts.SyntaxKind[st.kind]}`);
    };
    const body = ts.isBlock(fn.node.body!)
      ? sequence((fn.node.body as ts.Block).statements, locals, () =>
          fn.output.kind === "unit" ? {kind:"return",value:{kind:"literal",value:"()",shape:fn.output}}
          : fail(fn.node, "Every control-flow path must return a value"),
        )
      : {
          kind: "return" as const,
          value: coerce(
            expression(fn.node.body as ts.Expression, locals, fn.output),
            fn.output,
            node,
          ),
        };
    if (body.kind === "return") same(body.value.shape, fn.output, node);
    const result: FunctionIR = {
      async:asyncFunction,
      name: fn.name,
      source: node.getSourceFile().fileName,
      sourceHash: createHash("sha256").update(node.getSourceFile().text).digest("hex"),
      span: {start:node.getStart(), end:node.end,
        startLine:node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
        endLine:node.getSourceFile().getLineAndCharacterOfPosition(node.end).line + 1},
      parameter: fn.parameter,
      ...(parameterFields ? { parameterNames: parameterFields.map(p => p.name) } : {}),
      input: fn.input,
      output: fn.output,
      body,
      dependencies: [...dependencies],
      localName: functionIdentity(node),
      snapshot: runtime?.context(value).snapshot.id,
      instance: runtime?.identity(value),
      calls: [...calls.values()],
      captures: [...captures.values()],
    };
    compiling.delete(value);
    const specializations = compiled.get(value) ?? new Map<string, FunctionIR>();
    specializations.set(specialization, result);
    compiled.set(value, specializations);
    functions.push(result);
    return result;
    } finally { program = previousProgram; checker = previousChecker; typeBindings = previousBindings; }
  };
  const root=targetValue as StaticFunction;
  const bindGeneric=(type:Type, expected:Shape, at:ts.Node):void=>{
    if(type.flags & TypeFlags.TypeParameter) {
      const old=typeBindings.get(type);
      if(old)same(old,expected,at); else typeBindings.set(type,expected);
      return;
    }
    if(expected.kind==="array" && checker.isArrayType(type)) {
      bindGeneric(checker.getIndexTypeOfType(type,IndexKind.Number)!,expected.element,at);return;
    }
    if(expected.kind==="optional"&&type.isUnionType()) {
      const defined=type.getTypes().filter(t=>!(t.flags&TypeFlags.Undefined));
      if(defined.length===1)bindGeneric(defined[0]!,expected.element,at);
      return;
    }
    if(expected.kind==="union"&&type.isUnionType()) {
      for(const member of type.getTypes()) {
        const tag=checker.getTypeOfPropertyOfType(member,expected.tag);
        const variant=tag&&(tag.isStringLiteralType()||tag.isBooleanLiteralType())&&expected.variants.find(v=>v.tag===tag.value);
        if(!variant)return fail(at,"Generic union discriminants do not match the contract");
        for(const f of variant.fields) {
          const t=checker.getTypeOfPropertyOfType(member,f.name);
          if(t)bindGeneric(t,f.shape,at);
        }
      }
      return;
    }
    if(expected.kind==="record")for(const f of expected.fields) {
      const t=checker.getTypeOfPropertyOfType(type,f.name);
      if(t)bindGeneric(t,f.shape,at);
    }
  };
  if(runtime)({program,checker}=runtime.context(root));
  if(root.node.typeParameters?.length) {
    root.node.parameters.forEach(p=>{
      const name=ts.isIdentifier(p.name)?p.name.text:undefined;
      const expected=root.node.parameters.length===1?contract.input:contract.input.kind==="record"&&ts.isIdentifier(p.name)
        ?contract.input.fields.find(f=>f.name===name)?.shape:undefined;
      if(expected)bindGeneric(checker.getTypeAtLocation(p),expected,p);
    });
    bindGeneric(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(root.node)!),contract.output,root.node);
  }
  const genericArguments=(root.node.typeParameters??[]).map(p=>{
    if(p.constraint)return fail(p,"Constrained generic roots require an explicit concrete wrapper");
    const shape=typeBindings.get(checker.getTypeAtLocation(p));
    if(!shape)return fail(p,"Cannot infer generic parameter from the contract");
    return shape;
  });
  const target = compileFunction(root,genericArguments);
  const requiresSnapshot=(v:unknown):boolean=>!!v&&typeof v==="object"&&(
    ["array","safeinteger","snapshot","optional","builtin"].includes((v as {kind?:string}).kind??"")||Object.values(v).some(requiresSnapshot));
  if(requiresSnapshot(functions)&&contract.dataProfile!=="snapshot")
    throw new Failure("unsupported","Array, safe-integer and opaque data verification requires an explicit #ts2lean_snapshot_profile on the Lean contract");
  if(ports&&requiresSnapshot(functions))
    throw new Failure("unsupported","Snapshot safety obligations are currently supported in pure function and state-machine verification only");
  if(contract.kind==="state-machine") {
    const field=target.input.kind==="record"&&target.input.fields.find(f=>f.name==="state");
    if(!field||shapeKey(field.shape)!==shapeKey(target.output))
      throw new Failure("type-error","A reducer must accept an actual state field/parameter matching its output state type");
  }
  if (
    shapeKey(target.input) !== shapeKey(contract.input) ||
    shapeKey(target.output) !== shapeKey(contract.output)
  )
    throw new Failure(
      "type-error",
      "TypeScript signature does not match the Lean contract.",
    );
  const sorted: FunctionIR[] = [],
    visited = new Set<string>(),
    active = new Set<string>();
  const visit = (fn: FunctionIR): void => {
    if (active.has(fn.name))
      throw new Failure("unsupported", "Recursive calls are unsupported.");
    if (visited.has(fn.name)) return;
    active.add(fn.name);
    for (const d of fn.dependencies)
      visit(functions.find((f) => f.name === d)!);
    active.delete(fn.name);
    visited.add(fn.name);
    sorted.push(fn);
  };
  for (const fn of functions) visit(fn);
  return {
    ...(contract.dataProfile==="snapshot"?{dataProfile:"snapshot" as const}:{}),
    functions: sorted,
    records: generated,
    declarations,
    target: target.name,
    compositionChecks: statics.checks,
    runtimeModules: sourceFiles
      .filter((sf) =>
        sf.statements.some(
          (st) => ts.isFunctionDeclaration(st) || ts.isVariableStatement(st),
        ),
      )
      .map((sf) => sf.fileName),
    sourceHashes: Object.fromEntries(
      sourceFiles.map((sf) => [
        sf.fileName,
        createHash("sha256").update(sf.text).digest("hex"),
      ]),
    ),
  };
}

/** Resolve Lean type imports in the same local source graph used by the compiler. */
export function importedLeanFiles(entry: string, project?: TypeScriptProject): string[] {
  const files = new Set<string>(),
    seen = new Set<string>();
  const options = projectCompilerOptions(project);
  return withAPI((api) => {
    const resolver = api.createModuleResolver(options);
    try {
      const visit = (file: string): void => {
        file = path.resolve(file);
        if (seen.has(file)) return;
        seen.add(file);
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        const lease = api.createSourceFile(file, text);
        try {
          const imports = new Set<string>();
          const collect = (node: ts.Node): void => {
            if (
              (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
              node.moduleSpecifier &&
              ts.isStringLiteral(node.moduleSpecifier)
            )
              imports.add(node.moduleSpecifier.text);
            if (
              ts.isStringLiteral(node) &&
              (ts.isExternalModuleReference(node.parent) ||
                (ts.isLiteralTypeNode(node.parent) &&
                  ts.isImportTypeNode(node.parent.parent)) ||
                (ts.isCallExpression(node.parent) &&
                  (node.parent.expression.kind ===
                    ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.parent.expression) &&
                      node.parent.expression.text === "require"))))
            )
              imports.add(node.text);
            node.forEachChild(collect);
          };
          collect(lease.sourceFile);
          for (const name of imports) {
            if (name.endsWith(".lean") && name.startsWith("."))
              files.add(path.resolve(path.dirname(file), name));
            else {
              const resolved = resolver.resolveModuleName(
                name,
                path.dirname(file),
              ).resolvedModule;
              if (
                resolved &&
                !resolved.isExternalLibraryImport &&
                !resolved.resolvedFileName.endsWith(".d.ts")
              )
                visit(resolved.resolvedFileName);
            }
          }
        } finally {
          lease.dispose();
        }
      };
      visit(entry);
      return [...files];
    } finally {
      resolver.dispose();
    }
  });
}
