import { expect, test } from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import { verifyFunction } from "@fyuuki0jp/ts2lean";
import { paymentReducer, initialState, initialPaymentState } from "./reducer";
import type { PaymentState, PaymentAction } from "./reducer";
import {
  reducer,
  preservesState,
  staleResponse,
  retryIdentity,
  initial,
} from "./Reducer.lean";

test("React initializer establishes the state invariant", async () => {
  await expect(initialPaymentState).toVerify(initial);
});

test("React's actual two-argument reducer implements the full transition contract", async () => {
  await expect(paymentReducer).toVerify(reducer);
});
test("all actions preserve valid state", async () => {
  await verifyFunction(paymentReducer, preservesState);
});
test("out-of-order responses do not change current state", async () => {
  await expect(paymentReducer).toVerify(staleResponse);
});
test("retry preserves operation identity and payment details", async () => {
  await expect(paymentReducer).toVerify(retryIdentity);
});
test("a reducer that accepts stale success is rejected", async () => {
  const broken = (state: PaymentState, action: PaymentAction): PaymentState => {
    if (action.kind === "success")
      return {
        amount: state.amount,
        fromAlice: state.fromAlice,
        operation: state.operation,
        request: state.request,
        busy: false,
        failed: false,
        complete: true,
      };
    return paymentReducer(state, action);
  };
  await expect(expect(broken).toVerify(staleResponse)).rejects.toMatchObject({
    result: { status: "unproved" },
  });
});
test("submit, lock, failure, retry, stale response, success and reset", () => {
  let state = paymentReducer(initialState, { kind: "submit" });
  expect(state).toMatchObject({ busy: true, operation: 1n, request: 1n });
  expect(paymentReducer(state, { kind: "submit" })).toBe(state);
  expect(
    paymentReducer(state, { kind: "edit", amount: 999n, fromAlice: false }),
  ).toBe(state);
  state = paymentReducer(state, { kind: "failure", request: 1n });
  expect(paymentReducer(state, { kind: "reset" })).toBe(state);
  state = paymentReducer(state, { kind: "retry" });
  expect(state).toMatchObject({
    busy: true,
    operation: 1n,
    request: 2n,
    amount: 100n,
  });
  expect(paymentReducer(state, { kind: "success", request: 1n })).toBe(state);
  expect(paymentReducer(state, { kind: "failure", request: 1n })).toBe(state);
  state = paymentReducer(state, { kind: "success", request: 2n });
  expect(state.complete).toBe(true);
  expect(paymentReducer(state, { kind: "failure", request: 2n })).toBe(state);
  state = paymentReducer(state, { kind: "reset" });
  expect(paymentReducer(state, { kind: "submit" })).toMatchObject({
    operation: 2n,
    request: 3n,
  });
  expect(
    paymentReducer({ ...initialState, amount: 0n }, { kind: "submit" }).busy,
  ).toBe(false);
});
