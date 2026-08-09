/** Assertion-side narrowing for JSON tool outputs, without broad casts. */

export function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }

  return value as Record<string, unknown>;
}

export function jsonArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected a JSON array.');
  }

  return value;
}
