export type WithdrawInput = {
  readonly balance: bigint;
  readonly amount: bigint;
};

export function withdraw(input: WithdrawInput): bigint {
  return input.balance - input.amount;
}
