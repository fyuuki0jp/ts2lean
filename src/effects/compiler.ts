import { ts, getLibFiles } from "@ts-morph/common";
import path from "node:path";
import { createHash } from "node:crypto";
import { Failure, type ContractInfo, type ModuleMetadata } from "../types.js";
import { contractTypes } from "../verify.js";
import { lowerCallback, type StatementIR } from "./structured.js";

export type ValueType =
  | "request"
  | "option"
  | "int"
  | "string"
  | "bool"
  | "void"
  | "list"
  | "receipt"
  | "helper"
  | "exception";
export interface Value {
  type: ValueType;
  lean: string;
  origin?: string;
  unsafe?: boolean;
}
export interface Parameter {
  name: string;
  type: "Request" | "Int" | "String" | "ExceptionValue";
}
export interface PathState {
  state: string;
  conditions: string[];
  variables: Parameter[];
  env: Map<ts.Symbol, Value>;
  retryOriginal?: string;
  result?: Value;
  control?: "return" | "throw";
  writes: string[];
  trace: string[];
  contextualOptions?: boolean;
}
export interface TxPath {
  state: string;
  conditions: string[];
  variables: Parameter[];
  result: Value;
  writes: string[];
  trace: string[];
}
export interface TxCompletion extends TxPath {
  control: "normal" | "return" | "throw";
}
export interface TransactionSite {
  expected?: string;
  id: number;
  file: string;
  line: number;
  captures: Parameter[];
  paths: TxPath[];
  completions: TxCompletion[];
  program: StatementIR[];
}
export interface EffectFunction {
  file: string;
  name: string;
  export: string;
  hash: string;
  calls: { reference: string; target: string }[];
  objects: string[];
}
export interface ModuleBinding {
  reference: string;
  file: string;
  name: string;
  hash: string;
  declaration: string;
  spec: string;
  metadata: ModuleMetadata;
}
export interface EffectIR {
  functions: EffectFunction[];
  modules: ModuleBinding[];
  transactions: TransactionSite[];
  retryObligations: {
    parameters: Parameter[];
    conditions?: string[];
    actual: string;
    original: string;
    file: string;
    line: number;
  }[];
  returnObligations: {
    parameters: Parameter[];
    result: string;
    file: string;
    line: number;
  }[];
}
// Encode Lean literals character by character: rewriting JSON escape text can
// accidentally rewrite a *literal* backslash-u sequence as a different value.
const quote = (text: string): string =>
  '"' +
  Array.from(text)
    .map((char) => {
      const cp = char.codePointAt(0)!;
      if (cp >= 0xd800 && cp <= 0xdfff)
        throw new Failure(
          "unsupported",
          "Lone UTF-16 surrogates require a UTF-16 string model",
        );
      if (char === "\\") return "\\\\";
      if (char === '"') return '\\"';
      if (cp < 32 || cp === 127 || cp === 0x2028 || cp === 0x2029)
        return "\\u" + cp.toString(16).padStart(4, "0");
      return char;
    })
    .join("") +
  '"';
const field = (v: string, n: string) => `(${v}).«${n}»`;
const clone = (p: PathState): PathState => ({
  ...p,
  conditions: [...p.conditions],
  variables: [...p.variables],
  env: new Map(p.env),
  writes: [...p.writes],
  trace: [...p.trace],
});

