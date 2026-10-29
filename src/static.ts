import { ts } from "@ts-morph/common";

export type FunctionNode =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.MethodDeclaration;
export const isFunctionNode = (n: ts.Node): n is FunctionNode =>
  ts.isFunctionDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isMethodDeclaration(n);
/** Stable identity in the original (untransformed) source, shared with instrumentation. */
export function functionIdentity(n: FunctionNode): string {
  if (ts.isFunctionDeclaration(n) && ts.isSourceFile(n.parent) && n.name)
    return n.name.text;
  if (
    ts.isVariableDeclaration(n.parent) &&
    ts.isIdentifier(n.parent.name) &&
    ts.isVariableDeclarationList(n.parent.parent) &&
    ts.isVariableStatement(n.parent.parent.parent) &&
    ts.isSourceFile(n.parent.parent.parent.parent)
  )
    return n.parent.name.text;
  return `@${n.getStart()}`;
}
export interface StaticFunction {
  kind: "function";
  node: FunctionNode;
  env: StaticEnv;
}
export interface StaticObject {
  kind: "object";
  fields: Map<string, StaticValue>;
}
export type StaticValue = StaticFunction | StaticObject;
export type StaticEnv = Map<ts.Symbol, StaticValue>;
export interface CompositionCheck {
  source: string;
  reference: string;
  targetSource: string;
  targetName: string;
}

