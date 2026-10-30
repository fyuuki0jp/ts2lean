import type {
  TransferRequest,
  Receipt,
  SerializableDatabase,
} from "./Database.lean";

export function createPaymentService(ports: {
  readonly db: SerializableDatabase;
}) {
  const transfer = async (requestInput: TransferRequest): Promise<Receipt> => {
    const input = { ...requestInput }; // Snapshot caller-owned data before the first await.
    // Persist the original intent before attempting settlement. Retries use the same key.
    await ports.db.transaction(async (tx) => {
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

    return await ports.db.transaction(async (tx) => {
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
      await tx.insertTransfer(request);
      return request;
    });
  };

  const retryPendingTransfers = async (): Promise<void> => {
    const pending = await ports.db.listPending();
    for (const request of pending) {
      try {
        await transfer(request);
      } catch {
        // An insufficient balance or transient DB failure leaves the original intent pending.
      }
    }
  };

  const recover = async (): Promise<void> => {
    await retryPendingTransfers();
  };

  return { transfer, retryPendingTransfers, recover };
}
