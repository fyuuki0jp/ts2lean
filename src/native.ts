import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ScriptTarget, isStringLiteralLikeNode, type SourceFile } from "typescript/ast";
import {
  API,
  ModuleKind,
  ModuleResolutionKind,
  formatDiagnosticsWithColorAndContext,
  type Checker,
  type Program,
  type RawCompilerOptions,
} from "typescript/sync";
import { createFileSystemLayer, createFileSystemWithLib } from "typescript/fs";
import { Failure } from "./types.js";
import type { SourceSnapshot } from "./source-snapshot.js";

export const compilerOptions: RawCompilerOptions = {
  target: ScriptTarget.ES2022,
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
};

export interface TypeScriptProject { root: string; tsconfig?: string }

/** Resolve extends and paths through the compiler; never execute content mappers. */
export function projectCompilerOptions(project?: TypeScriptProject): RawCompilerOptions {
  if (!project) return { ...compilerOptions, exactOptionalPropertyTypes: true };
  const file = path.resolve(project.root, project.tsconfig ?? "tsconfig.json");
  if (!project.tsconfig && !existsSync(file))
    return {...projectCompilerOptions(), configFilePath: file};
  if (!existsSync(file)) throw new Failure("type-error", `Cannot read TypeScript config: ${file}`);
  return withAPI(api => {
    const parsed = api.parseConfigFile(file);
    // We supply individual roots and our own checked Lean declarations. Neither
    // empty include sets nor disabled external content mappers block this program.
    const errors = parsed.errors.filter(error => ![18003, 18068].includes(error.code));
    if (errors.length) throw new Failure("type-error", formatDiagnosticsWithColorAndContext(errors, api));
    const options: RawCompilerOptions = { ...compilerOptions, ...parsed.options };
    // Build layout and incremental caches do not apply to an in-memory proof program.
    for (const key of ["rootDir", "outDir", "outFile", "declarationDir", "tsBuildInfoFile"] as const)
      delete (options as Record<string, unknown>)[key];
    return { ...options, noEmit: true, noCheck: false, strict: true, strictNullChecks: true,
      exactOptionalPropertyTypes: true, composite: false, incremental: false,
      declaration: false, declarationMap: false, emitDeclarationOnly: false };
  });
}

/** Keep remote ASTs, symbols, and types within the callback's lifetime. */
export function withAPI<T>(run: (api: API) => T): T {
  const api = new API();
  try {
    return run(api);
  } finally {
    api.close();
  }
}

export function withSourceFile<T>(
  file: string,
  code: string,
  run: (sourceFile: SourceFile) => T,
): T {
  return withAPI((api) => {
    const lease = api.createSourceFile(file, code);
    try {
      return run(lease.sourceFile);
    } finally {
      lease.dispose();
    }
  });
}

export function withProgram<T>(
  roots: string[],
  virtualFiles: Map<string, string>,
  options: RawCompilerOptions,
  run: (program: Program, checker: Checker) => T,
): T {
  return withAPI((api) => {
    const defaultResolver = api.createModuleResolver(options);
    try {
      const resolver = api.createModuleResolver(options, {
        resolveModuleName(name, directory, mode, context) {
          if (name.endsWith(".lean")) {
            const file = path.resolve(directory, name) + ".ts";
            if (virtualFiles.has(file)) return { resolvedFileName: file };
            return undefined;
          }
          // An undefined callback result means unresolved, not default lookup.
          return defaultResolver.resolveModuleName(
            name,
            directory,
            mode,
            context,
          ).resolvedModule;
        },
      });
      try {
        const snapshot = api.createSnapshot({
          fileSystem: createFileSystemLayer([...virtualFiles]),
          createPrograms: [
            {
              rootFiles: roots,
              compilerOptions: options,
              options: { moduleResolver: resolver },
            },
          ],
        });
        try {
          const program = snapshot.operation.createdPrograms[0];
          const diagnostics = [
            ...program.getConfigFileParsingDiagnostics(),
            ...program.getProgramDiagnostics(),
            ...program.getSyntacticDiagnostics(),
            ...program.getGlobalDiagnostics(),
            ...program.getSemanticDiagnostics(),
          ];
          if (diagnostics.length)
            throw new Failure(
              "type-error",
              formatDiagnosticsWithColorAndContext(diagnostics, program),
            );
          return run(program, program.getProject().checker);
        } finally {
          snapshot.dispose();
        }
      } finally {
        resolver.dispose();
      }
    } finally {
      defaultResolver.dispose();
    }
  });
}

