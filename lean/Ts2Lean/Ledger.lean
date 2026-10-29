import Ts2Lean.Contract

namespace Ts2Lean.Ledger

structure Request where
  operationId : String
  «from» : String
  to : String
  amount : Int
  deriving DecidableEq, Repr, BEq

def valid (r : Request) : Prop := 0 < r.amount ∧ r.from ≠ r.to ∧ r.operationId ≠ ""

def lookup (xs : List Request) (id : String) : Option Request :=
  xs.find? (fun r => r.operationId == id)

def flow (r : Request) (account : String) : Int :=
  (if account = r.from then -r.amount else 0) + (if account = r.to then r.amount else 0)

def net (xs : List Request) (account : String) : Int :=
  (xs.map (fun r => flow r account)).sum

structure State where
  opening : String → Int
  balances : String → Int
  initialTotal : Int
  total : Int
  requests : String → Option Request
  ledger : List Request

/-- total is the abstraction of SUM(balance), updated by the exact row-update delta. -/
def setBalance (s : State) (key : String) (value : Int) : State :=
  { s with balances := fun a => if a = key then value else s.balances a
           total := s.total + value - s.balances key }
def insertRequest (s : State) (r : Request) : State :=
  { s with requests := fun id => if id = r.operationId then some r else s.requests id }
def insertTransfer (s : State) (r : Request) : State := { s with ledger := r :: s.ledger }

def invariant (s : State) : Prop :=
  (∀ a, 0 ≤ s.balances a) ∧ s.total = s.initialTotal ∧
  (s.ledger.map Request.operationId).Nodup ∧
  (∀ a, s.balances a = s.opening a + net s.ledger a) ∧
  (∀ id r, s.requests id = some r → r.operationId = id ∧ valid r) ∧
  (∀ r ∈ s.ledger, s.requests r.operationId = some r)

def initial (s : State) : Prop :=
  (∀ a, 0 ≤ s.balances a) ∧ s.opening = s.balances ∧ s.total = s.initialTotal ∧
  s.ledger = [] ∧ (∀ id, s.requests id = none)

def persisted (s : State) (r : Request) : Prop := r ∈ s.ledger

theorem initial_safe (s : State) (h : initial s) : invariant s := by
  rcases h with ⟨hpos, hopen, htotal, hledger, hrequests⟩
  simp_all [invariant, net]

theorem lookup_mem {xs : List Request} {id : String} {r : Request}
    (h : lookup xs id = some r) : r ∈ xs := by
  exact List.mem_of_find?_eq_some h

theorem lookup_id {xs : List Request} {id : String} {r : Request}
    (h : lookup xs id = some r) : r.operationId = id := by
  have := List.find?_some h
  simpa using this

theorem lookup_absent {xs : List Request} {id : String} (h : lookup xs id = none) :
    id ∉ xs.map Request.operationId := by
  simp only [lookup, List.find?_eq_none] at h
  intro hm
  obtain ⟨r, hr, he⟩ := List.mem_map.mp hm
  have := h r hr
  simp_all

theorem register_safe (s : State) (r : Request) (h : invariant s)
    (absent : s.requests r.operationId = none) (hv : valid r) : invariant (insertRequest s r) := by
  rcases h with ⟨hp, ht, hu, hb, hr, hl⟩
  refine ⟨hp, ht, hu, hb, ?_, ?_⟩
  · intro id v he
    simp only [insertRequest] at he
    split at he
    · cases he; simp_all
    · exact hr id v he
  · intro v hm
    have hregistered := hl v hm
    have hne : v.operationId ≠ r.operationId := by
      intro he; rw [he, absent] at hregistered; contradiction
    simpa [insertRequest, hne] using hregistered

/-- A proved algebraic rule for two row updates plus an append. Not a DB assumption. -/
def settled (s : State) (r : Request) : State :=
  insertTransfer (setBalance (setBalance s r.from (s.balances r.from - r.amount)) r.to
    (s.balances r.to + r.amount)) r

