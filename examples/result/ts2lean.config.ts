export default {
  bindings: [
    { module: "main.ts", export: "advance", spec: "Result.lean", contract: "ResultExample.advance" },
    { module: "main.ts", export: "validate", spec: "Result.lean", contract: "ResultExample.validate" },
    { module: "main.ts", export: "run", spec: "Result.lean", contract: "ResultExample.run" },
  ],
};
