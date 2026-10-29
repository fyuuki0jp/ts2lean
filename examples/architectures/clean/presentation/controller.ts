import type { QuoteInput } from "../domain/quote.ts";
import type { QuoteUseCase } from "../application/quote.ts";
export function createController({
  execute,
}: QuoteUseCase): (input: QuoteInput) => bigint {
  return (input: QuoteInput): bigint => execute(input);
}
