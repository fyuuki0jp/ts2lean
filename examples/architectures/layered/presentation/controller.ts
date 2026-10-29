import { quote } from "../application/quote.ts";
import type { QuoteInput } from "../domain/index.ts";
export function handle(input: QuoteInput): bigint {
  const { amount, discount } = input;
  return quote({ amount, discount });
}
