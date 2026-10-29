import { DatabaseSync } from "node:sqlite";
import type { TransferRequest, Receipt, Transaction } from "./Database.lean";

export interface DatabaseOptions {
  filename: string;
  journalMode: "WAL";
  synchronous: "FULL";
  transactionMode: "IMMEDIATE";
}
export type FaultPoint =
  | "afterRequest"
  | "afterDebit"
  | "afterCredit"
  | "afterLedger"
  | "beforeCommit"
  | "afterCommit";
export class LostResponse extends Error {}

/** Real SQLite adapter. Its implementation/refinement is an explicitly assumed boundary. */
export function createDatabase(options: DatabaseOptions) {
  const connection = new DatabaseSync(options.filename);
  connection.exec(
    `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA read_uncommitted=OFF; PRAGMA busy_timeout=25;`,
  );
  connection.exec(`
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, opening TEXT NOT NULL, balance TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS requests (operation_id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS transfers (
      operation_id TEXT PRIMARY KEY REFERENCES requests(operation_id),
      sender TEXT NOT NULL REFERENCES accounts(id), recipient TEXT NOT NULL REFERENCES accounts(id), amount TEXT NOT NULL
    ) STRICT;
  `);
  let tail = Promise.resolve();
  let hook: ((point: FaultPoint) => void | Promise<void>) | undefined;
  let closed = false;
  const decode = (
    row: Record<string, unknown> | undefined,
  ): TransferRequest | null =>
    row
      ? {
          operationId: String(row.operation_id),
          from: String(row.sender),
          to: String(row.recipient),
          amount: BigInt(String(row.amount)),
        }
      : null;
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      if (closed) throw new Error("database closed");
      return await action();
    } finally {
      release();
    }
  }
  return {
    async transaction<T>(
      callback: (tx: Transaction) => Promise<T>,
    ): Promise<T> {
      return locked(async () => {
        connection.exec("BEGIN IMMEDIATE");
        let active = true;
        let writes = 0;
        const check = () => {
          if (!active) throw new Error("transaction escaped its lifetime");
        };
        const tx: Transaction = {
          async getRequest(id) {
            check();
            return decode(
              connection
                .prepare("SELECT * FROM requests WHERE operation_id = ?")
                .get(id),
            );
          },
          async insertRequest(request) {
            check();
            connection
              .prepare("INSERT INTO requests VALUES (?, ?, ?, ?)")
              .run(
                request.operationId,
                request.from,
                request.to,
                request.amount.toString(),
              );
            await hook?.("afterRequest");
          },
          async getTransfer(id) {
            check();
            return decode(
              connection
                .prepare("SELECT * FROM transfers WHERE operation_id = ?")
                .get(id),
            );
          },
          async getBalance(id) {
            check();
            const row = connection
              .prepare("SELECT balance FROM accounts WHERE id = ?")
              .get(id);
            if (!row) throw new Error("unknown account");
            return BigInt(String(row.balance));
          },
          async setBalance(id, amount) {
            check();
            const result = connection
              .prepare("UPDATE accounts SET balance = ? WHERE id = ?")
              .run(amount.toString(), id);
            if (result.changes !== 1) throw new Error("unknown account");
            // No business safety checks here: the service must establish them.
            await hook?.(++writes === 1 ? "afterDebit" : "afterCredit");
          },
          async insertTransfer(request) {
            check();
            connection
              .prepare("INSERT INTO transfers VALUES (?, ?, ?, ?)")
              .run(
                request.operationId,
                request.from,
                request.to,
                request.amount.toString(),
              );
            await hook?.("afterLedger");
          },
        };
        try {
          const result = await callback(tx);
          await hook?.("beforeCommit");
          connection.exec("COMMIT");
          active = false;
          await hook?.("afterCommit"); // Failure here is NOT a rollback.
          return result;
        } catch (error) {
          if (active) {
            try {
              connection.exec("ROLLBACK");
            } finally {
              active = false;
            }
          }
          throw error;
        }
      });
    },
    async getBalance(id: string): Promise<bigint> {
      return locked(async () => {
        const row = connection
          .prepare("SELECT balance FROM accounts WHERE id = ?")
          .get(id);
        if (!row) throw new Error("unknown account");
        return BigInt(String(row.balance));
      });
    },
    async listPending(): Promise<TransferRequest[]> {
      return locked(async () =>
        connection
          .prepare(
            "SELECT r.* FROM requests r WHERE NOT EXISTS (SELECT 1 FROM transfers t WHERE t.operation_id = r.operation_id) ORDER BY r.operation_id",
          )
          .all()
          .map((row) => decode(row)!),
      );
    },
    async seed(accounts: Record<string, bigint>) {
      return locked(async () => {
        connection.exec("BEGIN IMMEDIATE");
        try {
          if (connection.prepare("SELECT 1 FROM accounts LIMIT 1").get())
            throw new Error("seed requires an empty database");
          for (const [id, balance] of Object.entries(accounts)) {
            if (!id || balance < 0n) throw new Error("invalid opening balance");
            connection
              .prepare("INSERT INTO accounts VALUES (?, ?, ?)")
              .run(id, balance.toString(), balance.toString());
          }
          connection.exec("COMMIT");
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      });
    },
    async snapshot() {
      return locked(async () => ({
        accounts: connection
          .prepare("SELECT * FROM accounts ORDER BY id")
          .all()
          .map((r) => ({
            id: String(r.id),
            opening: BigInt(String(r.opening)),
            balance: BigInt(String(r.balance)),
          })),
        requests: connection
          .prepare("SELECT * FROM requests ORDER BY operation_id")
          .all()
          .map((r) => decode(r)!),
        transfers: connection
          .prepare("SELECT * FROM transfers ORDER BY operation_id")
          .all()
          .map((r) => decode(r)!),
      }));
    },
    settings() {
      return {
        journalMode: connection.prepare("PRAGMA journal_mode").get()
          ?.journal_mode,
        synchronous: connection.prepare("PRAGMA synchronous").get()
          ?.synchronous,
        readUncommitted: connection.prepare("PRAGMA read_uncommitted").get()
          ?.read_uncommitted,
        transactionMode: "IMMEDIATE",
      };
    },
    setFaultHook(value?: typeof hook) {
      hook = value;
    },
    async close() {
      await locked(async () => {
        connection.close();
        closed = true;
      });
    },
  };
}
