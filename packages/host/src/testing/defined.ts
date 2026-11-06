/** Narrows a value a test expects to exist, failing loudly with `what` when it does not. */
export function defined<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}
