import { expect, test } from "vitest";
import "ts2lean/vitest";
import { canReserve, reserve } from "./composition.ts";
import { reservationPolicy, reservation, remaining } from "./Inventory.lean";
test("injected maximum and enabled policy satisfy the reservation contract", async () => {
  await expect(canReserve).toVerify(reservationPolicy);
});

import { remainingStock } from "./policy.ts";
test("reservation results preserve tags and payloads through a Lean inductive type", async () => {
  await expect(reserve).toVerify(reservation);
  await expect(remainingStock).toVerify(remaining);
  expect(reserve({ available: 10n, quantity: 3n })).toEqual({
    kind: "reserved",
    remaining: 7n,
  });
  expect(reserve({ available: 10n, quantity: 6n })).toEqual({
    kind: "rejected",
  });
});
