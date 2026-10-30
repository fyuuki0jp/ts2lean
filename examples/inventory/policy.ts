export interface ReservationInput {
  readonly available: bigint;
  readonly quantity: bigint;
}
export interface ReservationConfig {
  readonly maximum: bigint;
  readonly enabled: boolean;
}
export function createReservationPolicy(config: ReservationConfig) {
  return (input: ReservationInput): boolean =>
    config.enabled &&
    input.quantity > 0n &&
    input.quantity <= config.maximum &&
    input.quantity <= input.available;
}

export type ReservationDecision =
  | { readonly kind: "reserved"; readonly remaining: bigint }
  | { readonly kind: "rejected" };
export function createReservation(
  policy: (input: ReservationInput) => boolean,
) {
  return (input: ReservationInput): ReservationDecision => {
    if (policy(input))
      return { kind: "reserved", remaining: input.available - input.quantity };
    return { kind: "rejected" };
  };
}
export function remainingStock(decision: ReservationDecision): bigint {
  if (decision.kind === "reserved") return decision.remaining;
  return 0n;
}
