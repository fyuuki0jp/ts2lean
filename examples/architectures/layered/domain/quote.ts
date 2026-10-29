export interface QuoteInput {
  readonly amount: bigint;
  readonly discount: bigint;
}
export function calculate({ amount, discount }: QuoteInput): bigint {
  return amount > discount ? amount - discount : 0n;
}
