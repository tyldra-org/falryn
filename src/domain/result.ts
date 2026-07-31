/**
 * The domain's expected-failure convention.
 *
 * Domain contracts return a `Result` instead of throwing for failures a caller
 * is expected to handle, so cancellation, rejection, and version skew stay
 * visible in the type rather than in message text.
 */

export type Ok<Value> = {
  readonly ok: true;
  readonly value: Value;
};

export type Err<Error> = {
  readonly ok: false;
  readonly error: Error;
};

export type Result<Value, Error> = Ok<Value> | Err<Error>;

export function ok<Value>(value: Value): Ok<Value> {
  return { ok: true, value };
}

export function err<Error>(error: Error): Err<Error> {
  return { ok: false, error };
}

/**
 * Compile-time exhaustiveness guard.
 *
 * Reaching this function means a union gained a member that a switch does not
 * handle; the call fails type-checking before it can fail at runtime.
 */
export function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
