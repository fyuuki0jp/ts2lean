import type { QuoteInput } from "../layered/domain/quote.ts";
import { calculate } from "../layered/domain/quote.ts";

type Quote = (input: QuoteInput) => bigint;
export function createHandler(quote: Quote): Quote {
  return (input: QuoteInput): bigint => quote(input);
}
function incorrect(input: QuoteInput): bigint {
  return input.amount + input.discount;
}
export const handle = createHandler(createHandler(calculate));
export const wrong = createHandler(incorrect);
