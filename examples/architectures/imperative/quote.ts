import type { QuoteInput } from "../layered/domain/quote.ts";
export function handle({ amount, discount }: QuoteInput): bigint {
  let total = amount;
  total -= discount;
  if (total < 0n) {
    total = 0n;
  }
  return total;
}
