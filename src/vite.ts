import { captureSourceSnapshot, withSourceFile } from "./native.js";
import path from "node:path";
import { readFile, realpath, rm } from "node:fs/promises";
import * as ts from "typescript/ast";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { LeanWorkspace, packageRoot } from "./lean.js";
import { createProject, leanSources } from "./project.js";
import { contractTypes, contractExportName } from "./verify.js";
import type { VerificationOptions } from "./types.js";
import type { SourceSnapshot } from "./source-snapshot.js";
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
  const snapshots = new Map<string, SourceSnapshot>();
  const captureLean = async (): Promise<Record<string, string>> => {
    const project = createProject(root, verificationOptions);
    const files = await leanSources([root, ...project.leanPaths, path.join(packageRoot, "lean")]);
    return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")])));
  };
  return {
    name: "ts2lean",
    enforce: "pre",
    configureVitest({ defineCacheKeyGenerator }) {
      // Snapshots also depend on type-only inputs and module resolution decisions.
      defineCacheKeyGenerator(() => false);
    },
    resolveId(id) {
      if (id.startsWith("ts2lean:snapshot:")) return "\0" + id;
    },
    configResolved(config) {
      root = path.resolve(config.root, options.root ?? ".");
    },
    async load(id) {
      if (id.startsWith("\0ts2lean:snapshot:")) {
        const snapshot = snapshots.get(id.slice(1));
        if (!snapshot) throw new Error("Missing source snapshot");
        return `import { defineSourceSnapshot } from "@fyuuki0jp/ts2lean/runtime"; export default defineSourceSnapshot(${JSON.stringify(snapshot)});`;
      }
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
      const sources = await captureLean();
      const ws = await LeanWorkspace.create(project, undefined, sources);
      try {
        const infos = await ws.discover(file);
        contractTypes(infos); // Reject ambiguous or invalid JS export names before emitting code.
        return [
          'import { contractReference as __ts2leanContract } from "@fyuuki0jp/ts2lean/runtime";',
          `const __ts2leanSources = ${JSON.stringify(sources)};`,
          ...infos.map(
            (info) =>
              `export const ${contractExportName(info)} = __ts2leanContract(${JSON.stringify(file)}, ${JSON.stringify(info.name)}, ${JSON.stringify(root)}, ${JSON.stringify(verificationOptions)}, ${JSON.stringify(info.kind ?? "pure")}, __ts2leanSources);`,
          ),
        ].join("\n");
      } finally {
        await rm(ws.dir, { recursive: true, force: true });
      }
    },
    async transform(code, id) {
      const sourceId = id.split("?")[0]!;
      if (
        !/\.[cm]?ts$/.test(sourceId) ||
        id.endsWith(".d.ts") ||
        id.includes("/node_modules/")
      )
        return;
      const file = await realpath(sourceId);
      if (file.startsWith(path.join(packageRoot, "src") + path.sep)) return;
      const snapshot = captureSourceSnapshot(file, code, await captureLean());
      const snapshotId = `ts2lean:snapshot:${snapshot.id}`;
      snapshots.set(snapshotId, snapshot);
      for (const dependency of Object.keys(snapshot.files)) this.addWatchFile(dependency);
      return withSourceFile(file, code, (sf) => {
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
          n.forEachChild(collect);
        };
        collect(sf);
        const namespaces = new Set<string>();
        for (const st of sf.statements)
          if (
            ts.isImportDeclaration(st) &&
            st.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
          ) {
            const bindings = st.importClause?.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings))
              namespaces.add(bindings.name.text);
          }
        let registerName = "__ts2leanRegister";
        while (code.includes(registerName)) registerName += "_";
        const output = new MagicString(code);
        output.prepend(`import ${registerName}Snapshot from ${JSON.stringify(snapshotId)};\n`);
        output.append(
          `\nimport { registerFunction as ${registerName}, registerObject as ${registerName}Object, registerClosure as ${registerName}Closure, registerMethods as ${registerName}Methods, dependencyReference as ${registerName}Reference } from "@fyuuki0jp/ts2lean/runtime";\n`,
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
                (e) =>
                  ts.isBindingElement(e) && !!e.name && boundName(e.name, text),
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
          receiver = false,
        ): Map<string, string> => {
          const out = new Map<string, string>();
          const visit = (n: ts.Node): void => {
            if (isFunctionNode(n)) return;
            if (
              ts.isCallExpression(n) ||
              (data && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)))
            ) {
              if (receiver && (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression))) {
                n.forEachChild(visit);
                return;
              }
              const expr = ts.isCallExpression(n)
                ? receiver ? (n.expression as ts.PropertyAccessExpression).expression : n.expression
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
                        : ts.isFunctionDeclaration(st) &&
                          st.name?.text === root,
                    )
                  )
                    local = true;
                  if (scope === owner) break;
                }
              if (root && r && !local) out.set(expr.getText(), r);
            }
            n.forEachChild(visit);
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
          const name = functionIdentity(fn);
          return `{...${JSON.stringify({ module: file, name })},snapshot:${registerName}Snapshot,callees:()=>({${record(refs(fn.body!, fn))}}),captures:()=>({${record(refs(fn.body!, fn, true))}}),receivers:()=>({${record(refs(fn.body!, fn, false, true))}})}`;
        };
        for (const fn of functions) {
          if (
            ts.isFunctionDeclaration(fn) &&
            fn.name &&
            (ts.isSourceFile(fn.parent) || ts.isBlock(fn.parent))
          )
            if (ts.isSourceFile(fn.parent))
              // Declarations are hoisted; register before user statements can replace them.
              output.appendLeft(0, `${registerName}(${fn.name.text},${metadata(fn)});\n`);
            else
              output.appendLeft(fn.parent.getStart() + 1, `${registerName}(${fn.name.text},${metadata(fn)});\n`);
          else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
            output.appendLeft(fn.getStart(), `${registerName}Closure((`);
            // Concise nested arrows can end at the same offset. Close the inner
            // wrapper first so each function keeps its own source identity.
            output.prependRight(fn.end, `),${metadata(fn)})`);
          }
        }
        for (const object of methodObjects) {
          // A spread/computed member can replace a method after its declaration.
          // In that case only independently registered function values are evidence.
          const names = object.properties.map((p) =>
            !ts.isSpreadAssignment(p) && p.name && ts.isIdentifier(p.name) &&
            !ts.isGetAccessorDeclaration(p) && !ts.isSetAccessorDeclaration(p)
              ? p.name.text : undefined);
          if (names.includes(undefined) || new Set(names).size !== names.length) continue;
          const sources = object.properties
            .filter(ts.isMethodDeclaration)
            .filter((m) => ts.isIdentifier(m.name))
            .map((m) => `${JSON.stringify(m.name.getText())}:${metadata(m)}`)
            .join(",");
          output.appendLeft(object.getStart(), `${registerName}Methods((`);
          output.appendRight(object.end, `),{${sources}})`);
        }
        for (const { d } of variables) {
          const name = d.name.getText();
          // Bind module laws before later initialization code can replace methods.
          output.prependLeft(d.initializer!.getStart(), `${registerName}Object((`);
          output.appendRight(d.initializer!.end,
            `),{...${JSON.stringify({ module: file, name })},snapshot:${registerName}Snapshot})`,
          );
        }
        return {
          code: output.toString(),
          map: output.generateMap({
            hires: true,
            source: id,
            includeContent: true,
          }),
        };
      });
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
