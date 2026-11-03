import { expect, test } from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import { validate, run, advance } from "./main";
import { validate as validateContract, run as runContract, advance as advanceContract } from "./Result.lean";

test("boolean Result preserves the validation outcome", async () => {
  await expect(validate).toVerify(validateContract);
});
test("ROP preserves the first failure and the success payload", async () => {
  await expect(run).toVerify(runContract);
});

test("successful values flow to the next pure function; failures are preserved", async () => {
  await expect(advance).toVerify(advanceContract);
});

test("unused overloads and generators retain runtime behavior after instrumentation", async () => {
  const { take, sequence, ok, err } = await import("./result");
  expect(sequence(take(ok(7n)))).toEqual({ ok: true, value: 7n });
  const failure = err({ kind: "negative", amount: -1n });
  expect(sequence(take(failure))).toBe(failure);
});
