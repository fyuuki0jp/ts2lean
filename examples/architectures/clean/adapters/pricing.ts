import { calculate } from "../domain/quote.ts";
import type { PricingPort } from "../application/quote.ts";
export const pricing = { calculate } satisfies PricingPort;
