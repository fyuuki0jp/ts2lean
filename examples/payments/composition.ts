import { db } from "./database.ts";
import { createPaymentService } from "./service-factory.ts";
export const ports = { db };
export const payments = createPaymentService(ports);
export const secondPayments = createPaymentService({ db });
function createRecovery(port: { readonly retry: () => Promise<void> }) {
  return async (): Promise<void> => {
    await port.retry();
  };
}
export const recoveryPort = { retry: payments.retryPendingTransfers };
export const recoverInjected = createRecovery(recoveryPort);