theorem settle_safe (s : State) (r : Request) (h : invariant s)
    (registered : s.requests r.operationId = some r)
    (absent : lookup s.ledger r.operationId = none)
    (funds : r.amount ≤ s.balances r.from) : invariant (settled s r) := by
  rcases h with ⟨hp, ht, hu, hb, hr, hl⟩
  have hv := (hr r.operationId r registered).2
  rcases hv with ⟨hamount, hdifferent, hid⟩
  have hreverse : r.to ≠ r.from := Ne.symm hdifferent
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro a
    simp only [settled, insertTransfer, setBalance]
    by_cases hto : a = r.to
    · simp [hto]; have := hp r.to; omega
    · by_cases hfrom : a = r.from
      · simp [hto, hfrom, hdifferent]; omega
      · simpa [hto, hfrom] using hp a
  · simp [settled, insertTransfer, setBalance, hreverse]
    omega
  · exact List.nodup_cons.mpr ⟨lookup_absent absent, hu⟩
  · intro a
    have ha := hb a
    simp only [settled, insertTransfer, setBalance, net, List.map_cons, List.sum_cons]
    change (if a = r.to then s.balances r.to + r.amount else if a = r.from then s.balances r.from - r.amount else s.balances a) = s.opening a + (flow r a + net s.ledger a)
    by_cases hto : a = r.to
    · subst a; simp [hreverse, flow]; have := hb r.to; omega
    · by_cases hfrom : a = r.from
      · subst a; simp [hto, flow]; have := hb r.from; omega
      · simp [hto, hfrom, flow]; exact ha
  · exact hr
  · intro v hm
    simp only [settled, insertTransfer, List.mem_cons] at hm
    rcases hm with he | hm
    · subst v; exact registered
    · exact hl v hm

theorem settled_persisted (s : State) (r : Request) : persisted (settled s r) r := by
  simp [persisted, settled, insertTransfer]

theorem registered_self {s : State} {id : String} {r : Request}
    (h : invariant s) (hr : s.requests id = some r) : s.requests r.operationId = some r := by
  have hid := (h.2.2.2.2.1 id r hr).1
  simpa [hid] using hr

theorem registered_id {s : State} {id : String} {r : Request}
    (h : invariant s) (hr : s.requests id = some r) : r.operationId = id :=
  (h.2.2.2.2.1 id r hr).1

theorem ledger_registered {s : State} {id : String} {r : Request}
    (h : invariant s) (hr : lookup s.ledger id = some r) : s.requests r.operationId = some r :=
  h.2.2.2.2.2 r (lookup_mem hr)

theorem lookup_registered_eq {s : State} {id : String} {r prior : Request}
    (h : invariant s) (hr : s.requests id = some r) (hp : lookup s.ledger r.operationId = some prior) : prior = r := by
  have reg := ledger_registered h hp
  have key := lookup_id hp
  have rr := registered_self h hr
  rw [key, rr] at reg
  exact (Option.some.inj reg).symm

inductive Phase where
  | committed | returned | aborted | crashedBeforeCommit | lostResponse | restarted
  deriving DecidableEq, Repr, BEq

abbrev Callback := State → Option Request → State → Prop
structure DatabaseRuntime where
  run : Callback → Phase → State → Option Request → State → Prop

/-- External guarantees about the DB boundary, independent of the payment invariant. -/
structure DatabaseLaws (db : DatabaseRuntime) : Prop where
  atomic : ∀ cb phase s result t, db.run cb phase s result t →
    (phase = .committed ∨ phase = .returned ∨ phase = .lostResponse) → cb s result t
  rollback : ∀ cb phase s result t, db.run cb phase s result t →
    (phase = .aborted ∨ phase = .crashedBeforeCommit ∨ phase = .restarted) → t = s ∧ result = none

structure SystemContract where
  invariant : State → Prop
  initial : State → Prop
  receipt : State → Request → Prop
  allow : Phase → Prop := fun _ => True

structure OperationContract where
  system : SystemContract

inductive Reachable (step : State → State → Prop) : State → State → Prop where
  | refl (s) : Reachable step s s
  | next {s t u} : Reachable step s t → step t u → Reachable step s u

theorem induction_safe (inv : State → Prop) (step : State → State → Prop)
    (preserve : ∀ s t, inv s → step s t → inv t)
    {s t} (start : inv s) (execution : Reachable step s t) : inv t := by
  induction execution with
  | refl => exact start
  | next _ hs ih => exact preserve _ _ ih hs

end Ts2Lean.Ledger
