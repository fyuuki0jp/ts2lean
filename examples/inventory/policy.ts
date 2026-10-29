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
