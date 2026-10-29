import { createReservationPolicy } from "./policy.ts";
export const canReserve = createReservationPolicy({
  maximum: 5n,
  enabled: true,
});
