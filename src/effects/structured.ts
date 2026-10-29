import { ts } from "@ts-morph/common";
import type { Value, ValueType } from "./compiler.js";

export type ExpressionIR =
  | { kind: "pure"; value: Value }
  | { kind: "await"; operation: string; arguments: Value[]; type: ValueType };
export type StatementIR =
  | { kind: "let"; name: string; expression: ExpressionIR }
  | { kind: "evaluate"; expression: ExpressionIR }
  | { kind: "return"; expression?: ExpressionIR }
  | { kind: "throw"; exception: string }
  | { kind: "if"; condition: string; yes: StatementIR[]; no: StatementIR[] }
  | { kind: "block"; body: StatementIR[] }
  | {
      kind: "try";
      body: StatementIR[];
      handler?: { name: string; body: StatementIR[] };
      finalizer?: StatementIR[];
    };

export interface LoweringContext {
  symbol(node: ts.Node): ts.Symbol;
  pure(node: ts.Expression, env: Map<ts.Symbol, Value>): Value;
  exception(node: ts.Expression, env: Map<ts.Symbol, Value>): string;
  operation(call: ts.CallExpression): string;
  truth(value: Value): string;
  fail(node: ts.Node, message: string): never;
}

/** Retains the original control tree, including abrupt and failing executions.
 * It is deliberately not built from the optimized successful-path list. */
export function lowerCallback(
  body: ts.ConciseBody,
  initial: Map<ts.Symbol, Value>,
  ctx: LoweringContext,
): StatementIR[] {
  let serial = 0;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const expression = (
    node: ts.Expression,
    env: Map<ts.Symbol, Value>,
  ): ExpressionIR => {
    node = unwrap(node);
    if (ts.isAwaitExpression(node)) {
      const inner = unwrap(node.expression);
      if (ts.isCallExpression(inner)) {
        const operation = ctx.operation(inner);
        const types: Record<string, ValueType> = {
          "request.get": "option",
          "ledger.get": "option",
          "balance.get": "int",
          "balance.set": "void",
          "request.insert": "void",
          "ledger.insert": "void",
        };
        const type = types[operation];
        if (!type) return ctx.fail(inner, "Unsupported structured primitive");
        return {
          kind: "await",
          operation,
          type,
          arguments: inner.arguments.map((a) => ctx.pure(a, env)),
        };
      }
      return { kind: "pure", value: ctx.pure(inner, env) };
    }
    if (ts.isCallExpression(node))
      return ctx.fail(node, "A primitive must be explicitly awaited");
    return { kind: "pure", value: ctx.pure(node, env) };
  };
  const sequence = (
    statements: readonly ts.Statement[],
    outer: Map<ts.Symbol, Value>,
  ): StatementIR[] => {
    const env = new Map(outer),
      out: StatementIR[] = [];
    const block = (s: ts.Statement) =>
      sequence(ts.isBlock(s) ? s.statements : [s], env);
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        if (!(st.declarationList.flags & ts.NodeFlags.Const))
          return ctx.fail(st, "Only const bindings are currently lowered");
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer)
            return ctx.fail(d, "Expected initialized identifier");
          const expr = expression(d.initializer, env),
            name = `local${serial++}`;
          const type = expr.kind === "pure" ? expr.value.type : expr.type;
          out.push({ kind: "let", name, expression: expr });
          env.set(ctx.symbol(d.name), {
            type,
            lean: type === "bool" ? `(${name} = true)` : name,
          });
        }
      } else if (ts.isExpressionStatement(st))
        out.push({
          kind: "evaluate",
          expression: expression(st.expression, env),
        });
      else if (ts.isReturnStatement(st))
        out.push({
          kind: "return",
          expression: st.expression
            ? expression(st.expression, env)
            : undefined,
        });
      else if (ts.isThrowStatement(st))
        out.push({
          kind: "throw",
          exception: ctx.exception(st.expression, env),
        });
      else if (ts.isIfStatement(st))
        out.push({
          kind: "if",
          condition: ctx.truth(ctx.pure(st.expression, env)),
          yes: block(st.thenStatement),
          no: st.elseStatement ? block(st.elseStatement) : [],
        });
      else if (ts.isBlock(st)) out.push({ kind: "block", body: block(st) });
      else if (ts.isTryStatement(st)) {
        const node: StatementIR = {
          kind: "try",
          body: sequence(st.tryBlock.statements, env),
        };
        if (st.catchClause) {
          const name = `exception${serial++}`,
            catchEnv = new Map(env),
            binding = st.catchClause.variableDeclaration;
          if (binding) {
            if (!ts.isIdentifier(binding.name))
              return ctx.fail(
                binding,
                "Catch destructuring is not yet supported",
              );
            catchEnv.set(ctx.symbol(binding.name), {
              type: "exception",
              lean: name,
            });
          }
          node.handler = {
            name,
            body: sequence(st.catchClause.block.statements, catchEnv),
          };
        }
        if (st.finallyBlock)
          node.finalizer = sequence(st.finallyBlock.statements, env);
        out.push(node);
      } else if (ts.isEmptyStatement(st)) continue;
      else
        return ctx.fail(
          st,
          `Structured lowering does not support ${ts.SyntaxKind[st.kind]}`,
        );
    }
    return out;
  };
  return ts.isBlock(body)
    ? sequence(body.statements, initial)
    : [{ kind: "return", expression: expression(body, initial) }];
}

