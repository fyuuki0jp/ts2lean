import { expect, test, vi } from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import { verifySystem } from "@fyuuki0jp/ts2lean/runtime";
import { ledgerInvariant, transferContract } from "./Payment.lean";
import {
  payments,
  secondPayments,
  ports,
  recoverInjected,
  recoveryPort,
} from "./composition.ts";

test("an async factory service verifies its captured environment", async () => {
  await expect(payments.transfer).toVerify(transferContract);
});
test("async factory services specialize the same source for each captured environment", async () => {
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
    ).rejects.toThrow(/Unregistered function dependency/);
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
    ).rejects.toThrow(/Proxy/);
    expect(reads).toBe(0);
  } finally {
    Object.defineProperty(ports, "db", descriptor);
  }
});
