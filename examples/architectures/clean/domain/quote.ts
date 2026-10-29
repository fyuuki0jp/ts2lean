export interface QuoteInput {
  readonly amount: bigint;
  readonly discount: bigint;
}
export function calculate(input: QuoteInput): bigint {
  const { amount: subtotal, discount } = input;
  if (subtotal < discount) return 0n;
  return subtotal - discount;
}
