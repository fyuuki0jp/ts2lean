export type DraftHistory<T> = {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
};

export type HistoryAction<T> =
  | { readonly kind: "change"; readonly value: T }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

export function createHistory<T>(initial: T): DraftHistory<T> {
  return { past: [], present: initial, future: [] };
}

/** The same value comparison and history order are shared by every caller. */
export function transitionHistory<T>(
  state: DraftHistory<T>,
  action: HistoryAction<T>,
  maximumPast: number,
): DraftHistory<T> {
  if (action.kind === "change") {
    if (JSON.stringify(action.value) === JSON.stringify(state.present)) return state;
    return {
      past: [...state.past, state.present].slice(-maximumPast),
      present: action.value,
      future: [],
    };
  }
  if (action.kind === "undo") {
    if (!state.past.length) return state;
    return {
      past: state.past.slice(0, -1),
      present: state.past.at(-1)!,
      future: [state.present, ...state.future],
    };
  }
  if (!state.future.length) return state;
  return {
    past: [...state.past, state.present],
    present: state.future[0]!,
    future: state.future.slice(1),
  };
}
