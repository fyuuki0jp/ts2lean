import { expect, test, vi } from "vitest";
import "ts2lean/vitest";
import { verifySystem } from "ts2lean/runtime";
import { ledgerInvariant, transferContract } from "./Payment.lean";
import {
  payments,
  secondPayments,
  ports,
  recoverInjected,
  recoveryPort,
} from "./composition.ts";

test("async factory services specialize the same source for each captured environment", async () => {
  await expect(payments.transfer).toVerify(transferContract);
  const result = await verifySystem(
    {
      first: payments.transfer,
      second: secondPayments.transfer,
      recoverInjected,
    },
    ledgerInvariant,
  );
  expect(result.status).toBe("verified");
  expect(result.scope?.transactions).toBe(4);
});
test("an injected helper cannot be replaced with a mock", async () => {
  const spy = vi.spyOn(recoveryPort, "retry").mockResolvedValue();
  try {
    await expect(
      verifySystem({ recoverInjected }, ledgerInvariant),
    ).rejects.toThrow(/source or dependency changed/);
  } finally {
    spy.mockRestore();
  }
});
test("injected DB getters and proxies are rejected without invoking traps", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(ports, "db")!;
  let reads = 0;
  try {
    Object.defineProperty(ports, "db", {
      configurable: true,
      get() {
        reads++;
        return descriptor.value;
      },
    });
    await expect(
      verifySystem({ transfer: payments.transfer }, ledgerInvariant),
    ).rejects.toThrow(/accessor/);
    expect(reads).toBe(0);
    Object.defineProperty(ports, "db", {
      ...descriptor,
      value: new Proxy(descriptor.value, {
        get() {
          reads++;
          throw new Error("trap");
        },
      }),
    });
    await expect(
      verifySystem({ transfer: payments.transfer }, ledgerInvariant),
    ).rejects.toThrow(/identity mismatch/);
    expect(reads).toBe(0);
  } finally {
    Object.defineProperty(ports, "db", descriptor);
  }
});
