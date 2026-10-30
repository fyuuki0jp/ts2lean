import { createReservationPolicy, createReservation } from "./policy.ts";
export const canReserve = createReservationPolicy({
  maximum: 5n,
  enabled: true,
});

export const reserve = createReservation(canReserve);
