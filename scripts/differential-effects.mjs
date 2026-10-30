// Bounded generated async programs: compare complete finite outcome sets,
// including primitive order, arguments, completion values and visible state.
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { LeanWorkspace } from "../dist/lean.js";
import { createProject } from "../dist/project.js";
import { compileEffects } from "../dist/effects/compiler.js";
import { emitEffects } from "../dist/effects/emit.js";
import {
  wrap,
  nativeObservations,
  observationProgram,
} from "./effect-observations.mjs";
const arg = (name, fallback) =>
  process.argv.includes(name)
    ? process.argv[process.argv.indexOf(name) + 1]
    : fallback;
const seed = Number(arg("--seed", "20261030")),
  count = Number(arg("--count", "12"));
if (
  !Number.isSafeInteger(seed) ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 1000
)
  throw Error("Invalid seed/count");
let state = seed >>> 0;
const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
const base = path.resolve("examples/payments");
await mkdir(path.join(base, ".ts2lean"), { recursive: true });
const root = await mkdtemp(path.join(base, ".ts2lean", "differential-"));
const ws = await LeanWorkspace.create(
  createProject(base, { maxHeartbeats: 800000 }),
);
await ws.compile("Ts2Lean/LedgerEffects.lean");
const declarations = new Map();
for (const file of ["Database.lean", "Payment.lean"])
  declarations.set(path.join(base, file), await ws.discover(file));
const file = path.join(root, "program.ts");
function generate(index) {
  const n = random() % 13;
  const bodies = [
    `try {await tx.setBalance("alice",${n}n);return input;} finally {await tx.setBalance("bob",${n + 1}n);}`,
    `try {await tx.insertRequest(input);throw "caught";} catch(error) {return input;} finally {await tx.getBalance("alice");}`,
    `const n=await tx.getBalance("alice");if(n>${n}n){await tx.setBalance("bob",n);}else{throw ${n}n;}return input;`,
    `try {throw "original";} finally {try {await tx.setBalance("alice",${n}n);} catch(error){throw error;}}`,
    `await tx.insertRequest(input);try {await tx.insertTransfer(input);} finally {return input;}`,
    `try {return;} finally {await tx.getBalance("alice");await tx.getBalance("bob");}`,
  ];
  let source = wrap(bodies[index % 6]).replaceAll("../", "../../");
  if (index % 2 === 1)
    source =
      source
        .replace("import { db }", "import { db as adapter }")
        .replace(
          "export async function scenario",
          "function make(db:typeof adapter){return async function scenario",
        ) + "\n}\nexport const scenario=make(adapter);";
  return {
    version: 1,
    profile: "completion-ledger",
    seed,
    index,
    source,
    sites: 3,
  };
}
async function compare(c, mutation = false) {
  if (
    c.version !== 1 ||
    c.profile !== "completion-ledger" ||
    typeof c.source !== "string" ||
    !Number.isInteger(c.sites) ||
    c.sites < 0 ||
    c.sites > 6
  )
    throw Error("Unsupported replay schema");
  await writeFile(file, c.source);
  const ir = compileEffects([{ file, name: "scenario" }], declarations);
  if (ir.transactions.length !== 1) throw Error("Expected one callback");
  const proof = emitEffects(
    ir,
    "Payment",
    "Payment.ledgerInvariant",
    false,
    800000,
    true,
  );
  await writeFile(path.join(ws.dir, "Coverage.lean"), proof);
  const certified = await ws.exec(["Coverage.lean"]);
  if (certified.code)
    throw Error("Coverage certificate failed: " + certified.output);
  const site = structuredClone(ir.transactions[0]);
  if (mutation)
    for (const p of site.completions) p.events = p.events.toReversed();
  const model = observationProgram(site);
  await writeFile(path.join(ws.dir, "Observations.lean"), model);
  const evaluated = await ws.exec(["Observations.lean"]);
  if (evaluated.code)
    throw Error("Lean evaluation failed: " + evaluated.output);
  const line = evaluated.output.split("\n").find((l) => l.startsWith("OBS:"));
  if (!line) throw Error("Missing observations");
  const expected = [
    ...new Set(JSON.parse(line.slice(4)).map((o) => JSON.stringify(o))),
  ].sort();
  const actual = await nativeObservations(c.source, c.sites);
  return {
    actual,
    expected,
    model,
    proof,
    mismatch: JSON.stringify(actual) !== JSON.stringify(expected),
  };
}
const replay = arg("--replay", null);
const cases = replay
  ? [JSON.parse(await readFile(replay, "utf8"))]
  : Array.from({ length: count }, (_, i) => generate(i));
let observations = 0;
for (const c of cases) {
  const filename = path.join(root, `case-${c.index}.json`);
  await writeFile(filename, JSON.stringify(c, null, 2));
  let result;
  try {
    result = await compare(c);
  } catch (error) {
    await writeFile(filename + ".error.txt", String(error));
    throw error;
  }
  observations += result.actual.length;
  if (result.mismatch) {
    await writeFile(
      path.join(root, `failure-${c.index}.json`),
      JSON.stringify(
        {
          ...c,
          ...result,
          node: process.version,
          toolchain: (await readFile("lean-toolchain", "utf8")).trim(),
        },
        null,
        2,
      ),
    );
    await writeFile(filename + ".lean", result.model);
    throw Error(
      `Semantic mismatch: node scripts/differential-effects.mjs --replay ${filename}`,
    );
  }
}
const sentinel = {
  version: 1,
  profile: "completion-ledger",
  sites: 2,
  source: wrap(
    'await tx.getBalance("alice");await tx.getBalance("bob");',
  ).replaceAll("../", "../../"),
};
if (!(await compare(sentinel, true)).mismatch)
  throw Error("Trace-order mutation was not detected");
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(
    {
      seed: replay ? cases[0].seed : seed,
      replay: replay ?? undefined,
      programs: cases.length,
      observations,
      traceMutationDetected: true,
      node: process.version,
      toolchain: (await readFile("lean-toolchain", "utf8")).trim(),
    },
    null,
    2,
  ),
);
console.log(`Artifacts: ${root}`);
console.log(
  `Effects differential: ${cases.length} programs, ${observations} distinct observations; trace-order mutation detected.`,
);