const primitiveNames: Record<string, string> = {
  "request.get": "requestGet",
  "ledger.get": "ledgerGet",
  "balance.get": "balanceGet",
  "balance.set": "balanceSet",
  "request.insert": "requestInsert",
  "ledger.insert": "ledgerInsert",
};
const expressionType = (e: ExpressionIR) =>
  e.kind === "pure" ? e.value.type : e.type;
export function emitExpression(e: ExpressionIR): string {
  if (e.kind === "await")
    return `(${primitiveNames[e.operation]} ${e.arguments.map((a) => `(${a.lean})`).join(" ")})`;
  const v = e.value;
  const expr =
    v.type === "bool"
      ? `decide (${v.lean})`
      : v.type === "option"
        ? `(${v.lean} : Option Request)`
        : v.lean;
  return `(Program.pure (${expr}))`;
}
export function emitStatements(statements: StatementIR[]): string {
  if (!statements.length) return "(Program.pure ())";
  const [st, ...rest] = statements;
  const next = () => emitStatements(rest);
  if (st!.kind === "let")
    return `(Program.bind ${emitExpression(st!.expression)} (fun ${st!.name} => ${next()}))`;
  let current: string;
  switch (st!.kind) {
    case "evaluate":
      current = `(Program.bind ${emitExpression(st!.expression)} (fun _ => Program.pure ()))`;
      break;
    case "return": {
      if (!st!.expression) current = "(Program.returnValue none)";
      else {
        const type = expressionType(st!.expression);
        if (type !== "request" && type !== "void")
          throw new Error(`Unsupported structured return type: ${type}`);
        current = `(Program.bind ${emitExpression(st!.expression)} (fun result => Program.returnValue ${type === "request" ? "(some result)" : "none"}))`;
      }
      break;
    }
    case "throw":
      current = `(Program.throwValue (${st!.exception}))`;
      break;
    case "if":
      current = `(Program.branch (${st!.condition}) ${emitStatements(st!.yes)} ${emitStatements(st!.no)})`;
      break;
    case "block":
      current = emitStatements(st!.body);
      break;
    case "try": {
      current = emitStatements(st!.body);
      if (st!.handler)
        current = `(Program.tryCatch ${current} (fun ${st!.handler.name} => ${emitStatements(st!.handler.body)}))`;
      if (st!.finalizer)
        current = `(Program.tryFinally ${current} ${emitStatements(st!.finalizer)})`;
      break;
    }
  }
  return rest.length
    ? `(Program.bind ${current} (fun _ => ${next()}))`
    : current;
}
