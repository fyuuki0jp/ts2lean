import { ok, err, type Result } from "./result";

export type Problem =
  | { readonly kind: "negative"; readonly amount: bigint }
  | { readonly kind: "tooLarge"; readonly amount: bigint };
export type Success =
  | { readonly kind: "accepted"; readonly amount: bigint }
  | { readonly kind: "unchanged" };

export function validate(input: bigint): Result<boolean, Problem> {
  if (input < 0n) return err<Problem>({ kind: "negative", amount: input });
  return ok<boolean>(true);
}

export function run(input: bigint): Result<Success, Problem> {
  const step = validate(input);
  if (!step.ok) return step;
  if (input > 10n) return err<Problem>({ kind: "tooLarge", amount: input });
  const result = ok<Success>({ kind: "accepted", amount: input + 1n });
  return result;
}

function increment(value: bigint): Result<bigint, never> {
  return ok(value + 1n);
}

export function advance(input: Result<bigint, Problem>): Result<bigint, Problem> {
  if (!input.ok) return input;
  return increment(input.value);
}
