import { createServer } from "node:http";
import { db } from "./database.ts";
import { transfer, recover } from "./service.ts";

// Transport validation is outside the verified service; only plain data reaches it.
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
await recover();
const server = createServer(async (req, res) => {
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(value, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
  };
  try {
    if (req.method === "POST" && req.url === "/transfers") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw new Error("request too large");
      }
      const value = JSON.parse(body) as Record<string, unknown>;
      if (
        !id(value.operationId) ||
        !id(value.from) ||
        !id(value.to) ||
        typeof value.amount !== "string" ||
        !/^\d+$/.test(value.amount)
      )
        throw new Error(
          "expected operationId/from/to identifiers and a decimal integer amount string",
        );
      reply(
        200,
        await transfer({
          operationId: value.operationId,
          from: value.from,
          to: value.to,
          amount: BigInt(value.amount),
        }),
      );
    } else if (req.method === "GET" && req.url?.startsWith("/balances/")) {
      const account = req.url.slice("/balances/".length);
      if (!id(account)) throw new Error("invalid account");
      reply(200, { account, balance: await db.getBalance(account) });
    } else reply(404, { error: "not found" });
  } catch (error) {
    reply(400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () =>
  console.log(
    `Payments API: http://127.0.0.1:${(server.address() as { port: number }).port}`,
  ),
);
process.on("SIGTERM", () =>
  server.close(() => {
    void db.close();
  }),
);
