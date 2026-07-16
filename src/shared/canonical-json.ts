import { createHash } from 'node:crypto';

export function canonicalJsonValuesEqual(
  left: unknown,
  right: unknown
): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) =>
      canonicalJsonValuesEqual(value, right[index])
    );
  }

  if (Array.isArray(right)) {
    return false;
  }

  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }

  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        canonicalJsonValuesEqual(leftRecord[key], rightRecord[key])
    )
  );
}

export function canonicalJsonStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;

    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`
      )
      .join(',')}}`;
  }

  return JSON.stringify(null);
}

export function createCanonicalJsonFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(value))
    .digest('hex')}`;
}
