import {
  isJsonBoundaryCredentialKey,
  redactJsonBoundaryText,
} from '../../shared/redaction.ts';
import {valueIsSecretMarker} from '../../shared/secret-marker.ts';
import type {
  RuntimeConfigValue,
  RedactedRuntimeConfigField,
  ResolvedRuntimeConfigField,
} from './types.ts';

export function redactRuntimeConfigText(value: string): string {
  return redactJsonBoundaryText(value);
}

export function redactRuntimeConfigValue(
  value: RuntimeConfigValue,
  options: {readonly secret?: boolean; readonly key?: string} = {},
): RuntimeConfigValue {
  if (options.secret === true || runtimeConfigValueIsSecretMarker(value)) {
    return '[redacted]';
  }

  if (options.key !== undefined && isJsonBoundaryCredentialKey(options.key)) {
    return '[redacted]';
  }

  if (typeof value === 'string') {
    return redactJsonBoundaryText(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const items: readonly RuntimeConfigValue[] = value;

    return Object.freeze(
      items.map(item => redactRuntimeConfigValue(item, options)),
    );
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(
        ([key, item]: readonly [string, RuntimeConfigValue]) => [
          key,
          redactRuntimeConfigValue(item, {
            key: runtimeConfigRedactionPath(options.key, key),
          }),
        ],
      ),
    ) as Readonly<Record<string, RuntimeConfigValue>>,
  );
}

export function redactResolvedRuntimeConfigField(
  field: ResolvedRuntimeConfigField,
): RedactedRuntimeConfigField {
  return Object.freeze({
    name: field.name,
    secret: field.secret,
    source: field.source,
    resolved: field.resolved,
    ...(field.value === undefined
      ? {}
      : {
          value: redactRuntimeConfigValue(field.value, {
            secret: field.secret,
            key: field.name,
          }),
        }),
  } satisfies RedactedRuntimeConfigField);
}

// Config-typed view over the one shared secret-marker owner.
export function runtimeConfigValueIsSecretMarker(
  value: RuntimeConfigValue,
): boolean {
  return valueIsSecretMarker(value);
}

function runtimeConfigRedactionPath(
  parent: string | undefined,
  key: string,
): string {
  return parent === undefined ? key : `${parent}.${key}`;
}
