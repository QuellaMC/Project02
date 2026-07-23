/**
 * The one owner of reserved secret-marker detection. A config value is
 * a secret marker when it is an object carrying a `$env` or
 * `$plaintextSecret` field — regardless of the field's value type, so
 * a malformed marker (e.g. a non-string `$env`) is still recognized and
 * rejected instead of slipping through as plain data. Package parsing,
 * raw resolution, scoped policy, and mutation validation all detect
 * markers through this module, and every diagnostic names nested
 * positions in one canonical path format: `parent.key` for object
 * fields and `parent[index]` for array entries.
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

/**
 * Walks a value and returns the canonical path of the first secret
 * marker found (object keys visited in sorted order for determinism),
 * or undefined when the value embeds none.
 */
export function nestedSecretMarkerPath(
  value: unknown,
  path: string,
): string | undefined {
  if (valueIsSecretMarker(value)) {
    return path;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const nested = nestedSecretMarkerPath(entry, `${path}[${String(index)}]`);

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
    const nested = nestedSecretMarkerPath(entry, `${path}.${key}`);

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}
