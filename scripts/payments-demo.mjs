import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const database = path.resolve(
  process.env.PAYMENTS_DB ??
    path.join(root, ".ts2lean/payments-demo/ledger.sqlite"),
);
const env = { ...process.env, PAYMENTS_DB: database };
await mkdir(path.dirname(database), { recursive: true });
if (
  !(await access(database).then(
    () => true,
    () => false,
  ))
) {
  const seed = spawn(process.execPath, ["examples/payments/cli.ts", "seed"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => seed.on("exit", resolve));
  if (code !== 0) process.exit(1);
}
console.log(`Demo SQLite: ${database}`);
const api = spawn(process.execPath, ["examples/payments/server.ts"], {
  cwd: root,
  env,
  stdio: ["inherit", "pipe", "inherit"],
});
let ui;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  api.kill("SIGTERM");
  ui?.kill("SIGTERM");
}
api.stdout.on("data", (data) => {
  process.stdout.write(data);
  if (!ui && data.toString().includes("Payments API:")) {
    ui = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--config",
        "examples/payments/ui/vite.config.ts",
      ],
      { cwd: root, env, stdio: "inherit" },
    );
    ui.on("error", (error) => {
      console.error(error);
      stop(1);
    });
    ui.on("exit", (code) => stop(code ?? 1));
  }
});
api.on("error", (error) => {
  console.error(error);
  stop(1);
});
api.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
