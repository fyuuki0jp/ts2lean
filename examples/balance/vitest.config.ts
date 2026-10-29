import { defineConfig } from "vitest/config";
import { ts2lean } from "ts2lean/vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [ts2lean()],
  test: {
    include: ["balance.test.ts"],
    testTimeout: 60_000,
  },
});
