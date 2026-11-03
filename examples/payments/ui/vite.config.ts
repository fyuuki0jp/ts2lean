import { defineConfig } from "vite";
// The proof instrumentation is Node-only; the browser uses the ordinary reducer.
export default defineConfig({
  root: import.meta.dirname,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PORT ?? 3000}`,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  // Keep the demo bundle out of the library's published dist/ directory.
  build: { outDir: "dist" },
});
