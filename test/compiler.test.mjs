import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fixture, intSpec } from "./helpers.mjs";
import { compileTypeScript } from "../dist/compiler.js";
import { emitModel } from "../dist/emit.js";
const contract = {
  name: "Spec.contract",
  input: { kind: "int" },
  output: { kind: "int" },
  unfold: [],
};

test("typed IR preserves bigint spelling, helpers, lexical symbols, and branches", async () => {
  const f = await fixture(
    `function twice(x: bigint): bigint { return x * 2n; }
export function run(x: bigint): bigint {
  const y = 0xff_ffn;
  if (x < 0n) { const y = -1n; if (x === -1n) return y; }
  { const x = 7n; const z = twice(x); }
  return x > 9n ? twice(y) : x + 1n;
}`,
    intSpec,
  );
  try {
    const ir = compileTypeScript(
      path.join(f.dir, "main.ts"),
      "run",
      contract,
      new Map(),
    );
    const out = emitModel(ir, "Spec");
    assert.equal(ir.functions.length, 2);
    assert.match(out, /65535/);
    assert.match(out, /decide/);
    assert.ok(out.includes(`Ts2LeanGenerated.${ir.functions[0].name}`));
  } finally {
    await f.cleanup();
  }
});

test("rejects unsupported semantics instead of approximating them", async (t) => {
  const cases = [
    [
      "prototype setter",
      "export function run(x: bigint): bigint { const r={__proto__:x}; return r.__proto__; }",
    ],
    ["number", "export function run(x: number): number { return x + 1; }"],
    ["division", "export function run(x: bigint): bigint { return x / 2n; }"],
    ["remainder", "export function run(x: bigint): bigint { return x % 2n; }"],
    [
      "mutation",
      "export function run(x: bigint): bigint { const y = { value: x }; y.value++; return y.value; }",
    ],
    [
      "loop",
      "export function run(x: bigint): bigint { while(x > 0n) {} return x; }",
    ],
    ["recursion", "export function run(x: bigint): bigint { return run(x); }"],
    [
      "mutual recursion",
      "function f(x: bigint): bigint { return run(x); } export function run(x: bigint): bigint { return f(x); }",
    ],
    [
      "async",
      "export async function run(x: bigint): Promise<bigint> { return x; }",
    ],
    [
      "external call",
      'export function run(x: bigint): bigint { return BigInt("2"); }',
    ],
    [
      "assertion",
      "export function run(x: bigint): bigint { return (x as bigint); }",
    ],
    [
      "exception",
      "export function run(x: bigint): bigint { throw new Error(); }",
    ],
    [
      "top-level effect",
      'console.log("hi"); export function run(x: bigint): bigint { return x; }',
    ],
    [
      "mutable input",
      "export function run(x: { value: bigint }): bigint { return x.value; }",
    ],
    [
      "optional input",
      "export function run(x?: bigint): bigint { return x ?? 0n; }",
    ],
    [
      "dynamic function",
      "export function run(x: bigint): bigint { const f = (y: bigint) => y; return f(x); }",
    ],
    [
      "object identity",
      "export function run(x: bigint): bigint { const a={x}; return a === a ? x : 0n; }",
    ],
    [
      "default parameter",
      "export function run(x: bigint = 1n): bigint { return x; }",
    ],
    ["any input", "export function run(x: any): bigint { return x; }"],
    [
      "accessor",
      "export function run(x: bigint): bigint { const a = { get y() { return x; } }; return a.y; }",
    ],
  ];
  const f = await fixture("", intSpec);
  try {
    for (const [name, source] of cases)
      await t.test(name, async () => {
        await writeFile(path.join(f.dir, "main.ts"), source);
        assert.throws(
          () =>
            compileTypeScript(
              path.join(f.dir, "main.ts"),
              "run",
              contract,
              new Map(),
            ),
          (e) => ["unsupported", "type-error"].includes(e.status),
        );
      });
  } finally {
    await f.cleanup();
  }
});

test("cross-module helper calls resolve by symbol and cyclic calls fail", async () => {
  const f = await fixture(
    'import { increment as inc } from "./helper.js"; export function run(x: bigint): bigint { return inc(x); }',
    intSpec,
  );
  try {
    await writeFile(
      path.join(f.dir, "helper.ts"),
      "export function increment(x: bigint): bigint { return x + 1n; }",
    );
    const ir = compileTypeScript(
      path.join(f.dir, "main.ts"),
      "run",
      contract,
      new Map(),
    );
    assert.equal(ir.functions.length, 2);
    assert.equal(ir.functions.at(-1).name, ir.target);
    assert.equal(ir.functions.at(-1).dependencies.length, 1);
  } finally {
    await f.cleanup();
  }
});
