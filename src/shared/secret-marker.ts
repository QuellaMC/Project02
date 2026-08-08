/**
 * Detection ignores the marker field's value type, so a malformed marker is
 * still recognized and rejected rather than passing as plain data.
 */
export const secretEnvMarkerField = '$env';
export const plaintextSecretMarkerField = '$plaintextSecret';
export const allowPlaintextSecretMarkerField = 'allowPlaintextSecret';

export function valueIsSecretMarker(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (secretEnvMarkerField in value || plaintextSecretMarkerField in value)
  );
}

export type NestedSecretMarkerPathOptions = {
  readonly rejectPlaintextAllowanceMarker?: boolean;
};

/** Keys are visited in sorted order so the reported path is deterministic. */
export function nestedSecretMarkerPath(
  value: unknown,
  path: string,
  options: NestedSecretMarkerPathOptions = {},
): string | undefined {
  if (
    valueIsSecretMarker(value) ||
    (options.rejectPlaintextAllowanceMarker === true &&
      valueHasPlaintextAllowanceMarker(value))
  ) {
    return path;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const nested = nestedSecretMarkerPath(
        entry,
        `${path}[${String(index)}]`,
        options,
      );

      if (nested !== undefined) {
        return nested;
      }
    }

    return undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  for (const [key, entry] of entries) {
    const nested = nestedSecretMarkerPath(entry, `${path}.${key}`, options);

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function valueHasPlaintextAllowanceMarker(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, allowPlaintextSecretMarkerField)
  );
}
