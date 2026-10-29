import path from "node:path";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { loadConfig } from "../dist/config.js";
export const root = path.resolve(".");
export async function fixture(source, spec, options = {}) {
  await mkdir(".ts2lean", { recursive: true });
  const dir = await mkdtemp(path.join(root, ".ts2lean/test-"));
  await writeFile(path.join(dir, "main.ts"), source);
  await writeFile(path.join(dir, "Spec.lean"), spec);
  await writeFile(
    path.join(dir, "ts2lean.config.ts"),
    `export default ${JSON.stringify({ bindings: [{ module: "main.ts", export: "run", spec: "Spec.lean", contract: "Spec.contract" }], ...options })};`,
  );
  return {
    dir,
    config: await loadConfig(path.join(dir, "ts2lean.config.ts")),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
export const intSpec = `import Ts2Lean.Contract
namespace Spec
def contract : Ts2Lean.Contract Int Int where
  pre := fun _ => True
  post := fun i o => o = i + 1
end Spec
`;
