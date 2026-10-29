import * as domain from "../domain/index.ts";
import type { QuoteInput } from "../domain/index.ts";
export const quote = (input: QuoteInput): bigint => domain.price(input);
