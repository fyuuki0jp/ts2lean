import { pricing } from "./adapters/pricing.ts";
import { createQuoteUseCase } from "./application/quote.ts";
import { createController } from "./presentation/controller.ts";
export const useCase = createQuoteUseCase(pricing);
export const handle = createController(useCase);
