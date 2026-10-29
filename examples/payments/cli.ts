import { db } from "./database.ts";
import { transfer, recover } from "./service.ts";

const json = (v: unknown) =>
  JSON.stringify(v, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
const command = process.argv[2];
try {
  if (command === "seed") {
    const balances = JSON.parse(
      process.argv[3] ?? '{"alice":"1000","bob":"0"}',
    ) as Record<string, string>;
    await db.seed(
      Object.fromEntries(
        Object.entries(balances).map(([id, n]) => [id, BigInt(n)]),
      ),
    );
  } else if (command === "transfer") {
    const [operationId, from, to, amount] = process.argv.slice(3);
    if (!operationId || !from || !to || !amount)
      throw new Error("transfer <operationId> <from> <to> <integer amount>");
    let commits = 0;
    db.setFaultHook((point) => {
      if (point === "afterCommit") commits++;
      if (
        process.env.CRASH_AT === point &&
        (point !== "afterCommit" || commits === 2)
      )
        process.kill(process.pid, "SIGKILL");
    });
    console.log(
      json(await transfer({ operationId, from, to, amount: BigInt(amount) })),
    );
  } else if (command === "recover") await recover();
  else if (command === "snapshot") console.log(json(await db.snapshot()));
  else
    throw new Error(
      "Usage: cli.ts seed [balances-json] | transfer id from to amount | recover | snapshot",
    );
} finally {
  await db.close();
}
