export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export type Failure<E> = { readonly ok: false; readonly error: E };
export const err = <E>(error: E): Failure<E> => ({ ok: false, error });

// Co-located helpers may be outside the proof subset. Importing this module must
// preserve their syntax and runtime behavior; verification never calls these.
export function take<E>(result: Failure<E>): Generator<Failure<E>, never, unknown>;
export function take<T, E>(result: Result<T, E>): Generator<Failure<E>, T, unknown>;
export function* take<T, E>(result: Result<T, E>): Generator<Failure<E>, T, unknown> {
  if (!result.ok) {
    yield result;
    return undefined as never;
  }
  return result.value;
}
export function sequence<T, F extends Failure<unknown>>(
  steps: Generator<F, T, unknown>,
): Result<T, F["error"]> {
  const next = steps.next();
  if (next.done) return ok(next.value);
  steps.return(undefined as never);
  return next.value;
}
