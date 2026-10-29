import { expect, test } from "vitest";
import "ts2lean/vitest";
import { canReserve } from "./composition.ts";
import { reservationPolicy } from "./Inventory.lean";
test("injected maximum and enabled policy satisfy the reservation contract", async () => {
  await expect(canReserve).toVerify(reservationPolicy);
});
