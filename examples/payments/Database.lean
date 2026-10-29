import Ts2Lean.Modules

namespace Database
open Ts2Lean
private def req : ApiType := .named "TransferRequest"
private def str : ApiType := .scalar "string"
private def integer : ApiType := .scalar "bigint"
private def promise (t : ApiType) : ApiType := .app "promise" [t]
private def optional (t : ApiType) : ApiType := .app "nullable" [t]
private def unit : ApiType := .scalar "void"

def SerializableDatabase : ModuleContract where
  identity := "sqlite.serializable.ledger.v1"
  interfaces := [
    { name := "TransferRequest", fields := [("operationId", str), ("from", str), ("to", str), ("amount", integer)] },
    { name := "Receipt", aliasOf := some "TransferRequest" },
    { name := "Transaction", methods := [
      { name := "getRequest", parameters := [("id", str)], result := promise (optional req), operation := "request.get" },
      { name := "insertRequest", parameters := [("request", req)], result := promise unit, operation := "request.insert" },
      { name := "getTransfer", parameters := [("id", str)], result := promise (optional req), operation := "ledger.get" },
      { name := "getBalance", parameters := [("id", str)], result := promise integer, operation := "balance.get" },
      { name := "setBalance", parameters := [("id", str), ("amount", integer)], result := promise unit, operation := "balance.set" },
      { name := "insertTransfer", parameters := [("request", req)], result := promise unit, operation := "ledger.insert" }
    ] },
    { name := "SerializableDatabase", methods := [
      { name := "transaction", generics := ["T"], parameters := [("callback", .callback [.named "Transaction"] (promise (.named "T")))], result := promise (.named "T"), operation := "transaction" },
      { name := "listPending", parameters := [], result := promise (.app "array" [req]), operation := "request.pending" },
      { name := "getBalance", parameters := [("id", str)], result := promise integer, operation := "balance.get" }
    ] }
  ]
  laws := [
    { name := "serializable-atomic-callback", statement := "BEGIN IMMEDIATE executes the exact sequential callback against an exclusive writer snapshot; only its complete successful effects can commit." },
    { name := "rollback-and-crash", statement := "Abort and process death before commit discard all uncommitted writes; reads expose committed snapshots only." },
    { name := "durable-commit", statement := "A completed commit survives restart, including when the response is lost; WAL with synchronous FULL and honest filesystem sync." },
    { name := "row-refinement-and-uniqueness", statement := "The adapter implements the specified keyed reads/inserts and balance overwrite, uniqueness rejects duplicates, pending enumerates original unposted requests, decimal TEXT roundtrips exact integers." }
  ]
  settings := [("journalMode", "wal"), ("synchronous", "2"), ("readUncommitted", "0"), ("transactionMode", "IMMEDIATE")]
end Database
