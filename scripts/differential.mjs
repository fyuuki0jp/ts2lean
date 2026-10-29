// Reproducible generated-program testing of the real TypeScript -> Lean pipeline.
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { ts } from "@ts-morph/common";
import { compileTypeScript } from "../dist/compiler.js";
import { emitModel } from "../dist/emit.js";
import { LeanWorkspace, run } from "../dist/lean.js";
import { createProject } from "../dist/project.js";
const arg = (name, fallback) =>
  process.argv.includes(name)
    ? process.argv[process.argv.indexOf(name) + 1]
    : fallback;
const seed = Number(arg("--seed", "20261030")),
  count = Number(arg("--count", "16"));
if (
  !Number.isSafeInteger(seed) ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 1000
)
  throw Error("Invalid seed/count");
let state = seed >>> 0;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
};
const prefix = "interface Input {readonly x:bigint;readonly flag:boolean}\n";
function generate(index) {
  const a = BigInt((random() % 19) + 1),
    b = BigInt((random() % 17) + 1);
  const bodies = [
    `let y=input.x; if(input.flag){y+=${a}n;}else{y-=${b}n;} {let y=1n;y++;} y*=2n;return y;`,
    `const {x,flag}=input;return flag && x<${a}n ? x+${b}n : x-${a}n;`,
    `let y=input.x;if(y<0n){y=-y;if(input.flag)return y+${a}n;}y++;return y-${b}n;`,
    `const r={value:input.x+${a}n};let y=r.value;y-=input.flag?${b}n:0n;return y+r.value;`,
  ];
  if (index % 5 === 4)
    return (
      prefix +
      `function make(config:{readonly limit:bigint;readonly enabled:boolean}){return (input:Input):bigint=>config.enabled&&input.x>config.limit?config.limit:input.x;}export const run=make({limit:${a}n,enabled:true});`
    );
  return (
    prefix + `export function run(input:Input):bigint{${bodies[index % 4]}}`
  );
}
const outputRoot = path.resolve(".ts2lean/differential");
await mkdir(outputRoot, { recursive: true });
const root = await mkdtemp(path.join(outputRoot, "run-"));
await writeFile(
  path.join(root, "Spec.lean"),
  `import Ts2Lean.Contract\nnamespace Spec\nstructure Input where\n  x : Int\n  flag : Bool\ndef contract : Ts2Lean.Contract Input Int where\n pre := fun _ => True\n post := fun _ _ => True\nend Spec\n`,
);
const ws = await LeanWorkspace.create(createProject(root));
const info = await ws.inspect("Spec.lean", "Spec.contract");
async function compare(source, inputs, mutation = false) {
  const file = path.join(root, "program.ts");
  await writeFile(file, source);
  const ir = compileTypeScript(file, "run", info, new Map());
  let model = emitModel(ir, "Spec");
  if (mutation) model = model.replace(" + ", " - ");
  await writeFile(path.join(ws.dir, "Model.lean"), model);
  const compiled = await ws.exec(["-o", "Model.olean", "Model.lean"]);
  if (compiled.code) throw Error("Lean model failed: " + compiled.output);
  await writeFile(
    path.join(ws.dir, "Eval.lean"),
    "import Model\n" +
      inputs
        .map(
          (i) =>
            `#eval toString (Ts2LeanGenerated.${ir.target} {x := (${i.x}:Int), flag := ${i.flag}})`,
        )
        .join("\n"),
  );
  const lean = await ws.exec(["Eval.lean"]);
  if (lean.code) throw Error("Lean evaluation failed: " + lean.output);
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  await writeFile(
    path.join(root, "native.mjs"),
    js +
      `\nconsole.log(JSON.stringify(${JSON.stringify(inputs)}.map(i=>run({x:BigInt(i.x),flag:i.flag}).toString())));`,
  );
  const native = await run(
    process.execPath,
    [path.join(root, "native.mjs")],
    root,
    process.env,
    5000,
  );
  if (native.code) throw Error("Native execution failed: " + native.output);
  const actual = JSON.parse(native.output.trim()),
    expected = lean.output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  if (actual.length !== inputs.length || expected.length !== inputs.length)
    throw Error("Observation count mismatch");
  return {
    ir,
    model,
    actual,
    expected,
    mismatch: inputs.findIndex((_, i) => actual[i] !== expected[i]),
  };
}
const replay = arg("--replay", null);
const cases = replay
  ? [JSON.parse(await readFile(replay, "utf8"))]
  : Array.from({ length: count }, (_, index) => ({
      version: 1,
      profile: "pure-int",
      seed,
      index,
      source: generate(index),
      inputs: [
        0n,
        1n,
        -1n,
        BigInt(random() % 101) - 50n,
        10n ** 40n,
        -(10n ** 40n),
      ].flatMap((x) => [true, false].map((flag) => ({ x: String(x), flag }))),
    }));
let observations = 0;
for (const c of cases) {
  if (
    c.version !== 1 ||
    c.profile !== "pure-int" ||
    typeof c.source !== "string" ||
    !Array.isArray(c.inputs) ||
    !c.inputs.length ||
    c.inputs.some(
      (i) =>
        typeof i.x !== "string" ||
        !/^-?[0-9]+$/.test(i.x) ||
        typeof i.flag !== "boolean",
    )
  )
    throw Error("Unsupported replay schema");
  await writeFile(
    path.join(root, `case-${c.index}.json`),
    JSON.stringify(c, null, 2),
  );
  const result = await compare(c.source, c.inputs);
  observations += c.inputs.length;
  if (result.mismatch >= 0) {
    let input = c.inputs[result.mismatch];
    // Deterministic input shrinking, preserving the semantic discrepancy.
    for (const x of ["0", "1", "-1", String(BigInt(input.x) / 2n)]) {
      const candidate = { ...input, x };
      const probe = await compare(c.source, [candidate]);
      if (probe.mismatch >= 0) input = candidate;
    }
    const minimized = await compare(c.source, [input]);
    const failure = {
      ...c,
      inputs: [input],
      originalInputs: c.inputs,
      originalActual: result.actual,
      originalExpected: result.expected,
      actual: minimized.actual,
      expected: minimized.expected,
      toolchain: (await readFile("lean-toolchain", "utf8")).trim(),
      node: process.version,
    };
    const destination = path.join(root, `failure-${c.seed}-${c.index}.json`);
    await writeFile(destination, JSON.stringify(failure, null, 2));
    await writeFile(destination + ".lean", minimized.model);
    throw Error(
      `Semantic mismatch. Replay: node scripts/differential.mjs --replay ${destination}`,
    );
  }
}
// The harness must detect a deliberately incorrect arithmetic translation.
const sentinel =
  prefix + "export function run(input:Input):bigint{return input.x+1n;}";
const corrupted = await compare(sentinel, [{ x: "0", flag: false }], true);
if (corrupted.mismatch < 0) throw Error("Mutation sensitivity failed");
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(
    {
      seed,
      programs: cases.length,
      observations,
      mutationDetected: true,
      node: process.version,
      toolchain: (await readFile("lean-toolchain", "utf8")).trim(),
    },
    null,
    2,
  ),
);
console.log(`Artifacts: ${root}`);
console.log(
  `Differential: ${cases.length} programs, ${observations} observations, seed ${seed}; mutation detected.`,
);
