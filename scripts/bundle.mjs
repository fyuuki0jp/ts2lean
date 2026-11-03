import { readFile, writeFile } from "node:fs/promises";
import { rolldown } from "rolldown";

// tsc emits declarations and internal modules. Bundle only the Vite entry's
// source-editing dependencies; native TypeScript must keep its package layout.
const bundle = await rolldown({
  input: "dist/vite.js",
  external: (id) =>
    id.startsWith(".") ||
    id.startsWith("node:") ||
    id.startsWith("typescript/"),
});
try {
  await bundle.write({
    file: "dist/vite.js",
    format: "esm",
    banner: "// Bundled dependency licenses: THIRD_PARTY_NOTICES.txt",
  });
} finally {
  await bundle.close();
}
const notices = await Promise.all(
  ["magic-string", "@jridgewell/sourcemap-codec"].map(
    async (name) =>
      `${name}\n\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`,
  ),
);
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n\n"));
