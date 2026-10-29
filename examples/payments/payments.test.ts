import { afterAll, beforeAll, expect, test, vi } from "vitest";
import "ts2lean/vitest";
import { verifySystem } from "ts2lean/runtime";
import { ledgerInvariant, transferContract } from "./Payment.lean";
import { transfer, retryPendingTransfers, recover } from "./service.ts";
import { db } from "./database.ts";

beforeAll(async () => {
  await db.seed({ alice: 1000n, bob: 0n });
});
afterAll(async () => {
  await db.close();
});

test("Lean proves all finite interleavings, failures and restarts under explicit database laws", async () => {
  const result = await verifySystem(
    { transfer, retryPendingTransfers, recover },
    ledgerInvariant,
  );
  expect(result.status).toBe("verified");
  expect(result.scope?.transactions).toBe(2);
  expect(result.assumptions?.[0]?.assurance).toBe("assumed");
});

test("the matcher binds an operation to its contract", async () => {
  await expect(transfer).toVerify(transferContract);
});

test("an adapter mock cannot acquire database laws by structural compatibility", async () => {
  const spy = vi.spyOn(db, "transaction");
  try {
    await expect(verifySystem({ transfer }, ledgerInvariant)).rejects.toThrow(
      /method replaced/,
    );
  } finally {
    spy.mockRestore();
  }
});

test("ordinary execution: concurrent retries, conflicting payloads, lost response and recovery", async () => {
  const request = {
    operationId: "one",
    from: "alice",
    to: "bob",
    amount: 100n,
  };
  await Promise.all(Array.from({ length: 20 }, () => transfer(request)));
  await expect(transfer({ ...request, amount: 101n })).rejects.toThrow(
    /conflicts/,
  );
  expect((await db.snapshot()).transfers).toHaveLength(1);
  let commits = 0;
  db.setFaultHook((point) => {
    if (point === "afterCommit" && ++commits === 2)
      throw new Error("lost response");
  });
  await expect(transfer({ ...request, operationId: "two" })).rejects.toThrow(
    /lost response/,
  );
  db.setFaultHook();
  await transfer({ ...request, operationId: "two" });
  db.setFaultHook((point) => {
    if (point === "afterDebit") throw new Error("stop before commit");
  });
  await expect(
    transfer({ ...request, operationId: "three" }),
  ).rejects.toThrow();
  db.setFaultHook();
  expect((await db.snapshot()).transfers).toHaveLength(2);
  await Promise.all([recover(), retryPendingTransfers(), recover()]);
  const state = await db.snapshot();
  expect(state.transfers).toHaveLength(3);
  expect(state.accounts.map((a) => a.balance)).toEqual([700n, 300n]);
  const mutable = { ...request, operationId: "snapshot" };
  const response = transfer(mutable);
  mutable.amount = 900n;
  expect((await response).amount).toBe(100n);
});
