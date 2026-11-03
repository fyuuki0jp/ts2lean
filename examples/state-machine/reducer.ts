export function reduce(state: bigint, add: boolean): bigint {
  if (add) return state + 1n;
  if (state > 0n) return state - 1n;
  return state;
}
