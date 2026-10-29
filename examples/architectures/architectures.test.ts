import { expect, test } from "vitest";
import "ts2lean/vitest";
import { nonnegativeQuote } from "./Quote.lean";
import { handle as layered } from "./layered/presentation/controller.ts";
import { handle as clean, useCase } from "./clean/composition.ts";
import { handle as imperative } from "./imperative/quote.ts";
import { handle as injected, wrong } from "./function-di/composition.ts";

test("layered: controller → application → domain, through a barrel and namespace import", async () => {
  await expect(layered).toVerify(nonnegativeQuote);
});
test("clean architecture: controller → injected use case → pricing port → domain", async () => {
  await expect(clean).toVerify(nonnegativeQuote);
});
test("an exported service method can be verified directly", async () => {
  await expect(useCase.execute).toVerify(nonnegativeQuote);
});
test("function injection verifies the concrete dependency", async () => {
  await expect(injected).toVerify(nonnegativeQuote);
});
test("the same factory with an incorrect dependency does not inherit the proof", async () => {
  await expect(expect(wrong).toVerify(nonnegativeQuote)).rejects.toMatchObject({
    result: { status: "unproved" },
  });
});
test("local let updates preserve the same contract", async () => {
  await expect(imperative).toVerify(nonnegativeQuote);
});
test("ordinary execution agrees across architectures", () => {
  for (const amount of [0n, 1n, 10n, 10n ** 30n]) {
    for (const discount of [0n, 1n, 20n]) {
      const input = { amount, discount };
      const expected = amount > discount ? amount - discount : 0n;
      for (const fn of [layered, clean, useCase.execute, injected, imperative])
        expect(fn(input)).toBe(expected);
    }
  }
});
