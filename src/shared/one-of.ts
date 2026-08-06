/**
 * Narrowing a value to one of a fixed set of strings. The one
 * implementation of the rule, so no two call sites can drift on how the
 * comparison narrows.
 */
export function isOneOf<const T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}