/** Capture syntax, type dependencies, and resolution decisions without running user code. */
export function captureSourceSnapshot(
  file: string,
  code: string,
  lean: Readonly<Record<string, string>>,
  project?: TypeScriptProject,
): SourceSnapshot {
  const options = { types: ["node"], ...projectCompilerOptions(project) };
  return withAPI((api) => {
    const snapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([[file, code]]),
      createPrograms: [{ rootFiles: [file], compilerOptions: options }],
    });
    try {
      const program = snapshot.operation.createdPrograms[0];
      const files: Record<string, string> = {};
      const roots: string[] = [];
      const resolutions: SourceSnapshot["resolutions"][number][] = [];
      const specs = new Set<string>();
      const directories = new Set<string>();
      for (const name of program.getSourceFileNames()) {
        const sf = program.getSourceFile(name)!;
        if (program.isSourceFileDefaultLibrary(sf)) continue;
        files[name] = sf.text;
        roots.push(name);
        // Module augmentations resolve just like imports (e.g. Vitest matchers).
        for (const imported of [...sf.imports, ...sf.moduleAugmentations]) {
          if (!isStringLiteralLikeNode(imported)) continue;
          const directory = path.dirname(name);
          const resolution = program.getResolvedModuleFromModuleSpecifier(imported);
          resolutions.push({ directory, name: imported.text,
            mode: program.getModeForUsageLocation(sf.fileName, imported),
            file: resolution?.resolvedFileName });
          if (imported.text.endsWith(".lean") && imported.text.startsWith("."))
            specs.add(path.resolve(directory, imported.text));
        }
        // Package boundaries affect module format and type-reference resolution.
        for (let dir = path.dirname(name); !directories.has(dir); dir = path.dirname(dir)) {
          directories.add(dir);
          const manifest = path.join(dir, "package.json");
          try { files[manifest] = readFileSync(manifest, "utf8"); }
          catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
          if (path.dirname(dir) === dir) break;
        }
      }
      const configFile = project && path.resolve(project.root, project.tsconfig ?? "tsconfig.json");
      const data = { root: file, files, roots, resolutions, specs: [...specs], lean,
        compilerOptions: options, tsconfig: configFile && existsSync(configFile) ? configFile : undefined };
      return { id: createHash("sha256").update(JSON.stringify(data)).digest("hex"), ...data };
    } finally { snapshot.dispose(); }
  });
}

export interface NativeContext {
  readonly program: Program;
  readonly checker: Checker;
  dispose(): void;
}

/** A closed filesystem: an old loaded function never consults current TS files. */
export function openSnapshotProgram(
  api: API,
  source: SourceSnapshot,
  declarations: Map<string, string>,
): NativeContext {
  const files = new Map(Object.entries(source.files));
  for (const entry of declarations) files.set(...entry);
  // Ambient entry points were already captured as roots. Looking up their package
  // names again would depend on symlinks (e.g. pnpm) outside this closed filesystem.
  const options = { ...(source.compilerOptions ?? { ...compilerOptions, exactOptionalPropertyTypes: true }), types: [] };
  const resolutions = new Map(source.resolutions.map((r) =>
    [JSON.stringify([r.directory, r.name, r.mode]), r.file]));
  const resolver = api.createModuleResolver(options, {
    resolveModuleName(name, directory, mode) {
      if (name.endsWith(".lean")) {
        const file = path.resolve(directory, name) + ".ts";
        return declarations.has(file) ? { resolvedFileName: file } : undefined;
      }
      const file = resolutions.get(JSON.stringify([directory, name, mode ?? ModuleKind.ESNext]));
      return file ? { resolvedFileName: file } : undefined;
    },
  });
  try {
    const snapshot = api.createSnapshot({
      fileSystem: createFileSystemWithLib([...files]),
      createPrograms: [{ rootFiles: [...source.roots], compilerOptions: options, options: { moduleResolver: resolver } }],
    });
    try {
      const program = snapshot.operation.createdPrograms[0];
      const diagnostics = [
        ...program.getProgramDiagnostics(), ...program.getSyntacticDiagnostics(),
        ...program.getGlobalDiagnostics(), ...program.getSemanticDiagnostics(),
      ];
      if (diagnostics.length) throw new Failure("type-error", formatDiagnosticsWithColorAndContext(diagnostics, program));
      return { program, checker: program.getProject().checker,
        dispose() { try { snapshot.dispose(); } finally { resolver.dispose(); } } };
    } catch (error) { snapshot.dispose(); throw error; }
  } catch (error) { resolver.dispose(); throw error; }
}