export function compileEffects(
  entries: { file: string; name: string }[],
  declarations: Map<string, ContractInfo[]>,
  operation = false,
): EffectIR {
  const virtual = new Map(
    [...declarations].map(([file, infos]) => [
      path.resolve(file) + ".ts",
      contractTypes(infos),
    ]),
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options),
    read = host.readFile.bind(host),
    exists = host.fileExists.bind(host);
  const libDir = path.dirname(ts.getDefaultLibFilePath(options));
  const libs = new Map(
    getLibFiles().map((l) => [path.join(libDir, l.fileName), l.text]),
  );
  host.readFile = (f) =>
    virtual.get(path.resolve(f)) ?? libs.get(path.resolve(f)) ?? read(f);
  host.fileExists = (f) =>
    virtual.has(path.resolve(f)) || libs.has(path.resolve(f)) || exists(f);
  host.resolveModuleNames = (names, containing) =>
    names.map((name) =>
      name.endsWith(".lean")
        ? virtual.has(path.resolve(path.dirname(containing), name) + ".ts")
          ? {
              resolvedFileName:
                path.resolve(path.dirname(containing), name) + ".ts",
              extension: ts.Extension.Ts,
            }
          : undefined
        : ts.resolveModuleName(name, containing, options, host).resolvedModule,
    );
  const program = ts.createProgram(
      entries.map((e) => path.resolve(e.file)),
      options,
      host,
    ),
    checker = program.getTypeChecker();
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length)
    throw new Failure(
      "type-error",
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (f) => f,
        getNewLine: () => "\n",
      }),
    );
  const ir: EffectIR = {
    functions: [],
    modules: [],
    transactions: [],
    retryObligations: [],
    returnObligations: [],
  };
  const fail = (n: ts.Node, msg: string): never => {
    const sf = n.getSourceFile(),
      p = sf.getLineAndCharacterOfPosition(n.getStart());
    throw new Failure(
      "unsupported",
      `${sf.fileName}:${p.line + 1}:${p.character + 1}: ${msg}`,
    );
  };
  const symbol = (n: ts.Node): ts.Symbol => {
    let s = checker.getSymbolAtLocation(n);
    if (!s) return fail(n, "Unresolved symbol");
    if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const unwrap = (n: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;
  const lawTypes = (
    n: ts.Node,
    seen = new Set<ts.Symbol>(),
  ): { spec: string; info: ContractInfo }[] => {
    const s = symbol(
      ts.isTypeReferenceNode(n)
        ? n.typeName
        : ts.isExpressionWithTypeArguments(n)
          ? n.expression
          : n,
    );
    if (seen.has(s)) return [];
    seen.add(s);
    const found: { spec: string; info: ContractInfo }[] = [];
    for (const d of s.declarations ?? []) {
      const file = path.resolve(d.getSourceFile().fileName);
      for (const [spec, infos] of declarations)
        if (file === path.resolve(spec) + ".ts")
          for (const info of infos) {
            if (
              info.kind === "module" &&
              info.module!.interfaces.some(
                (i) =>
                  i.name === s.name &&
                  i.methods.some((m) => m.operation === "transaction"),
              )
            )
              found.push({ spec, info });
          }
      if (ts.isTypeAliasDeclaration(d)) {
        if (ts.isTypeReferenceNode(d.type))
          found.push(...lawTypes(d.type, seen));
        else if (ts.isIntersectionTypeNode(d.type))
          for (const t of d.type.types) found.push(...lawTypes(t, seen));
      }
      if (ts.isInterfaceDeclaration(d))
        for (const h of d.heritageClauses ?? [])
          for (const t of h.types) found.push(...lawTypes(t, seen));
    }
    return found;
  };
  const moduleFor = (id: ts.Identifier): ModuleBinding => {
    const s = symbol(id),
      d = s.valueDeclaration;
    if (!d || !ts.isVariableDeclaration(d))
      return fail(
        id,
        "DB module must have an explicit Lean-derived module type",
      );
    let type = d.type;
    if (d.initializer && ts.isSatisfiesExpression(unwrap(d.initializer)))
      type = (unwrap(d.initializer) as ts.SatisfiesExpression).type;
    if (!type)
      return fail(
        id,
        "DB module needs a Lean-derived interface annotation or satisfies expression",
      );
    const laws = lawTypes(type),
      unique = new Map(
        laws.map((l) => [path.resolve(l.spec) + "#" + l.info.name, l]),
      );
    if (unique.size !== 1)
      return fail(
        id,
        `Expected one nominal Lean module law, found ${unique.size}; structural type similarity is not a law binding`,
      );
    const law = [...unique.values()][0]!;
    if (law.info.module!.profile !== "ledger-v1")
      return fail(id, "Unsupported module semantics profile");
    const file = d.getSourceFile().fileName;
    const binding: ModuleBinding = {
      reference: id.text,
      file,
      name: s.name,
      hash: createHash("sha256").update(d.getSourceFile().text).digest("hex"),
      declaration: law.info.name,
      spec: law.spec,
      metadata: law.info.module!,
    };
    if (
      !ir.modules.some(
        (m) =>
          m.file === file && m.name === binding.name && m.reference === id.text,
      )
    )
      ir.modules.push(binding);
    return binding;
  };
  let fresh = 0;
  const variable = (type: Parameter["type"], parameters: Parameter[]) => {
    const name = `v${fresh++}`;
    parameters.push({ name, type });
    return name;
  };
  const value = (n: ts.Expression, p: PathState): Value => {
    n = unwrap(n);
    if (ts.isAwaitExpression(n))
      return fail(n, "Await must be lowered as a sequential effect");
    if (ts.isIdentifier(n)) {
      const sym = symbol(n),
        v = p.env.get(sym);
      if (
        !v &&
        n.text === "undefined" &&
        !sym.valueDeclaration &&
        checker.getTypeAtLocation(n).flags & ts.TypeFlags.Undefined
      )
        return { type: "void", lean: "()" };
      if (!v) return fail(n, "Unbound or mutable captured value");
      if (
        p.contextualOptions &&
        v.type === "option" &&
        checker.getPropertyOfType(checker.getTypeAtLocation(n), "operationId")
      )
        return { ...v, type: "request", lean: `requestValue (${v.lean})` };
      return v;
    }
    if (ts.isBigIntLiteral(n))
      return {
        type: "int",
        lean: `(${BigInt(n.text.replaceAll("_", "").slice(0, -1))} : Int)`,
      };
    if (ts.isStringLiteral(n)) return { type: "string", lean: quote(n.text) };
    if (
      n.kind === ts.SyntaxKind.TrueKeyword ||
      n.kind === ts.SyntaxKind.FalseKeyword
    )
      return {
        type: "bool",
        lean: n.kind === ts.SyntaxKind.TrueKeyword ? "True" : "False",
      };
    if (n.kind === ts.SyntaxKind.NullKeyword)
      return { type: "option", lean: "none" };
    if (ts.isPropertyAccessExpression(n)) {
      const a = value(n.expression, p);
      if (a.type !== "request")
        return fail(n, "Properties require a narrowed request record");
      if (!["operationId", "from", "to", "amount"].includes(n.name.text))
        return fail(n, "Unknown request field");
      return {
        type: n.name.text === "amount" ? "int" : "string",
        lean: field(a.lean, n.name.text),
        origin: a.origin,
      };
    }
    if (ts.isObjectLiteralExpression(n)) {
      const fields = new Map<string, Value>();
      let origin: string | undefined;
      for (const prop of n.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const v = value(prop.expression, p);
          if (v.type !== "request")
            return fail(prop, "Only request record spreads are supported");
          origin = v.origin;
          for (const f of ["operationId", "from", "to", "amount"])
            fields.set(f, {
              type: f === "amount" ? "int" : "string",
              lean: field(v.lean, f),
            });
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name))
          fields.set(prop.name.text, value(prop.initializer, p));
        else if (ts.isShorthandPropertyAssignment(prop)) {
          const s = checker.getShorthandAssignmentValueSymbol(prop),
            v = s && p.env.get(s);
          if (!v) return fail(prop, "Unknown shorthand");
          fields.set(prop.name.text, v);
        } else return fail(prop, "Unsupported record element");
      }
      if (
        fields.size !== 4 ||
        !["operationId", "from", "to", "amount"].every((f) => fields.has(f))
      )
        return fail(n, "Expected complete transfer request record");
      return {
        type: "request",
        lean: `({ ${[...fields].map(([f, v]) => `«${f}» := ${v.lean}`).join(", ")} } : Request)`,
        origin,
      };
    }
    if (ts.isPrefixUnaryExpression(n)) {
      const v = value(n.operand, p);
      if (n.operator === ts.SyntaxKind.MinusToken && v.type === "int")
        return { type: "int", lean: `(-${v.lean})` };
      if (n.operator === ts.SyntaxKind.ExclamationToken)
        return { type: "bool", lean: `¬ (${truth(v)})` };
      return fail(n, "Unsupported unary expression");
    }
    if (ts.isBinaryExpression(n)) {
      const a = value(n.left, p),
        b = value(n.right, p),
        op = n.operatorToken.getText();
      const operators: Record<string, string> = {
        "===": "=",
        "!==": "≠",
        "<": "<",
        "<=": "≤",
        ">": ">",
        ">=": "≥",
        "&&": "∧",
        "||": "∨",
        "+": "+",
        "-": "-",
        "*": "*",
      };
      if (!operators[op]) return fail(n, "Unsupported operator");
      if (["+", "-", "*"].includes(op)) {
        if (
          a.type !== b.type ||
          !["int", "string"].includes(a.type) ||
          (a.type === "string" && op !== "+")
        )
          return fail(n, "Invalid arithmetic");
        return {
          type: a.type,
          lean: `(${a.lean} ${a.type === "string" ? "++" : op} ${b.lean})`,
        };
      }
      const nullComparison =
        ["===", "!=="].includes(op) &&
        a.type === "option" &&
        b.type === "option" &&
        (a.lean === "none" || b.lean === "none");
      if (
        !nullComparison &&
        ["===", "!=="].includes(op) &&
        (!["int", "string", "bool"].includes(a.type) || a.type !== b.type)
      )
        return fail(
          n,
          "Equality is supported only for scalars (record identity is not structural equality)",
        );
      if (["&&", "||"].includes(op) && (a.type !== "bool" || b.type !== "bool"))
        return fail(n, "Logical operators require booleans");
      if (
        ["<", "<=", ">", ">="].includes(op) &&
        (a.type !== "int" || b.type !== "int")
      )
        return fail(n, "Ordering requires bigint");
      return { type: "bool", lean: `(${a.lean} ${operators[op]} ${b.lean})` };
    }
    if (ts.isConditionalExpression(n)) {
      const condition = value(n.condition, p),
        yes = value(n.whenTrue, p),
        no = value(n.whenFalse, p);
      if (
        yes.type !== no.type ||
        !["int", "string", "bool", "request"].includes(yes.type)
      )
        return fail(
          n,
          "Conditional branches need the same supported value type",
        );
      return {
        type: yes.type,
        lean: `(if ${truth(condition)} then ${yes.lean} else ${no.lean})`,
      };
    }
    return fail(n, `Unsupported expression ${ts.SyntaxKind[n.kind]}`);
  };
  const truth = (v: Value) =>
    v.type === "option"
      ? `(${v.lean}) ≠ none`
      : v.type === "bool"
        ? v.lean
        : v.type === "request"
          ? "True"
          : (() => {
              throw new Failure(
                "unsupported",
                "Only boolean or nullable-record conditions are supported",
              );
            })();
  const exceptionValue = (node: ts.Expression, p: PathState): string => {
    const n = unwrap(node);
    if (ts.isNewExpression(n)) {
      if (
        !ts.isIdentifier(n.expression) ||
        n.expression.text !== "Error" ||
        (n.arguments?.length ?? 0) > 1
      )
        return fail(n, "Only the standard Error constructor is supported here");
      const declaration = symbol(n.expression).declarations?.[0];
      if (
        !declaration ||
        !libs.has(path.resolve(declaration.getSourceFile().fileName))
      )
        return fail(n, "Shadowed Error constructors are unsupported");
      const message = n.arguments?.[0]
        ? value(n.arguments[0], p)
        : { type: "string", lean: '""' };
      if (message.type !== "string")
        return fail(n, "Error message must be a string");
      return `ExceptionValue.error (${message.lean})`;
    }
    const v = value(n, p);
    if (v.type === "exception") return v.lean;
    if (v.type === "string") return `ExceptionValue.string (${v.lean})`;
    if (v.type === "int") return `ExceptionValue.integer (${v.lean})`;
    if (v.type === "bool") return `ExceptionValue.boolean (decide (${v.lean}))`;
    if (v.type === "option" && v.lean === "none") return "ExceptionValue.null";
    if (v.type === "void") return "ExceptionValue.undefined";
    return fail(
      n,
      "Throwing objects with observable identity is not yet supported",
    );
  };
  const branch = (n: ts.Expression, p: PathState, want: boolean): PathState => {
    n = unwrap(n);
    const q = clone(p);
    if (
      ts.isBinaryExpression(n) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(n.operatorToken.kind)
    ) {
      const left = unwrap(n.left),
        right = unwrap(n.right);
      const operand =
        left.kind === ts.SyntaxKind.NullKeyword
          ? right
          : right.kind === ts.SyntaxKind.NullKeyword
            ? left
            : undefined;
      if (
        operand &&
        ts.isIdentifier(operand) &&
        value(operand, p).type === "option"
      )
        return branch(
          operand,
          p,
          n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
            ? !want
            : want,
        );
    }
    if (
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.ExclamationToken
    )
      return branch(n.operand, p, !want);
    if (ts.isIdentifier(n)) {
      const v = value(n, p);
      if (v.type === "option") {
        if (want) {
          const witness = variable("Request", q.variables);
          q.conditions.push(`${v.lean} = some ${witness}`);
          q.env.set(symbol(n), {
            type: "request",
            lean: witness,
            origin: v.origin,
          });
        } else {
          q.conditions.push(`${v.lean} = none`);
          q.env.set(symbol(n), { type: "option", lean: "none" });
        }
        return q;
      }
    }
    const v = value(n, p);
    q.conditions.push(want ? truth(v) : `¬ (${truth(v)})`);
    return q;
  };
  const analyzed = new Set<ts.Symbol>(),
    active = new Set<ts.Symbol>();
  const functionFor = (
    s: ts.Symbol,
    n: ts.Node,
  ): ts.FunctionDeclaration | ts.ArrowFunction => {
    const d = s.valueDeclaration;
    if (d && ts.isFunctionDeclaration(d) && d.body) return d;
    if (
      d &&
      ts.isVariableDeclaration(d) &&
      d.initializer &&
      ts.isArrowFunction(unwrap(d.initializer))
    )
      return unwrap(d.initializer) as ts.ArrowFunction;
    return fail(
      n,
      "Only statically resolved function declarations and arrow functions are supported",
    );
  };
  const analyze = (s: ts.Symbol, at: ts.Node): void => {
    if (active.has(s))
      return fail(at, "Recursive effect functions are unsupported");
    if (analyzed.has(s)) return;
    active.add(s);
    const fn = functionFor(s, at),
      file = fn.getSourceFile().fileName;
    if (!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
      return fail(fn, "Effect functions must be async");
    const meta: EffectFunction = {
      file,
      name: s.name,
      export: s.name,
      hash: createHash("sha256").update(fn.getSourceFile().text).digest("hex"),
      calls: [],
      objects: [],
    };
    ir.functions.push(meta);
    const captures: Parameter[] = [],
      env = new Map<ts.Symbol, Value>();
    for (const param of fn.parameters) {
      if (
        !ts.isIdentifier(param.name) ||
        param.initializer ||
        param.dotDotDotToken
      )
        return fail(param, "Fixed named parameters are required");
      const type = checker.getTypeAtLocation(param);
      const request = checker.getPropertyOfType(type, "operationId");
      if (request) {
        const properties = checker.getPropertiesOfType(type);
        if (
          properties.length !== 4 ||
          !["operationId", "from", "to", "amount"].every((name) => {
            const property = properties.find((p) => p.name === name);
            if (!property || property.flags & ts.SymbolFlags.Optional)
              return false;
            const t = checker.getTypeOfSymbolAtLocation(property, param);
            return !!(
              t.flags &
              (name === "amount"
                ? ts.TypeFlags.BigIntLike
                : ts.TypeFlags.StringLike)
            );
          })
        )
          return fail(
            param,
            "Request parameters must have exactly string operationId/from/to and bigint amount fields",
          );
      }
      const scalar =
        type.flags & ts.TypeFlags.StringLike
          ? "String"
          : type.flags & ts.TypeFlags.BigIntLike
            ? "Int"
            : undefined;
      if (!request && !scalar)
        return fail(
          param,
          "Effect profile accepts request, string and bigint parameters",
        );
      const name = variable(scalar ?? "Request", captures);
      env.set(symbol(param.name), {
        type: request ? "request" : scalar === "Int" ? "int" : "string",
        lean: name,
        unsafe: !!request,
      });
    }
    const base: PathState = {
      state: "s",
      retryOriginal: captures.find((p) => p.type === "Request")?.name,
      conditions: [],
      variables: [],
      env,
      writes: [],
      trace: [],
    };
    const methods = (
      binding: ModuleBinding,
      owner: "Transaction" | "database",
    ) =>
      binding.metadata.interfaces.find((i) =>
        owner === "Transaction"
          ? i.name === owner
          : i.methods.some((m) => m.operation === "transaction"),
      )!.methods;
    const callInfo = (
      call: ts.CallExpression,
      tx?: { symbol: ts.Symbol; binding: ModuleBinding },
    ) => {
      if (
        !ts.isPropertyAccessExpression(call.expression) ||
        !ts.isIdentifier(call.expression.expression)
      )
        return undefined;
      const receiver = call.expression.expression,
        methodName = call.expression.name.text;
      if (tx && symbol(receiver) === tx.symbol) {
        const method = methods(tx.binding, "Transaction").find(
          (m) => m.name === methodName,
        );
        if (!method) return fail(call, "Unknown transaction operation");
        return {
          operation: method.operation,
          binding: tx.binding,
          inside: true,
        };
      }
      const binding = moduleFor(receiver),
        method = methods(binding, "database").find(
          (m) => m.name === methodName,
        );
      if (!method) return fail(call, "Unknown module operation");
      if (!meta.objects.includes(receiver.text))
        meta.objects.push(receiver.text);
      return { operation: method.operation, binding, inside: false };
    };
    const evalEffect = (
      n: ts.Expression,
      p: PathState,
      tx?: { symbol: ts.Symbol; binding: ModuleBinding },
    ): { p: PathState; value: Value }[] => {
      n = unwrap(n);
      const awaited = ts.isAwaitExpression(n);
      if (awaited) n = unwrap((n as ts.AwaitExpression).expression);
      if (ts.isCallExpression(n) && !awaited)
        return fail(
          n,
          "Effect calls must be explicitly awaited; fire-and-forget is not modeled",
        );
      if (!ts.isCallExpression(n)) return [{ p, value: value(n, p) }];
      const info = callInfo(n, tx);
      const rejected = (initial: PathState): PathState => {
        const q = clone(initial);
        const error = variable("ExceptionValue", tx ? q.variables : captures);
        return {
          ...q,
          control: "throw",
          result: { type: "exception", lean: error },
        };
      };

      if (!info) {
        if (!ts.isIdentifier(n.expression))
          return fail(n, "Dynamic calls are unsupported");
        if (tx)
          return fail(
            n,
            "Helpers in callbacks must be inlined by the compiler (not yet supported)",
          );
        const callee = symbol(n.expression);
        analyze(callee, n);
        meta.calls.push({
          reference: n.expression.text,
          target: `${callee.valueDeclaration!.getSourceFile().fileName}#${callee.name}`,
        });
        for (const arg of n.arguments) {
          const v = value(arg, p);
          const original = p.retryOriginal ?? v.origin;
          if (original && v.type === "request") {
            const sf = n.getSourceFile();
            ir.retryObligations.push({
              parameters: [...captures, ...p.variables],
              conditions: [...p.conditions],
              actual: field(v.lean, "operationId"),
              original: field(original, "operationId"),
              file: sf.fileName,
              line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            });
          }
        }
        const sig = checker.getSignatureFromDeclaration(functionFor(callee, n));
        const ret =
          sig && checker.getAwaitedType(checker.getReturnTypeOfSignature(sig));
        return [
          {
            p,
            value: {
              type:
                ret?.flags && ret.flags & ts.TypeFlags.Void ? "void" : "helper",
              lean: "()",
            },
          },
          {
            p: rejected(p),
            value: { type: "void", lean: "()" },
          },
        ];
      }
      const op = info.operation;
      if (op === "transaction") {
        if (tx) return fail(n, "Nested transactions are unsupported");
        const cb = n.arguments[0];
        if (
          !cb ||
          !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ||
          cb.parameters.length !== 1 ||
          !ts.isIdentifier(cb.parameters[0]!.name)
        )
          return fail(n, "Transaction requires an inline callback");
        const scope = {
          symbol: symbol(cb.parameters[0]!.name),
          binding: info.binding,
        };
        const site: TransactionSite = {
          id: ir.transactions.length,
          file,
          line:
            cb.getSourceFile().getLineAndCharacterOfPosition(cb.getStart())
              .line + 1,
          captures: [...captures],
          paths: [],
          completions: [],
          program: [],
        };
        ir.transactions.push(site);
        const start = {
          ...clone(p),
          state: "s",
          conditions: [],
          variables: [],
          writes: [],
          trace: [],
        };
        // Caller-owned records can change during await. Only local snapshots may be captured.
        for (const [key, v] of start.env) if (v.unsafe) start.env.delete(key);
        site.program = lowerCallback(cb.body, start.env, {
          symbol,
          fail,
          truth,
          pure: (node, env) =>
            value(node, { ...start, env, contextualOptions: true }),
          exception: (node, env) =>
            exceptionValue(node, { ...start, env, contextualOptions: true }),
          operation: (call) => {
            const resolved = callInfo(call, scope);
            if (!resolved?.inside)
              return fail(
                call,
                "Structured callbacks require a registered transaction primitive",
              );
            return resolved.operation;
          },
        });
        const outcomes = ts.isBlock(cb.body)
          ? sequence(cb.body.statements, [start], scope)
          : evalEffect(cb.body, start, scope).map((x) =>
              x.p.control === "throw"
                ? x.p
                : {
                    ...x.p,
                    result: x.value,
                    control: "return" as const,
                  },
            );
        for (const out of outcomes) {
          const completion: TxCompletion = {
            control: out.control ?? "normal",
            state: out.state,
            conditions: out.conditions,
            variables: out.variables,
            result: out.result ?? { type: "void", lean: "()" },
            writes: out.writes,
            trace: out.trace,
          };
          site.completions.push(completion);
          if (out.control !== "throw") site.paths.push(completion);
        }
        if (
          site.paths.some(
            (path) => !["request", "void"].includes(path.result.type),
          )
        )
          return fail(
            cb,
            "Callbacks may only return a request receipt or void",
          );
        const receipt = site.paths.some((path) => path.result.type !== "void");
        if (receipt) {
          const input = captures.find((c) => c.type === "Request");
          if (input) site.expected = input.name;
        }
        return [
          {
            p,
            value: {
              type: receipt ? "receipt" : "void",
              lean: `site${site.id}`,
            },
          },
          {
            p: rejected(p),
            value: { type: "void", lean: "()" },
          },
        ];
      }
      if (!tx) {
        for (const arg of n.arguments) value(arg, p); // Reject hidden effects inside primitive arguments.
        if (op === "request.pending")
          return [
            { p, value: { type: "list", lean: "pending" } },
            {
              p: rejected(p),
              value: { type: "void", lean: "()" },
            },
          ];
        if (op === "balance.get") {
          const name = variable("Int", captures);
          return [
            { p, value: { type: "int", lean: name } },
            {
              p: rejected(p),
              value: { type: "void", lean: "()" },
            },
          ];
        }
        return fail(
          n,
          "Durable writes must be inside an extracted transaction callback",
        );
      }
      if (!info.inside)
        return fail(n, "A callback cannot call methods on the outer DB handle");
      const args = n.arguments.map((a) => value(a, p));
      const q = clone(p);
      q.trace.push(`${op}(${n.arguments.map((a) => a.getText()).join(", ")})`);
      let v: Value = { type: "void", lean: "()" };
      if (op === "request.get")
        v = { type: "option", lean: `(${q.state}).requests ${args[0]!.lean}` };
      else if (op === "ledger.get")
        v = {
          type: "option",
          lean: `lookup (${q.state}).ledger ${args[0]!.lean}`,
        };
      else if (op === "balance.get")
        v = { type: "int", lean: `(${q.state}).balances ${args[0]!.lean}` };
      else if (op === "balance.set") {
        q.state = `setBalance (${q.state}) ${args[0]!.lean} ${args[1]!.lean}`;
        q.writes.push(op);
      } else if (op === "request.insert") {
        if (p.retryOriginal)
          ir.retryObligations.push({
            parameters: [...captures, ...p.variables],
            conditions: [...p.conditions],
            actual: field(args[0]!.lean, "operationId"),
            original: field(p.retryOriginal, "operationId"),
            file,
            line:
              n.getSourceFile().getLineAndCharacterOfPosition(n.getStart())
                .line + 1,
          });
        q.conditions.push(
          `(${q.state}).requests ${field(args[0]!.lean, "operationId")} = none`,
        );
        q.state = `insertRequest (${q.state}) ${args[0]!.lean}`;
        q.writes.push(op);
      } else if (op === "ledger.insert") {
        q.conditions.push(
          `lookup (${q.state}).ledger ${field(args[0]!.lean, "operationId")} = none`,
        );
        q.state = `insertTransfer (${q.state}) ${args[0]!.lean}`;
        q.writes.push(op);
      } else return fail(n, "Unknown primitive semantics");
      // A caught failure may leave earlier local writes, and a write may fail after applying.
      const failedBefore = rejected(p);
      const results = [
        { p: q, value: v },
        { p: failedBefore, value: { type: "void" as const, lean: "()" } },
      ];
      if (q.state !== p.state)
        results.push({
          p: rejected(q),
          value: { type: "void", lean: "()" },
        });
      return results;
    };
    const sequence = (
      statements: readonly ts.Statement[],
      paths: PathState[],
      tx?: { symbol: ts.Symbol; binding: ModuleBinding },
    ): PathState[] => {
      for (const st of statements) {
        paths = paths.flatMap((p) => {
          if (p.control) return [p];
          if (ts.isVariableStatement(st)) {
            if (!(st.declarationList.flags & ts.NodeFlags.Const))
              return fail(st, "Use const bindings; mutation is not modeled");
            let states = [p];
            for (const d of st.declarationList.declarations) {
              if (!ts.isIdentifier(d.name) || !d.initializer)
                return fail(d, "Named initialized const required");
              const id = symbol(d.name);
              states = states.flatMap((s) =>
                s.control
                  ? [s]
                  : evalEffect(d.initializer!, s, tx).map((x) => {
                      x.p.env.set(id, x.value);
                      if (ts.isAwaitExpression(d.initializer!))
                        for (const [key, v] of x.p.env)
                          if (v.unsafe) x.p.env.delete(key);
                      return x.p;
                    }),
              );
            }
            return states;
          }
          if (ts.isExpressionStatement(st))
            return evalEffect(st.expression, p, tx).map((x) => {
              if (ts.isAwaitExpression(st.expression))
                for (const [key, v] of x.p.env)
                  if (v.unsafe) x.p.env.delete(key);
              return x.p;
            });
          if (ts.isReturnStatement(st)) {
            if (!st.expression)
              return [
                {
                  ...p,
                  control: "return",
                  result: { type: "void", lean: "()" },
                },
              ];
            return evalEffect(st.expression, p, tx).map((x) => {
              if (x.p.control === "throw") return x.p;
              if (x.value.type === "helper")
                return fail(
                  st,
                  "Returning a helper result requires an interprocedural result contract (not yet supported)",
                );
              return { ...x.p, control: "return" as const, result: x.value };
            });
          }
          if (ts.isThrowStatement(st)) {
            return [
              {
                ...p,
                control: "throw",
                result: {
                  type: "exception",
                  lean: exceptionValue(st.expression, p),
                },
              },
            ];
          }
          if (ts.isIfStatement(st)) {
            const yes = branch(st.expression, p, true),
              no = branch(st.expression, p, false);
            const body = (s: ts.Statement | undefined, q: PathState) =>
              s ? sequence(ts.isBlock(s) ? s.statements : [s], [q], tx) : [q];
            return [
              ...body(st.thenStatement, yes),
              ...body(st.elseStatement, no),
            ];
          }
          if (ts.isBlock(st)) return sequence(st.statements, [clone(p)], tx);
          if (ts.isTryStatement(st)) {
            const caught = sequence(
              st.tryBlock.statements,
              [clone(p)],
              tx,
            ).flatMap((q) => {
              if (q.control !== "throw" || !st.catchClause) return [q];
              const next = {
                ...clone(q),
                control: undefined,
                result: undefined,
              };
              const binding = st.catchClause.variableDeclaration;
              if (binding) {
                if (!ts.isIdentifier(binding.name))
                  return fail(
                    binding,
                    "Catch destructuring is not yet supported",
                  );
                if (!q.result)
                  return fail(binding, "Missing exception completion");
                next.env.set(symbol(binding.name), q.result);
              }
              return sequence(st.catchClause.block.statements, [next], tx);
            });
            if (!st.finallyBlock) return caught;
            return caught.flatMap((saved) =>
              sequence(
                st.finallyBlock!.statements,
                [{ ...clone(saved), control: undefined, result: undefined }],
                tx,
              ).map((final) =>
                final.control
                  ? final
                  : { ...final, control: saved.control, result: saved.result },
              ),
            );
          }
          if (ts.isEmptyStatement(st)) return [p];
          if (ts.isForOfStatement(st)) {
            if (tx)
              return fail(
                st,
                "Loops inside a transaction are not yet supported",
              );
            const list = value(st.expression, p);
            if (
              list.type !== "list" ||
              !ts.isVariableDeclarationList(st.initializer)
            )
              return fail(st, "Expected pending-request for-of loop");
            const decl = st.initializer.declarations[0];
            if (
              !(st.initializer.flags & ts.NodeFlags.Const) ||
              !decl ||
              !ts.isIdentifier(decl.name)
            )
              return fail(st, "Loop binding must be an identifier");
            const q = clone(p),
              item = variable("Request", captures);
            q.env.set(symbol(decl.name), {
              type: "request",
              lean: item,
              origin: item,
            });
            q.retryOriginal = item;
            // Universal element abstraction, not a finite bound on the number of iterations.
            const outcomes = sequence(
              ts.isBlock(st.statement)
                ? st.statement.statements
                : [st.statement],
              [q],
              tx,
            );
            return [p, ...outcomes.filter((p) => p.control)];
          }
          return fail(
            st,
            `Unsupported effect statement ${ts.SyntaxKind[st.kind]}`,
          );
        });
        if (paths.length > 512)
          throw new Failure("unsupported", "Symbolic path limit exceeded");
      }
      return paths;
    };
    const completed = ts.isBlock(fn.body!)
      ? sequence(fn.body!.statements, [base])
      : evalEffect(fn.body as ts.Expression, base).map((out) =>
          out.p.control === "throw"
            ? out.p
            : { ...out.p, control: "return" as const, result: out.value },
        );
    for (const out of completed)
      if (out.control !== "throw") {
        if (out.result?.type === "helper")
          return fail(fn, "Returning a helper result is not yet supported");
        if (out.result?.type === "request")
          ir.returnObligations.push({
            parameters: [...captures],
            result: out.result.lean,
            file,
            line:
              fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart())
                .line + 1,
          });
      }
    active.delete(s);
    analyzed.add(s);
  };
  for (const entry of entries) {
    const sf = program.getSourceFile(path.resolve(entry.file));
    if (!sf) return fail(program.getSourceFiles()[0]!, "Missing entrypoint");
    const ms = checker.getSymbolAtLocation(sf);
    const s =
      ms && checker.getExportsOfModule(ms).find((s) => s.name === entry.name);
    if (!s) return fail(sf, `Missing export ${entry.name}`);
    if (operation) {
      const fn = functionFor(s, sf);
      const sig = checker.getSignatureFromDeclaration(fn);
      const ret =
        sig && checker.getAwaitedType(checker.getReturnTypeOfSignature(sig));
      if (
        fn.parameters.length !== 1 ||
        !ret ||
        !checker.getPropertyOfType(ret, "operationId")
      )
        return fail(
          fn,
          "Operation contracts require one request parameter and a promised receipt result",
        );
    }
    analyze(s, s.valueDeclaration ?? sf);
  }
  if (new Set(ir.modules.map((m) => m.file + "#" + m.name)).size > 1)
    throw new Failure(
      "unsupported",
      "This effects profile supports one shared database handle",
    );
  return ir;
}
