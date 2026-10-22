/** Whether a parsed JSON value is an object: what a record or an envelope must be before its fields are read. */
export function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
