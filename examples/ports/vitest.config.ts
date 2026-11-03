import { defineConfig } from "vitest/config";
import { ts2lean } from "@fyuuki0jp/ts2lean/vite";
export default defineConfig({
  root: import.meta.dirname,
  plugins: [ts2lean()],
  test: { include: ["*.test.ts"], testTimeout: 90_000, fileParallelism: false },
});
