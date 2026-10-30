import test from "node:test";
import assert from "node:assert/strict";
import {
  minimizeInput,
  encodeInput,
  canonical,
} from "../scripts/observations.mjs";
test("counterexample shrinking terminates while preserving the discrepancy", async () => {
  const shape = {
    kind: "record",
    lean: "Input",
    fields: [
      { name: "x", shape: { kind: "int" } },
      { name: "flag", shape: { kind: "bool" } },
    ],
  };
  const initial = {
    x: "10000000000000000000000000000000000000000",
    flag: true,
  };
  const fails = (i) => BigInt(i.x) > 10n && i.flag;
  let calls = 0;
  const result = await minimizeInput(shape, initial, async (i) => {
    calls++;
    return fails(i);
  });
  assert.equal(fails(result), true);
  assert.ok(BigInt(result.x) < 20n);
  assert.ok(calls < 1000);
  assert.equal(initial.x, "10000000000000000000000000000000000000000");
  const zero = await minimizeInput(shape, initial, async () => true);
  assert.deepEqual(zero, { x: "0", flag: false });
});
test("observation encoding preserves bigint precision and union payload boundaries", () => {
  const union = {
    kind: "union",
    lean: "Choice",
    tag: "kind",
    variants: [
      {
        tag: "value",
        constructor: "Choice.value",
        fields: [{ name: "amount", shape: { kind: "int" } }],
      },
      { tag: "empty", constructor: "Choice.empty", fields: [] },
    ],
  };
  assert.match(
    encodeInput(union, { kind: "value", amount: "9007199254740993" }),
    /9007199254740993/,
  );
  for (const bad of [
    { kind: "unknown" },
    { kind: "empty", extra: "0" },
    { kind: "value", amount: 9007199254740992 },
    { kind: "value", amount: "1e20" },
  ])
    assert.throws(() => encodeInput(union, bad));
  assert.equal(
    canonical({ kind: "value", amount: "9" }),
    canonical({ amount: "9", kind: "value" }),
  );
  assert.notEqual(
    canonical({ kind: "value", amount: "9" }),
    canonical({ kind: "value", amount: 9 }),
  );
});