/** An AST interpreter for wiring only. It never runs user JavaScript. */
export function staticResolver(
  checker: ts.TypeChecker,
  fail: (n: ts.Node, message: string) => never,
) {
  const cache = new Map<ts.Symbol, StaticValue>();
  const active = new Set<ts.Symbol>();
  const activeFactories = new Set<FunctionNode>();
  const checks: CompositionCheck[] = [];
  const symbol = (n: ts.Node): ts.Symbol => {
    let s = checker.getSymbolAtLocation(n);
    if (!s) return fail(n, "Unresolved static dependency");
    if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const member = (
    value: StaticValue,
    key: string,
    at: ts.Node,
  ): StaticValue => {
    if (value.kind !== "object" || !value.fields.has(key))
      return fail(at, `Unknown static port: ${key}`);
    return value.fields.get(key)!;
  };
  const bind = (
    name: ts.BindingName,
    value: StaticValue,
    env: StaticEnv,
  ): void => {
    if (ts.isIdentifier(name)) {
      env.set(symbol(name), value);
      return;
    }
    if (!ts.isObjectBindingPattern(name))
      return fail(
        name,
        "Only object destructuring is supported for dependencies",
      );
    for (const e of name.elements) {
      if (
        e.dotDotDotToken ||
        e.initializer ||
        (e.propertyName && !ts.isIdentifier(e.propertyName))
      )
        return fail(
          e,
          "Dependency destructuring requires static keys without rest or defaults",
        );
      const key =
        e.propertyName?.getText() ??
        (ts.isIdentifier(e.name) ? e.name.text : undefined);
      if (!key)
        return fail(e, "Nested dependency destructuring needs a property name");
      bind(e.name, member(value, key, e), env);
    }
  };
  const validateFunction = (fn: FunctionNode): void => {
    if (
      !fn.body ||
      fn.asteriskToken ||
      fn.typeParameters?.length ||
      fn.modifiers?.some(
        (m) =>
          m.kind === ts.SyntaxKind.AsyncKeyword ||
          m.kind === ts.SyntaxKind.DeclareKeyword,
      )
    )
      return fail(
        fn,
        "Async, generators, ambient, and generic functions are unsupported in the pure profile",
      );
    for (const p of fn.parameters)
      if (p.initializer || p.questionToken || p.dotDotDotToken)
        return fail(p, "Use required parameters without defaults or rest");
  };
  const resolveSymbol = (
    s: ts.Symbol,
    at: ts.Node,
    env: StaticEnv,
  ): StaticValue => {
    if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    if (env.has(s)) return env.get(s)!;
    if (cache.has(s)) return cache.get(s)!;
    if (active.has(s)) return fail(at, "Cyclic static composition");
    const d = s.valueDeclaration;
    if (!d) return fail(at, "Dependency has no local implementation");
    if (d.getSourceFile().isDeclarationFile)
      return fail(at, "External dependencies are unsupported");
    // Local bindings must come from this particular factory invocation.
    let owner: ts.Node | undefined = d.parent;
    while (owner && !ts.isSourceFile(owner)) {
      if (isFunctionNode(owner))
        return fail(
          at,
          "Runtime local values cannot be used as static dependencies",
        );
      owner = owner.parent;
    }
    active.add(s);
    let value: StaticValue;
    if (ts.isFunctionDeclaration(d)) {
      validateFunction(d);
      value = { kind: "function", node: d, env: new Map() };
    } else if (
      ts.isVariableDeclaration(d) &&
      d.initializer &&
      ts.isVariableDeclarationList(d.parent) &&
      d.parent.flags & ts.NodeFlags.Const
    )
      value = resolve(d.initializer, new Map());
    else return fail(at, "Dependencies must be immutable static bindings");
    active.delete(s);
    cache.set(s, value);
    return value;
  };
  const resolve = (
    n: ts.Expression,
    env: StaticEnv = new Map(),
  ): StaticValue => {
    if (ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n))
      return resolve(n.expression, env);
    if (ts.isIdentifier(n)) return resolveSymbol(symbol(n), n, env);
    if (ts.isPropertyAccessExpression(n)) {
      // Namespace imports and reexports are resolved by the TypeScript symbol graph.
      if (
        ts.isIdentifier(n.expression) &&
        checker
          .getSymbolAtLocation(n.expression)
          ?.declarations?.some(ts.isNamespaceImport)
      )
        return resolveSymbol(symbol(n.name), n, env);
      return member(resolve(n.expression, env), n.name.text, n);
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      validateFunction(n);
      return { kind: "function", node: n, env: new Map(env) };
    }
    if (ts.isObjectLiteralExpression(n)) {
      const fields = new Map<string, StaticValue>();
      for (const p of n.properties) {
        if (
          !p.name ||
          !ts.isIdentifier(p.name) ||
          p.name.text === "__proto__" ||
          fields.has(p.name.text)
        )
          return fail(
            p,
            "Dependency objects need unique simple property names",
          );
        let value: StaticValue;
        if (ts.isPropertyAssignment(p)) value = resolve(p.initializer, env);
        else if (
          ts.isShorthandPropertyAssignment(p) &&
          !p.objectAssignmentInitializer
        ) {
          const s = checker.getShorthandAssignmentValueSymbol(p);
          if (!s) return fail(p, "Unresolved shorthand dependency");
          value = resolveSymbol(s, p, env);
        } else if (ts.isMethodDeclaration(p)) {
          validateFunction(p);
          value = { kind: "function", node: p, env: new Map(env) };
        } else
          return fail(
            p,
            "Dependency getters, setters, and spreads are unsupported",
          );
        fields.set(p.name.text, value);
      }
      return { kind: "object", fields };
    }
    if (ts.isCallExpression(n)) {
      const callee = resolve(n.expression, env);
      if (callee.kind !== "function")
        return fail(n, "A factory must resolve to a local function");
      const fn = callee.node;
      validateFunction(fn);
      if (activeFactories.has(fn))
        return fail(n, "Recursive factory composition is unsupported");
      if (
        n.arguments.length !== fn.parameters.length ||
        n.typeArguments?.length ||
        n.arguments.some(ts.isSpreadElement)
      )
        return fail(n, "Factory argument count must match required parameters");
      // Factories may only be invoked in module-level wiring, where their actual
      // runtime references can be inspected independently of the returned closure.
      let owner: ts.Node | undefined = n.parent;
      while (owner && !ts.isSourceFile(owner)) {
        if (isFunctionNode(owner))
          return fail(n, "Compose factories at module scope");
        owner = owner.parent;
      }
      checks.push({
        source: n.getSourceFile().fileName,
        reference: n.expression.getText(),
        targetSource: fn.getSourceFile().fileName,
        targetName: functionIdentity(fn),
      });
      const captured = new Map(callee.env);
      fn.parameters.forEach((p, i) =>
        bind(p.name, resolve(n.arguments[i]!, env), captured),
      );
      activeFactories.add(fn);
      let result: StaticValue | undefined;
      if (!ts.isBlock(fn.body!))
        result = resolve(fn.body as ts.Expression, captured);
      else
        for (const st of fn.body!.statements) {
          if (result)
            return fail(st, "Unreachable factory statements are unsupported");
          if (
            ts.isVariableStatement(st) &&
            st.declarationList.flags & ts.NodeFlags.Const
          ) {
            for (const d of st.declarationList.declarations) {
              if (!d.initializer) return fail(d, "Initialize factory bindings");
              bind(d.name, resolve(d.initializer, captured), captured);
            }
          } else if (ts.isReturnStatement(st) && st.expression)
            result = resolve(st.expression, captured);
          else
            return fail(
              st,
              "Factories may only bind immutable dependencies and return a function or service object",
            );
        }
      activeFactories.delete(fn);
      if (!result)
        return fail(fn, "Factory must return a function or service object");
      return result;
    }
    return fail(
      n,
      `Not a static dependency: ${ts.SyntaxKind[n.kind]}. Runtime selection, scalar captures, and containers are unsupported`,
    );
  };
  return { resolve, resolveSymbol, symbol, member, checks, validateFunction };
}
