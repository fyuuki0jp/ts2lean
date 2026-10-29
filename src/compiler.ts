import { createHash } from "node:crypto";
import { ts, getLibFiles } from "@ts-morph/common";
import path from "node:path";
import { Failure, shapeKey, type Shape, type ContractInfo } from "./types.js";
import {
  staticResolver,
  functionIdentity,
  type StaticFunction,
  type CompositionCheck,
} from "./static.js";

export type Expr = { shape: Shape } & (
  | { kind: "literal"; value: string }
  | { kind: "variable"; name: string }
  | { kind: "field"; object: Expr; name: string }
  | { kind: "record"; fields: { name: string; value: Expr }[] }
  | { kind: "unary"; operator: "-" | "!"; value: Expr }
  | { kind: "binary"; operator: string; left: Expr; right: Expr }
  | { kind: "call"; fn: string; argument: Expr }
  | { kind: "conditional"; condition: Expr; yes: Expr; no: Expr }
);
export type Term =
  | { kind: "return"; value: Expr }
  | { kind: "let"; name: string; value: Expr; next: Term }
  | { kind: "if"; condition: Expr; yes: Term; no: Term };
export interface FunctionIR {
  localName: string;
  captures?: { reference: string; type: "int" | "bool"; value: string }[];
  calls: { target: string; reference: string }[];
  name: string;
  source: string;
  parameter: string;
  input: Shape;
  output: Shape;
  body: Term;
  dependencies: string[];
}
export interface ModuleIR {
  sourceHashes: Record<string, string>;
  functions: FunctionIR[];
  records: Extract<Shape, { kind: "record" }>[];
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
): ModuleIR {
  module = path.resolve(module);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const libDir = path.dirname(ts.getDefaultLibFilePath(options));
  const libraries = new Map(
    getLibFiles().map((lib) => [path.join(libDir, lib.fileName), lib.text]),
  );
  const originalRead = host.readFile.bind(host),
    originalExists = host.fileExists.bind(host);
  host.readFile = (file) =>
    virtualFiles.get(path.resolve(file)) ??
    libraries.get(path.resolve(file)) ??
    originalRead(file);
  host.fileExists = (file) =>
    virtualFiles.has(path.resolve(file)) ||
    libraries.has(path.resolve(file)) ||
    originalExists(file);
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      if (name.endsWith(".lean")) {
        const file = path.resolve(path.dirname(containing), name);
        if (virtualFiles.has(file + ".ts"))
          return { resolvedFileName: file + ".ts", extension: ts.Extension.Ts };
        return undefined;
      }
      return ts.resolveModuleName(name, containing, options, host)
        .resolvedModule;
    });
  const program = ts.createProgram([module], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Failure(
      "type-error",
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (f) => f,
        getNewLine: () => "\n",
      }),
    );
  const checker = program.getTypeChecker();
  const records = new Map<string, Extract<Shape, { kind: "record" }>>();
  const generated: Extract<Shape, { kind: "record" }>[] = [];
  const register = (s: Shape): Shape => {
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
    records.set(key, s);
    return s;
  };
  const typeShape = (
    type: ts.Type,
    node: ts.Node,
    seen = new Set<ts.Type>(),
  ): Shape => {
    if (type.flags & ts.TypeFlags.BooleanLike) return bool;
    if (type.flags & ts.TypeFlags.BigIntLike) return int;
    if (!(type.flags & ts.TypeFlags.Object) || type.isUnionOrIntersection())
      return fail(
        node,
        `Only bigint, boolean, and readonly records are supported; got ${checker.typeToString(type)}.`,
      );
    if (seen.has(type)) return fail(node, "Recursive records are unsupported.");
    if (
      checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
      checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length ||
      checker.getIndexInfosOfType(type).length
    )
      return fail(node, "Callable types and index signatures are unsupported.");
    const next = new Set(seen).add(type);
    const props = checker.getPropertiesOfType(type);
    if (!props.length) return fail(node, "Empty records are unsupported.");
    return intern(
      props.map((p) => {
        const decls = p.getDeclarations() ?? [];
        if (
          p.flags & ts.SymbolFlags.Optional ||
          !decls.length ||
          !decls.every(
            (d) =>
              ts.isPropertySignature(d) &&
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
      }),
    );
  };
  const same = (a: Shape, b: Shape, node: ts.Node): void => {
    if (shapeKey(a) !== shapeKey(b))
      fail(node, "Expression and declared contract types differ.");
  };
  const symbol = (node: ts.Node): ts.Symbol => {
    let s = checker.getSymbolAtLocation(node);
    if (!s) return fail(node, "Unresolved symbol.");
    if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const statics = staticResolver(checker, fail);
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile && !virtualFiles.has(path.resolve(sf.fileName)),
    );
  for (const sf of sourceFiles) {
    if (sf.fileName.includes(`${path.sep}node_modules${path.sep}`))
      fail(sf, "External runtime modules are unsupported.");
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        if (!st.importClause) fail(st, "Side-effect imports are unsupported.");
        if (
          (st.moduleSpecifier as ts.StringLiteral).text.endsWith(".lean") &&
          !st.importClause!.isTypeOnly
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
      if (ts.isFunctionDeclaration(st) && st.name && st.body) {
        statics.validateFunction(st);
        continue;
      }
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
  const sf = program.getSourceFile(module)!;
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const [exportName, ...members] = exported.split(".");
  let targetSymbol =
    moduleSymbol &&
    checker.getExportsOfModule(moduleSymbol).find((s) => s.name === exportName);
  if (!targetSymbol)
    throw new Failure("unsupported", `No exported binding ${exported}`);
  if (targetSymbol.flags & ts.SymbolFlags.Alias)
    targetSymbol = checker.getAliasedSymbol(targetSymbol);
  let targetValue = statics.resolveSymbol(targetSymbol, sf, new Map());
  for (const key of members) targetValue = statics.member(targetValue, key, sf);
  if (targetValue.kind !== "function")
    fail(sf, "Select an exported function or service method");
  const functions: FunctionIR[] = [];
  const compiled = new Map<StaticFunction, FunctionIR>();
  const compiling = new Set<StaticFunction>();
  let functionSerial = 0;
  const compileFunction = (value: StaticFunction): FunctionIR => {
    const previous = compiled.get(value);
    if (previous) return previous;
    const node = value.node;
    if (compiling.has(value))
      return fail(node, "Recursive calls are unsupported");
    compiling.add(value);
    statics.validateFunction(node);
    if (node.parameters.length !== 1)
      return fail(
        node,
        "Verified functions take one data input; inject dependencies through a factory",
      );
    const parameter = node.parameters[0]!;
    const signature = checker.getSignatureFromDeclaration(node)!;
    const fn = {
      node,
      name: `fn${functionSerial++}`,
      parameter: "v0",
      input: typeShape(checker.getTypeAtLocation(parameter), parameter),
      output: typeShape(checker.getReturnTypeOfSignature(signature), node),
    };
    let counter = 1;
    const locals = new Map<ts.Symbol, Expr>();
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
    bindData(
      parameter.name,
      { kind: "variable", name: "v0", shape: fn.input },
      locals,
    );
    const mutable = new Set<ts.Symbol>(locals.keys());
    const captures = new Map<
      string,
      { reference: string; type: "int" | "bool"; value: string }
    >();
    const dependencies = new Set<string>();
    const calls = new Map<string, { target: string; reference: string }>();
    const expression = (node: ts.Expression, scope: typeof locals): Expr => {
      if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
        return expression(node.expression, scope);
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
          shape: bool,
          value: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false",
        };
      let base: ts.Expression = node;
      while (ts.isPropertyAccessExpression(base)) base = base.expression;
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
        ts.isIdentifier(base) &&
        !scope.has(symbol(base))
      ) {
        const resolved = statics.resolve(node, value.env);
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
        const field =
          object.shape.kind === "record" &&
          object.shape.fields.find((f) => f.name === node.name.text);
        if (!field) return fail(node, "Unknown record field.");
        return { kind: "field", object, name: field.name, shape: field.shape };
      }
      if (ts.isObjectLiteralExpression(node)) {
        const fields = node.properties.map((p) => {
          if (ts.isShorthandPropertyAssignment(p)) {
            const s = checker.getShorthandAssignmentValueSymbol(p);
            const local = s && scope.get(s);
            if (!local || p.objectAssignmentInitializer)
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
          return { name: p.name.text, value: expression(p.initializer, scope) };
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
          same(value.shape, int, node);
          return { kind: "unary", operator: "-", value, shape: int };
        }
        if (node.operator === ts.SyntaxKind.ExclamationToken) {
          same(value.shape, bool, node);
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
        const left = expression(node.left, scope),
          right = expression(node.right, scope);
        same(left.shape, right.shape, node);
        if (["&&", "||"].includes(operator)) same(left.shape, bool, node);
        else if (["===", "!=="].includes(operator)) {
          if (left.shape.kind === "record")
            return fail(node, "Object identity comparisons are unsupported.");
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
        const condition = expression(node.condition, scope),
          yes = expression(node.whenTrue, scope),
          no = expression(node.whenFalse, scope);
        same(condition.shape, bool, node.condition);
        same(yes.shape, no.shape, node);
        return { kind: "conditional", condition, yes, no, shape: yes.shape };
      }
      if (ts.isCallExpression(node)) {
        if (
          node.arguments.length !== 1 ||
          node.typeArguments?.length ||
          ts.isSpreadElement(node.arguments[0]!)
        )
          return fail(node, "Verified calls require one data argument");
        const resolved = statics.resolve(node.expression, value.env);
        if (resolved.kind !== "function")
          return fail(node, "Call target must resolve to a function");
        const callee = compileFunction(resolved);
        const argument = expression(node.arguments[0]!, scope);
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
        if (!st.expression) return fail(st, "Return a value.");
        if (rest.length)
          return fail(rest[0]!, "Unreachable statements are unsupported.");
        const value = expression(st.expression, scope);
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
          const value = expression(d.initializer, inner);
          if (d.type)
            same(
              typeShape(checker.getTypeFromTypeNode(d.type), d.type),
              value.shape,
              d,
            );
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
          (next, b) => ({ kind: "let", ...b, next }),
          sequence(rest, inner, continuation),
        );
      }
      if (ts.isExpressionStatement(st)) {
        const e = st.expression;
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
        const condition = expression(st.expression, scope);
        same(condition.shape, bool, st.expression);
        const branch = (s: ts.Statement | undefined): Term =>
          sequence(
            s ? (ts.isBlock(s) ? s.statements : [s]) : [],
            new Map(scope),
            next,
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
          fail(fn.node, "Every control-flow path must return a value"),
        )
      : {
          kind: "return" as const,
          value: expression(fn.node.body as ts.Expression, locals),
        };
    if (body.kind === "return") same(body.value.shape, fn.output, node);
    const result: FunctionIR = {
      name: fn.name,
      source: node.getSourceFile().fileName,
      parameter: fn.parameter,
      input: fn.input,
      output: fn.output,
      body,
      dependencies: [...dependencies],
      localName: functionIdentity(node),
      calls: [...calls.values()],
      captures: [...captures.values()],
    };
    compiling.delete(value);
    compiled.set(value, result);
    functions.push(result);
    return result;
  };
  const target = compileFunction(targetValue as StaticFunction);
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
    functions: sorted,
    records: generated,
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
export function importedLeanFiles(entry: string): string[] {
  const files = new Set<string>(),
    seen = new Set<string>();
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const visit = (file: string): void => {
    file = path.resolve(file);
    if (seen.has(file)) return;
    seen.add(file);
    const text = ts.sys.readFile(file);
    if (text === undefined) return; // The compiler reports the missing module precisely.
    for (const imported of ts.preProcessFile(text).importedFiles) {
      const name = imported.fileName;
      if (name.endsWith(".lean") && name.startsWith(".")) {
        files.add(path.resolve(path.dirname(file), name));
      } else {
        const resolved = ts.resolveModuleName(
          name,
          file,
          options,
          ts.sys,
        ).resolvedModule;
        if (
          resolved &&
          !resolved.isExternalLibraryImport &&
          !resolved.resolvedFileName.endsWith(".d.ts")
        )
          visit(resolved.resolvedFileName);
      }
    }
  };
  visit(entry);
  return [...files];
}
