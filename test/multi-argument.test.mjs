import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fixture } from "./helpers.mjs";
import { processBindings } from "../dist/verify.js";
import { compileTypeScript } from "../dist/compiler.js";
const spec = `import Ts2Lean.Contract
namespace Spec
structure Input where
 left : Int
 right : Int
def contract : Ts2Lean.Contract Input Int where
 pre := fun _ => True
 post := fun i o => o = i.left - i.right
end Spec`;
const source = `function subtract(first:bigint, second:bigint):bigint{return first-second;}
export function run(right:bigint,left:bigint):bigint{return subtract(left,right);}`;
test("multiple parameters pack by name while calls preserve declaration order", async () => {
  const f = await fixture(source, spec);
  try {
    const [good] = await processBindings(f.config, "verify");
    assert.equal(good.status, "verified", good.message);
    await writeFile(
      path.join(f.dir, "main.ts"),
      source.replace("subtract(left,right)", "subtract(right,left)"),
    );
    const [bad] = await processBindings(f.config, "verify");
    assert.equal(bad.status, "unproved", bad.message);
    await writeFile(
      path.join(f.dir, "main.ts"),
      source.replaceAll("left", "renamed"),
    );
    const [mismatch] = await processBindings(f.config, "verify");
    assert.equal(mismatch.status, "type-error", mismatch.message);
  } finally {
    await f.cleanup();
  }
});
test("multiple-argument boundary rejects defaults, rest, destructuring, missing and extra arguments", async () => {
  const info = {
    name: "Spec.contract",
    input: {
      kind: "record",
      lean: "Spec.Input",
      fields: [
        { name: "left", shape: { kind: "int" } },
        { name: "right", shape: { kind: "int" } },
      ],
    },
    output: { kind: "int" },
    unfold: [],
  };
  const f = await fixture(source, spec);
  try {
    for (const invalid of [
      source.replace("right:bigint,left", "right:bigint=0n,left"),
      source.replace(
        "right:bigint,left:bigint",
        "right:bigint,...left:bigint[]",
      ),
      source.replace(
        "right:bigint,left:bigint",
        "{right}:{readonly right:bigint},left:bigint",
      ),
      source.replace("subtract(left,right)", "subtract(left)"),
      source.replace("subtract(left,right)", "subtract(left,right,0n)"),
      source.replace(
        "right:bigint,left:bigint",
        "this:bigint,right:bigint,left:bigint",
      ),
    ]) {
      await writeFile(path.join(f.dir, "main.ts"), invalid);
      assert.throws(
        () =>
          compileTypeScript(
            path.join(f.dir, "main.ts"),
            "run",
            info,
            new Map(),
          ),
        (e) => ["unsupported", "type-error"].includes(e.status),
      );
    }
  } finally {
    await f.cleanup();
  }
});
