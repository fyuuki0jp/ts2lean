import { db } from "./database.ts";

const variant = process.argv[2];
if (
  !["stale-balance", "missing-posting", "changed-retry-id"].includes(
    variant ?? "",
  )
)
  throw new Error("Choose stale-balance, missing-posting or changed-retry-id");
const { transfer, recover } = (await import(
  `./bugs/${variant}.ts`
)) as typeof import("./service.ts");
const request = {
  operationId: "original",
  from: "alice",
  to: "bob",
  amount: 10n,
};
const trace: string[] = [];
try {
  await db.seed({ alice: 100n, bob: 0n });
  if (variant === "stale-balance") {
    trace.push(
      "A and B register distinct intents",
      "A and B read alice=100 before settlement",
      "A sends 80",
      "B overwrites alice with stale 100-80 and credits another 80",
    );
    await Promise.all([
      transfer({ ...request, operationId: "A", amount: 80n }),
      transfer({ ...request, operationId: "B", amount: 80n }),
    ]);
  } else if (variant === "missing-posting") {
    trace.push(
      "original updates balances but omits ledger posting",
      "retry sees no posting and updates balances a second time",
    );
    await transfer(request);
    await transfer(request);
  } else {
    trace.push(
      "original intent commits",
      "settlement aborts after debit",
      "recover changes original to original-retry",
      "client retries original and posts again",
    );
    db.setFaultHook((point) => {
      if (point === "afterDebit") throw new Error("abort");
    });
    try {
      await transfer(request);
    } catch {}
    db.setFaultHook();
    await recover();
    await transfer(request);
  }
  const state = await db.snapshot();
  const total = state.accounts.reduce((sum, a) => sum + a.balance, 0n);
  const reconciles = state.accounts.every(
    (a) =>
      a.balance ===
      a.opening +
        state.transfers.reduce(
          (sum, r) =>
            sum +
            (r.to === a.id ? r.amount : 0n) -
            (r.from === a.id ? r.amount : 0n),
          0n,
        ),
  );
  const violated =
    variant === "stale-balance"
      ? total !== 100n
      : variant === "missing-posting"
        ? !reconciles
        : state.transfers.some((r) => r.operationId === "original-retry") &&
          state.transfers.some((r) => r.operationId === "original");
  if (!violated) throw new Error("Counterexample did not reproduce");
  console.log(
    JSON.stringify(
      { status: "counterexample", variant, trace, total, reconciles, state },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
} finally {
  await db.close();
}
