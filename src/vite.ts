import path from "node:path";
import { createHash } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { ts } from "@ts-morph/common";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { LeanWorkspace, packageRoot } from "./lean.js";
import { createProject, leanSources } from "./project.js";
import { contractTypes, contractExportName } from "./verify.js";
import type { VerificationOptions } from "./types.js";
import {
  isFunctionNode,
  functionIdentity,
  type FunctionNode,
} from "./static.js";

export interface Ts2LeanPluginOptions extends VerificationOptions {
  /** Lean module root. Defaults to Vite's root. */
  root?: string;
}

// Keep Vitest's optional peer out of the public Vite plugin type dependencies.
interface VerificationPlugin extends Plugin {
  configureVitest(context: {
    defineCacheKeyGenerator(
      generator: (context: { id: string }) => string | false,
    ): void;
  }): void;
}

/** Instrument source imports and load Lean contracts for Node-based Vitest tests. */
export function ts2lean(
  options: Ts2LeanPluginOptions = {},
): VerificationPlugin {
  let root = path.resolve(options.root ?? ".");
  const { root: _root, ...verificationOptions } = options;
  const leanIds = new Set<string>();
  const instrumentationHash = createHash("sha256")
    .update(ts2lean.toString())
    .update(functionIdentity.toString())
    .update(isFunctionNode.toString())
    .digest("hex");
  return {
    name: "ts2lean",
    enforce: "pre",
    configureVitest({ defineCacheKeyGenerator }) {
      defineCacheKeyGenerator(({ id }) =>
        // Discovery also depends on imported Lean files and must run afresh.
        id.endsWith(".lean")
          ? false
          : JSON.stringify([instrumentationHash, root, verificationOptions]),
      );
    },
    configResolved(config) {
      root = path.resolve(config.root, options.root ?? ".");
    },
    async load(id) {
      if (!id.endsWith(".lean")) return;
      const file = await realpath(id);
      leanIds.add(id);
      const project = createProject(root, verificationOptions);
      for (const dependency of await leanSources([
        root,
        ...project.leanPaths,
        path.join(packageRoot, "lean"),
      ]))
        this.addWatchFile(dependency);
      const ws = await LeanWorkspace.create(project);
      try {
        const infos = await ws.discover(file);
        contractTypes(infos); // Reject ambiguous or invalid JS export names before emitting code.
        return [
          'import { contractReference as __ts2leanContract } from "ts2lean/runtime";',
          ...infos.map(
            (info) =>
              `export const ${contractExportName(info)} = __ts2leanContract(${JSON.stringify(file)}, ${JSON.stringify(info.name)}, ${JSON.stringify(root)}, ${JSON.stringify(verificationOptions)}, ${JSON.stringify(info.kind ?? "pure")});`,
          ),
        ].join("\n");
      } finally {
        await rm(ws.dir, { recursive: true, force: true });
      }
    },
    async transform(code, id) {
      if (
        !/\.[cm]?ts$/.test(id) ||
        id.endsWith(".d.ts") ||
        id.includes("/node_modules/") ||
        /\.(test|spec)\.[cm]?ts$/.test(id)
      )
        return;
      const file = await realpath(id);
      if (file.startsWith(path.join(packageRoot, "src") + path.sep)) return;
      const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
      const variables = sf.statements
        .filter(ts.isVariableStatement)
        .flatMap((st) =>
          st.declarationList.declarations
            .filter((d) => ts.isIdentifier(d.name) && d.initializer)
            .map((d) => ({ d, st })),
        );
      const functions: FunctionNode[] = [],
        methodObjects: ts.ObjectLiteralExpression[] = [];
      const collect = (n: ts.Node): void => {
        if (isFunctionNode(n) && n.body) functions.push(n);
        if (
          ts.isObjectLiteralExpression(n) &&
          n.properties.some(ts.isMethodDeclaration)
        )
          methodObjects.push(n);
        ts.forEachChild(n, collect);
      };
      collect(sf);
      const visibleObjects = new Set(
        variables.map(({ d }) => d.name.getText()),
      );
      const namespaces = new Set<string>();
      for (const st of sf.statements)
        if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly) {
          const bindings = st.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const e of bindings.elements)
              if (!e.isTypeOnly) visibleObjects.add(e.name.text);
          if (bindings && ts.isNamespaceImport(bindings))
            namespaces.add(bindings.name.text);
        }
      const hash = createHash("sha256").update(code).digest("hex");
      let registerName = "__ts2leanRegister";
      while (code.includes(registerName)) registerName += "_";
      const output = new MagicString(code);
      output.append(
        `\nimport { registerFunction as ${registerName}, registerObject as ${registerName}Object, registerClosure as ${registerName}Closure, registerMethods as ${registerName}Methods, registerExport as ${registerName}Export, registerModule as ${registerName}Module, dependencyReference as ${registerName}Reference } from "ts2lean/runtime";\n`,
      );
      const rootName = (n: ts.Expression): string | undefined =>
        ts.isIdentifier(n)
          ? n.text
          : ts.isPropertyAccessExpression(n)
            ? rootName(n.expression)
            : undefined;
      const boundName = (name: ts.BindingName, text: string): boolean =>
        ts.isIdentifier(name)
          ? name.text === text
          : name.elements.some(
              (e) => ts.isBindingElement(e) && boundName(e.name, text),
            );
      const namespaceReference = (base: ts.Identifier): boolean => {
        if (!namespaces.has(base.text)) return false;
        for (
          let owner: ts.Node | undefined = base.parent;
          owner && !ts.isSourceFile(owner);
          owner = owner.parent
        ) {
          if (
            isFunctionNode(owner) &&
            (owner.parameters.some((p) => boundName(p.name, base.text)) ||
              (ts.isFunctionExpression(owner) &&
                owner.name?.text === base.text))
          )
            return false;
          if (
            ts.isCatchClause(owner) &&
            owner.variableDeclaration &&
            boundName(owner.variableDeclaration.name, base.text)
          )
            return false;
          if (
            ts.isBlock(owner) &&
            owner.statements.some((st) =>
              ts.isVariableStatement(st)
                ? st.declarationList.declarations.some((d) =>
                    boundName(d.name, base.text),
                  )
                : ts.isFunctionDeclaration(st) && st.name?.text === base.text,
            )
          )
            return false;
        }
        return true;
      };
      const reference = (n: ts.Expression): string | undefined => {
        if (ts.isIdentifier(n)) return n.text;
        if (!ts.isPropertyAccessExpression(n)) return;
        const keys: string[] = [];
        let base: ts.Expression = n;
        while (ts.isPropertyAccessExpression(base)) {
          keys.unshift(base.name.text);
          base = base.expression;
        }
        if (!ts.isIdentifier(base)) return;
        if (namespaceReference(base)) {
          const first = keys.shift()!;
          const imported = `${base.text}.${first}`;
          return keys.length
            ? `${registerName}Reference(${imported},${JSON.stringify(keys)})`
            : imported;
        }
        return `${registerName}Reference(${base.text},${JSON.stringify(keys)})`;
      };
      const refs = (
        body: ts.Node,
        owner?: FunctionNode,
        data = false,
      ): Map<string, string> => {
        const out = new Map<string, string>();
        const visit = (n: ts.Node): void => {
          if (isFunctionNode(n)) return;
          if (
            ts.isCallExpression(n) ||
            (data && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)))
          ) {
            const expr = ts.isCallExpression(n)
              ? n.expression
              : (n as ts.Expression);
            const root = rootName(expr),
              r = reference(expr);
            let local = false;
            if (owner && root)
              for (
                let scope: ts.Node | undefined = n.parent;
                scope && !ts.isSourceFile(scope);
                scope = scope.parent
              ) {
                if (
                  isFunctionNode(scope) &&
                  scope.parameters.some((p) => boundName(p.name, root))
                )
                  local = true;
                if (
                  ts.isCatchClause(scope) &&
                  scope.variableDeclaration &&
                  boundName(scope.variableDeclaration.name, root)
                )
                  local = true;
                if (
                  ts.isBlock(scope) &&
                  scope.statements.some((st) =>
                    ts.isVariableStatement(st)
                      ? st.declarationList.declarations.some((d) =>
                          boundName(d.name, root),
                        )
                      : ts.isFunctionDeclaration(st) && st.name?.text === root,
                  )
                )
                  local = true;
                if (scope === owner) break;
              }
            if (root && r && !local) out.set(expr.getText(), r);
          }
          ts.forEachChild(n, visit);
        };
        visit(body);
        return out;
      };
      const record = (references: Map<string, string>) =>
        [...references]
          .map(
            ([key, value]) =>
              `get [${JSON.stringify(key)}](){return ${value};}`,
          )
          .join(",");
      const metadata = (fn: FunctionNode): string => {
        const excluded = new Set<string>();
        const bindNames = (n: ts.BindingName): void => {
          if (ts.isIdentifier(n)) excluded.add(n.text);
          else
            for (const e of n.elements)
              if (ts.isBindingElement(e)) bindNames(e.name);
        };
        fn.parameters.forEach((p) => bindNames(p.name));
        const locals = (n: ts.Node): void => {
          if (isFunctionNode(n)) return;
          if (ts.isVariableDeclaration(n)) bindNames(n.name);
          ts.forEachChild(n, locals);
        };
        locals(fn.body!);
        const objects = new Set<string>();
        const visit = (n: ts.Node): void => {
          if (
            ts.isPropertyAccessExpression(n) &&
            ts.isIdentifier(n.expression) &&
            visibleObjects.has(n.expression.text) &&
            !excluded.has(n.expression.text)
          )
            objects.add(n.expression.text);
          ts.forEachChild(n, visit);
        };
        visit(fn.body!);
        const name = functionIdentity(fn);
        const declaration =
          ts.isFunctionDeclaration(fn) && ts.isSourceFile(fn.parent)
            ? fn
            : ts.isVariableDeclaration(fn.parent) &&
                ts.isVariableDeclarationList(fn.parent.parent) &&
                ts.isVariableStatement(fn.parent.parent.parent) &&
                ts.isSourceFile(fn.parent.parent.parent.parent)
              ? fn.parent.parent.parent
              : undefined;
        const exported = declaration?.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )
          ? declaration.modifiers.some(
              (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
            )
            ? "default"
            : name
          : undefined;
        return `{...${JSON.stringify({ module: file, export: exported, name, hash })},callees:()=>({${record(refs(fn.body!, fn))}}),captures:()=>({${record(refs(fn.body!, fn, true))}}),objects:()=>({${[...objects].map((n) => `[${JSON.stringify(n)}]:${n}`).join(",")}})}`;
      };
      for (const fn of functions) {
        if (
          ts.isFunctionDeclaration(fn) &&
          fn.name &&
          ts.isSourceFile(fn.parent)
        )
          output.append(`${registerName}(${fn.name.text},${metadata(fn)});\n`);
        else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
          output.appendLeft(fn.getStart(), `${registerName}Closure((`);
          output.appendRight(fn.end, `),${metadata(fn)})`);
        }
      }
      for (const object of methodObjects) {
        const sources = object.properties
          .filter(ts.isMethodDeclaration)
          .filter((m) => ts.isIdentifier(m.name))
          .map((m) => `${JSON.stringify(m.name.getText())}:${metadata(m)}`)
          .join(",");
        output.appendLeft(object.getStart(), `${registerName}Methods((`);
        output.appendRight(object.end, `),{${sources}})`);
      }
      for (const { d, st } of variables) {
        const name = d.name.getText();
        output.append(
          `${registerName}Object(${name},${JSON.stringify({ module: file, name, hash })});\n`,
        );
        if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
          output.append(
            `${registerName}Export(${name},${JSON.stringify({ module: file, export: name })});\n`,
          );
      }
      for (const st of sf.statements) {
        if (
          ts.isExportDeclaration(st) &&
          !st.isTypeOnly &&
          !st.moduleSpecifier &&
          st.exportClause &&
          ts.isNamedExports(st.exportClause)
        ) {
          for (const e of st.exportClause.elements)
            if (!e.isTypeOnly) {
              const local = e.propertyName?.text ?? e.name.text;
              output.append(
                `${registerName}Export(${local},${JSON.stringify({ module: file, export: e.name.text })});\n`,
              );
            }
        }
      }
      const compositionRefs = new Map<string, string>();
      for (const { d } of variables)
        for (const [k, v] of refs(d.initializer!)) compositionRefs.set(k, v);
      output.append(
        `${registerName}Module(${JSON.stringify(file)},${JSON.stringify(hash)},()=>({${record(compositionRefs)}}));\n`,
      );
      return {
        code: output.toString(),
        map: output.generateMap({
          hires: true,
          source: id,
          includeContent: true,
        }),
      };
    },
    handleHotUpdate(ctx) {
      if (!ctx.file.endsWith(".lean")) return;
      // An imported Lean dependency may change any contract's exposed type.
      const changed = new Set(ctx.modules);
      for (const id of leanIds) {
        const module = ctx.server.moduleGraph.getModuleById(id);
        if (module) {
          ctx.server.moduleGraph.invalidateModule(module);
          changed.add(module);
        }
      }
      return [...changed];
    },
  };
}
