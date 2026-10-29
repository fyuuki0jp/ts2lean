import { expect, test } from "vitest";
import "ts2lean/vitest";
import { withdraw } from "./balance";
import { withdraw as withdrawContract } from "./Balance.lean";

test("引き出し後も残高は非負で、指定額だけ減る", async () => {
  await expect(withdraw).toVerify(withdrawContract);
});
