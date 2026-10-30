import { defineConfig } from "vitest/config";
import { ts2lean } from "ts2lean/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PAYMENTS_DB ??= path.join(
  mkdtempSync(path.join(tmpdir(), "ts2lean-payments-")),
  "ledger.sqlite",
);
export default defineConfig({
  root: import.meta.dirname,
  plugins: [ts2lean()],
  test: { include: ["*.test.ts"], fileParallelism: false, testTimeout: 90_000 },
});
