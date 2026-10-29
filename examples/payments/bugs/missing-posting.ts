// Intentionally incorrect: used by negative proofs and executable counterexamples.
import { db } from "../database.ts";
import type { TransferRequest, Receipt } from "../Database.lean";

export async function transfer(
  requestInput: TransferRequest,
): Promise<Receipt> {
  const input = { ...requestInput }; // Snapshot caller-owned data before the first await.
  // Persist the original intent before attempting settlement. Retries use the same key.
  await db.transaction(async (tx) => {
    if (
      input.amount <= 0n ||
      input.from === input.to ||
      input.operationId === ""
    ) {
      throw new Error("invalid transfer");
    }
    const prior = await tx.getRequest(input.operationId);
    if (prior) {
      if (
        prior.from !== input.from ||
        prior.to !== input.to ||
        prior.amount !== input.amount
      ) {
        throw new Error("operationId conflicts with a different transfer");
      }
    } else {
      await tx.insertRequest(input);
    }
  });

  return await db.transaction(async (tx) => {
    // Read fresh values inside the serialization boundary, including on recovery.
    const request = await tx.getRequest(input.operationId);
    if (!request) throw new Error("request not registered");
    if (
      request.from !== input.from ||
      request.to !== input.to ||
      request.amount !== input.amount
    ) {
      throw new Error("operationId conflicts with a different transfer");
    }
    const prior = await tx.getTransfer(request.operationId);
    if (prior) return prior;
    const debit = await tx.getBalance(request.from);
    const credit = await tx.getBalance(request.to);
    if (debit < request.amount) throw new Error("insufficient funds");
    await tx.setBalance(request.from, debit - request.amount);
    await tx.setBalance(request.to, credit + request.amount);
    // BUG: balance changes commit without the corresponding ledger record.
    return request;
  });
}

export const retryPendingTransfers = async (): Promise<void> => {
  const pending = await db.listPending();
  for (const request of pending) {
    try {
      await transfer(request);
    } catch {
      // An insufficient balance or transient DB failure leaves the original intent pending.
    }
  }
};

export const recover = async (): Promise<void> => {
  await retryPendingTransfers();
};
