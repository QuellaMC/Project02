/**
 * Detection ignores the marker field's value type, so a malformed marker is
 * still recognized and rejected rather than passing as plain data.
 */
import {compareText} from './package-metadata.ts';

export const secretEnvMarkerField = '$env';

export function valueIsSecretMarker(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    secretEnvMarkerField in value
  );
}

/** Keys are visited in sorted order so the reported path is deterministic. */
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
    compareText(left, right),
  );

  for (const [key, entry] of entries) {
    const nested = nestedSecretMarkerPath(entry, `${path}.${key}`);

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}
