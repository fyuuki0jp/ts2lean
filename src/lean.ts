import { spawn } from "node:child_process";
import {
  access,
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  readdir,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Failure,
  type ResolvedConfig,
  type ContractInfo,
  type Shape,
} from "./types.js";
export const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
export async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      done = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Failure("timeout", `Timed out after ${timeout}ms: ${command}`),
      );
    }, timeout);
    function finish(error?: Error, code = -1) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, output });
    }
    const collect = (data: Buffer) => {
      output += data.toString();
      if (output.length > 4_000_000) {
        child.kill("SIGKILL");
        finish(new Failure("tool-error", "Tool output limit exceeded."));
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => finish(new Failure("tool-error", e.message)));
    child.on("close", (code) => finish(undefined, code ?? -1));
  });
}
export class LeanWorkspace {
  private compiled = new Set<string>();
  private building = new Set<string>();
  readonly env: NodeJS.ProcessEnv;
  constructor(
    readonly config: ResolvedConfig,
    readonly dir: string,
    readonly command: string,
    elanHome?: string,
  ) {
    this.env = {
      ...process.env,
      LEAN_PATH: dir,
      ...(elanHome ? { ELAN_HOME: elanHome } : {}),
    };
  }
  static async create(
    config: ResolvedConfig,
    override?: { file: string; content: string },
  ): Promise<LeanWorkspace> {
    const base = path.join(config.root, ".ts2lean");
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, "run-"));
    const localElan = path.join(packageRoot, ".tools/elan");
    const local = path.join(localElan, "bin/lean");
    const explicit = config.lean ?? process.env.TS2LEAN_LEAN;
    const command = explicit
      ? explicit.includes(path.sep)
        ? path.resolve(config.root, explicit)
        : explicit
      : (await exists(local))
        ? local
        : "lean";
    const ws = new LeanWorkspace(
      config,
      dir,
      command,
      !explicit && (await exists(local)) ? localElan : undefined,
    );
    await copyFile(
      path.join(packageRoot, "lean-toolchain"),
      path.join(dir, "lean-toolchain"),
    );
    const version = await ws.exec(["--version"]);
    if (version.code !== 0 || !version.output.includes("version 4.35.0,"))
      throw new Failure(
        "tool-error",
        `Lean 4.35.0 is required. ${version.output}`,
      );
    const copySources = async (root: string, rel = ""): Promise<void> => {
      for (const entry of await readdir(path.join(root, rel), {
        withFileTypes: true,
      })) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist"
        )
          continue;
        const r = path.join(rel, entry.name),
          from = path.join(root, r),
          to = path.join(dir, r);
        if (entry.isDirectory()) {
          await copySources(root, r);
          continue;
        }
        if (!entry.isFile() || !r.endsWith(".lean")) continue;
        if (["Model.lean", "Proof.lean", "InspectContract.lean"].includes(r))
          throw new Failure(
            "spec-error",
            `Reserved generated module name: ${r}`,
          );
        if (await exists(to))
          throw new Failure("spec-error", `Lean module collision: ${r}`);
        await mkdir(path.dirname(to), { recursive: true });
        const content =
          override && path.resolve(from) === path.resolve(override.file)
            ? override.content
            : await readFile(from, "utf8");
        await writeFile(to, content);
      }
    };
    await copySources(path.join(packageRoot, "lean"));
    await copySources(config.root);
    for (const root of config.leanPaths) await copySources(root);
    return ws;
  }
  exec(args: string[]) {
    return run(this.command, args, this.dir, this.env, this.config.timeoutMs);
  }
  module(file: string): string {
    const rel = path.relative(
      this.config.root,
      path.resolve(this.config.root, file),
    );
    if (rel.startsWith("..") || !rel.endsWith(".lean"))
      throw new Failure(
        "spec-error",
        "Specification must be a .lean file inside the config directory.",
      );
    const parts = rel.slice(0, -5).split(path.sep);
    if (!parts.every((p) => /^[A-Za-z_]\w*$/.test(p)))
      throw new Failure("spec-error", `Invalid Lean module path: ${rel}`);
    return parts.join(".");
  }
  async compile(file: string): Promise<void> {
    file = path.resolve(this.dir, file);
    if (this.compiled.has(file)) return;
    if (this.building.has(file))
      throw new Failure("spec-error", `Cyclic Lean import: ${file}`);
    this.building.add(file);
    const deps = await this.exec(["--deps", file]);
    if (deps.code !== 0) throw new Failure("spec-error", deps.output);
    for (const dep of deps.output
      .split("\n")
      .filter((s) => s.endsWith(".olean"))) {
      if (dep.startsWith(this.dir + path.sep))
        await this.compile(dep.slice(0, -6) + ".lean");
    }
    const res = await this.exec(["-o", file.slice(0, -5) + ".olean", file]);
    if (res.code !== 0 || res.output.includes("declaration uses `sorry`"))
      throw new Failure("spec-error", res.output);
    this.compiled.add(file);
    this.building.delete(file);
  }
  async discover(spec: string): Promise<ContractInfo[]> {
    await this.compile("Ts2Lean/Inspect.lean");
    const module = this.module(spec);
    await this.compile(module.replaceAll(".", path.sep) + ".lean");
    const filename = path.join(this.dir, "InspectContract.lean");
    await writeFile(
      filename,
      `import Ts2Lean.Inspect\nimport ${module}\n#ts2lean_contracts ${module}\n`,
    );
    const result = await this.exec([filename]);
    if (result.code !== 0) throw new Failure("spec-error", result.output);
    const marker = "TS2LEAN_CONTRACTS:";
    const line = result.output.split("\n").find((l) => l.includes(marker));
    if (!line)
      throw new Failure(
        "spec-error",
        "Lean did not return contract declarations.",
      );
    const declarations = JSON.parse(
      line.slice(line.indexOf(marker) + marker.length),
    ) as { name: string; kind: ContractInfo["kind"] }[];
    declarations.sort((a, b) => a.name.localeCompare(b.name));
    if (!declarations.length)
      throw new Failure(
        "spec-error",
        `No public ts2lean declarations in ${spec}.`,
      );
    const infos: ContractInfo[] = [];
    for (const { name, kind } of declarations) {
      if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(name))
        throw new Failure(
          "unsupported",
          "Contract names must be simple identifiers.",
        );
      if (kind === "pure") {
        infos.push(await this.inspect(spec, name));
        continue;
      }
      await writeFile(
        filename,
        `import Ts2Lean.Inspect\nimport ${module}\n#ts2lean_audit ${name}\n${kind === "module" ? `#eval IO.println ("TS2LEAN_MODULE:" ++ (Lean.toJson ${name}).compress)` : ""}\n`,
      );
      const result = await this.exec([filename]);
      if (result.code !== 0) throw new Failure("spec-error", result.output);
      const entry: ContractInfo = {
        name,
        kind,
        input: { kind: "bool" },
        output: { kind: "bool" },
        unfold: [],
      };
      if (kind === "module") {
        const marker = "TS2LEAN_MODULE:";
        const line = result.output
          .split("\n")
          .find((l) => l.startsWith(marker));
        if (!line) throw new Failure("spec-error", "Missing module metadata.");
        entry.module = JSON.parse(line.slice(marker.length));
      }
      infos.push(entry);
    }
    return infos;
  }
  async inspect(spec: string, contract: string): Promise<ContractInfo> {
    await this.compile("Ts2Lean/Inspect.lean");
    const module = this.module(spec);
    await this.compile(module.replaceAll(".", path.sep) + ".lean");
    const filename = path.join(this.dir, "InspectContract.lean");
    await writeFile(
      filename,
      `import Ts2Lean.Inspect\nimport ${module}\n#ts2lean_contract ${contract}\n#ts2lean_audit ${contract}\n`,
    );
    const result = await this.exec([filename]);
    if (result.code !== 0) throw new Failure("spec-error", result.output);
    const line = result.output
      .split("\n")
      .find((l) => l.includes("TS2LEAN_CONTRACT:"));
    if (!line)
      throw new Failure("spec-error", "Lean did not return contract metadata.");
    const info = JSON.parse(
      line.slice(line.indexOf("TS2LEAN_CONTRACT:") + 17),
    ) as ContractInfo;
    const validate = (s: Shape): void => {
      if (s.kind === "record") {
        if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(s.lean))
          throw new Failure(
            "unsupported",
            "Lean type names must be simple identifiers.",
          );
        for (const f of s.fields) {
          if (!/^[A-Za-z_]\w*$/.test(f.name))
            throw new Failure(
              "unsupported",
              "Lean fields must be simple identifiers.",
            );
          validate(f.shape);
        }
      }
    };
    validate(info.input);
    validate(info.output);
    return info;
  }
}
