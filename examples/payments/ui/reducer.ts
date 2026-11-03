export type PaymentState = {
  readonly amount: bigint;
  readonly fromAlice: boolean;
  readonly operation: bigint;
  readonly request: bigint;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly complete: boolean;
};
export type PaymentAction =
  | {
      readonly kind: "edit";
      readonly amount: bigint;
      readonly fromAlice: boolean;
    }
  | { readonly kind: "submit" }
  | { readonly kind: "retry" }
  | { readonly kind: "success"; readonly request: bigint }
  | { readonly kind: "failure"; readonly request: bigint }
  | { readonly kind: "reset" };

export function initialPaymentState(_input: boolean): PaymentState {
  return {
    amount: 100n,
    fromAlice: true,
    operation: 0n,
    request: 0n,
    busy: false,
    failed: false,
    complete: false,
  };
}
export const initialState = initialPaymentState(false);

// This exact function is passed to React.useReducer and verified in reducer.test.ts.
export function paymentReducer(
  state: PaymentState,
  action: PaymentAction,
): PaymentState {
  if (action.kind === "edit") {
    if (state.busy || state.failed || state.complete) return state;
    return {
      amount: action.amount,
      fromAlice: action.fromAlice,
      operation: state.operation,
      request: state.request,
      busy: false,
      failed: false,
      complete: false,
    };
  }
  if (action.kind === "submit") {
    if (state.busy || state.failed || state.complete || state.amount <= 0n)
      return state;
    return {
      amount: state.amount,
      fromAlice: state.fromAlice,
      operation: state.operation + 1n,
      request: state.request + 1n,
      busy: true,
      failed: false,
      complete: false,
    };
  }
  if (action.kind === "retry") {
    if (!state.failed || state.busy || state.complete) return state;
    return {
      amount: state.amount,
      fromAlice: state.fromAlice,
      operation: state.operation,
      request: state.request + 1n,
      busy: true,
      failed: false,
      complete: false,
    };
  }
  if (action.kind === "success") {
    if (!state.busy || action.request !== state.request) return state;
    return {
      amount: state.amount,
      fromAlice: state.fromAlice,
      operation: state.operation,
      request: state.request,
      busy: false,
      failed: false,
      complete: true,
    };
  }
  if (action.kind === "failure") {
    if (!state.busy || action.request !== state.request) return state;
    return {
      amount: state.amount,
      fromAlice: state.fromAlice,
      operation: state.operation,
      request: state.request,
      busy: false,
      failed: true,
      complete: false,
    };
  }
  if (!state.complete) return state;
  return {
    amount: state.amount,
    fromAlice: state.fromAlice,
    operation: state.operation,
    request: state.request,
    busy: false,
    failed: false,
    complete: false,
  };
}
