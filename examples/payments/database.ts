import type { SerializableDatabase } from "./Database.lean";
import { createDatabase } from "./sqlite.ts";

// These aliases and inheritance are intentional: law identity must survive them.
type DatabaseContract = SerializableDatabase;
interface PaymentDatabase extends DatabaseContract {}

export const db = createDatabase({
  filename: process.env.PAYMENTS_DB ?? "payments.sqlite",
  journalMode: "WAL",
  synchronous: "FULL",
  transactionMode: "IMMEDIATE",
}) satisfies PaymentDatabase;
