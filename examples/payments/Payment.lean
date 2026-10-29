import Ts2Lean.Ledger

namespace Payment
open Ts2Lean.Ledger

/-- Closed ledger: nonnegative balances, conservation, posting consistency,
unique operation IDs, immutable valid intents, and persisted receipts. -/
def ledgerInvariant : SystemContract where
  initial := initial
  invariant := invariant
  receipt := persisted
  allow := fun _ => True  -- arbitrary commit order, retries, abort, crash, lost response, restart

def transferContract : OperationContract where
  system := ledgerInvariant
end Payment
