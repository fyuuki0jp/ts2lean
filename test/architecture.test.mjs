import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { ts } from "@ts-morph/common";
import { fixture, intSpec } from "./helpers.mjs";
import { compileTypeScript } from "../dist/compiler.js";
import { emitModel, emitProof } from "../dist/emit.js";
import { LeanWorkspace } from "../dist/lean.js";
const contract = {
  name: "Spec.contract",
  input: { kind: "int" },
  output: { kind: "int" },
  unfold: [],
};

test("static DI specializes each closure and Lean agrees with JavaScript on local updates", async () => {
  const source = `
interface Port { readonly apply: (x:bigint)=>bigint }
function plus(x:bigint):bigint {return x+1n;}
function minus(x:bigint):bigint {return x-1n;}
function make(port:Port):(x:bigint)=>bigint {return x=>port.apply(x);}
const positive=make({apply:plus});
const negative=make({apply:minus});
const chained=make({apply:positive});
export const run=(x:bigint):bigint=>chained(x)+negative(x);
export function updates(x:bigint):bigint {
  let result=x, extra=2n;
  if(x>0n){result+=extra;extra*=3n;}else{result--;}
  { let result=100n; result++; extra+=result; }
  { result*=2n; }
  if(x===3n){result=-result;return result;}
  result-=extra;
  x++;
  return result+x;
}
`;
  const f = await fixture(source, intSpec);
  try {
    const ws = await LeanWorkspace.create(f.config);
    await ws.inspect("Spec.lean", "Spec.contract");
    const js = await import(
      "data:text/javascript;base64," +
        Buffer.from(
          ts.transpileModule(source, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
            },
          }).outputText,
        ).toString("base64")
    );
    for (const name of ["run", "updates"]) {
      const ir = compileTypeScript(
        path.join(f.dir, "main.ts"),
        name,
        contract,
        new Map(),
      );
      if (name === "run") {
        const closures = ir.functions.filter((fn) =>
          fn.localName.startsWith("@"),
        );
        assert.equal(closures.length, 3);
        assert.notEqual(
          closures[0].calls[0].target,
          closures[1].calls[0].target,
        );
      }
      await writeFile(path.join(ws.dir, "Model.lean"), emitModel(ir, "Spec"));
      // Recompile explicitly: both models deliberately use the same module name.
      const compiled = await ws.exec(["-o", "Model.olean", "Model.lean"]);
      assert.equal(compiled.code, 0, compiled.output);
      const inputs = [-(10n ** 30n), -2n, 0n, 1n, 3n, 10n ** 30n];
      await writeFile(
        path.join(ws.dir, "Eval.lean"),
        "import Model\n" +
          inputs
            .map(
              (x) =>
                `#eval toString (Ts2LeanGenerated.${ir.target} (${x}:Int))`,
            )
            .join("\n"),
      );
      const result = await ws.exec(["Eval.lean"]);
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(
        result.output.trim().split("\n").map(JSON.parse),
        inputs.map((x) => js[name](x).toString()),
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("static wiring rejects unresolved or effectful composition", async (t) => {
  const f = await fixture("", intSpec);
  const prefix = `type Fn=(x:bigint)=>bigint; function add(x:bigint):bigint{return x+1n;} `;
  const cases = [
    [
      "factory effects",
      `function make(f:Fn):Fn{console.log("effect");return x=>f(x);}export const run=make(add);`,
    ],
    [
      "runtime dependency choice",
      `function make(f:Fn):Fn{return x=>f(x);}export const run=make(Date.now()>0?add:add);`,
    ],
    [
      "getter port",
      `function make(p:{readonly apply:Fn}):Fn{return x=>p.apply(x);}export const run=make({get apply(){return add;}});`,
    ],
    [
      "unsupported string capture",
      `function make(n:string):Fn{return x=>x;}export const run=make("one");`,
    ],
    [
      "runtime factory invocation",
      `function make(f:Fn):Fn{return x=>f(x);}export function run(x:bigint):bigint{const f=make(add);return f(x);}`,
    ],
    [
      "this-dependent method",
      `export const service={apply(x:bigint):bigint{return this.other(x);},other:add};export const run=service.apply;`,
    ],
    ["bound function", `export const run=add.bind(null);`],
    [
      "factory recursion",
      `function make(f:Fn):Fn{return make(f);}export const run=make(add);`,
    ],
    [
      "assignment in expression",
      `export function run(x:bigint):bigint{let y=x;return y++ + y;}`,
    ],
    ["hoisted var", `export function run(x:bigint):bigint{var y=x;return y;}`],
    [
      "property mutation",
      `export function run(x:bigint):bigint{let y={x};y.x+=1n;return y.x;}`,
    ],
  ];
  try {
    for (const [name, body] of cases)
      await t.test(name, async () => {
        await writeFile(path.join(f.dir, "main.ts"), prefix + body);
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
