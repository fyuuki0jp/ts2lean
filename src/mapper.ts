#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { LeanWorkspace, packageRoot, exists } from "./lean.js";
import { contractTypes } from "./verify.js";
import { createProject, leanSources } from "./project.js";
import type { ResolvedConfig, VerificationOptions } from "./types.js";

async function dependencies(config: ResolvedConfig): Promise<string[]> {
  const files = await leanSources([
    config.root,
    ...config.leanPaths,
    path.join(packageRoot, "lean"),
  ]);
  return [
    ...new Set([
      ...(config.configFile ? [config.configFile] : []),
      path.join(packageRoot, "lean-toolchain"),
      ...files,
    ]),
  ].sort();
}
interface ProjectRequest {
  root: string;
  options: VerificationOptions & { config?: string };
}
async function resolveProject(
  request: ProjectRequest,
): Promise<ResolvedConfig> {
  const file = path.resolve(
    request.root,
    request.options.config ?? "ts2lean.config.ts",
  );
  if (request.options.config || (await exists(file))) return loadConfig(file);
  return createProject(request.root, request.options);
}
export class Mapper {
  private projects = new Map<string, ProjectRequest>();
  async handle(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "initialize") {
      if (
        (params.protocolVersion !== undefined &&
          params.protocolVersion !== 1) ||
        !Array.isArray(params.positionEncodings) ||
        !params.positionEncodings.includes("utf-16")
      )
        throw new Error("Requires Content Mapper protocol v1 and UTF-16.");
      return {
        protocolVersion: 1,
        positionEncoding: "utf-16",
        diagnosticSource: "ts2lean",
      };
    }
    if (method === "openProject") {
      const options = (params.options ?? {}) as ProjectRequest["options"];
      const root = path.dirname(String(params.configFileName));
      const request = { root, options };
      const config = await resolveProject(request),
        watchedFiles = await dependencies(config);
      const hash = createHash("sha256");
      for (const f of watchedFiles)
        hash
          .update(f)
          .update("\0")
          .update(await readFile(f));
      this.projects.set(String(params.projectHandle), request);
      return { configIdentity: hash.digest("hex"), watchedFiles };
    }
    if (method === "closeProject") {
      this.projects.delete(String(params.projectHandle));
      return null;
    }
    if (method === "transform") {
      const request = this.projects.get(String(params.projectHandle));
      if (!request) throw new Error("Unknown project handle.");
      let ws: LeanWorkspace | undefined;
      try {
        const config = await resolveProject(request),
          filename = path.resolve(String(params.fileName));
        ws = await LeanWorkspace.create(config, {
          file: filename,
          content: String(params.content),
        });
        const infos = await ws.discover(filename);
        return { text: contractTypes(infos), extension: ".ts", mappings: [] };
      } catch (e) {
        return {
          text: "export {};",
          extension: ".ts",
          mappings: [],
          diagnostics: [
            {
              start: 0,
              length: 0,
              code: 1,
              messageText: e instanceof Error ? e.message : String(e),
            },
          ],
        };
      } finally {
        if (ws) await rm(ws.dir, { recursive: true, force: true });
      }
    }
    throw new Error(`Unknown method: ${method}`);
  }
}
export function serve(): void {
  const mapper = new Mapper();
  let buffer: Buffer = Buffer.alloc(0),
    queue = Promise.resolve();
  const send = (value: unknown): void => {
    const body = Buffer.from(JSON.stringify(value));
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  };
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) break;
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(
        buffer.subarray(0, boundary).toString(),
      );
      const length = match ? Number(match[1]) : -1;
      if (length < 0 || length > 16_000_000) {
        process.stderr.write("Invalid Content-Length\n");
        process.exitCode = 1;
        process.stdin.destroy();
        return;
      }
      if (buffer.length < boundary + 4 + length) break;
      const payload = buffer
        .subarray(boundary + 4, boundary + 4 + length)
        .toString();
      buffer = buffer.subarray(boundary + 4 + length);
      queue = queue.then(async () => {
        let request: {
          id?: string | number;
          method: string;
          params?: Record<string, unknown>;
        };
        try {
          request = JSON.parse(payload);
        } catch {
          send({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          return;
        }
        try {
          const result = await mapper.handle(
            request.method,
            request.params ?? {},
          );
          if (request.id !== undefined)
            send({ jsonrpc: "2.0", id: request.id, result });
        } catch (e) {
          if (request.id !== undefined)
            send({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32603,
                message: e instanceof Error ? e.message : String(e),
              },
            });
        }
      });
    }
  });
  process.stdin.on("end", () => {
    if (buffer.length) {
      process.stderr.write("Truncated JSON-RPC frame\n");
      process.exitCode = 1;
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  serve();
