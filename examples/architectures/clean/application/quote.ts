import type { QuoteInput } from "../domain/quote.ts";
export interface PricingPort {
  readonly calculate: (input: QuoteInput) => bigint;
}
export interface QuoteUseCase {
  readonly execute: (input: QuoteInput) => bigint;
}
export function createQuoteUseCase(pricing: PricingPort): QuoteUseCase {
  return {
    execute(input: QuoteInput): bigint {
      return pricing.calculate(input);
    },
  };
}
