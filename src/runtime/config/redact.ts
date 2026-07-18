import { isJsonBoundaryCredentialKey, redactJsonBoundaryText } from '../../shared/redaction.ts';
import type {
  RuntimeConfigValue,
  RedactedRuntimeConfigField,
  ResolvedRuntimeConfigField
} from './types.ts';

export function redactRuntimeConfigText(value: string): string {
  return redactJsonBoundaryText(value);
}

export function redactRuntimeConfigValue(
  value: RuntimeConfigValue,
  options: { readonly secret?: boolean; readonly key?: string } = {}
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
      items.map((item) => redactRuntimeConfigValue(item, options))
    );
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]: readonly [string, RuntimeConfigValue]) => [
        key,
        redactRuntimeConfigValue(item, {
          key: runtimeConfigRedactionPath(options.key, key)
        })
      ])
    ) as Readonly<Record<string, RuntimeConfigValue>>
  );
}

export function redactResolvedRuntimeConfigField(
  field: ResolvedRuntimeConfigField
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
            key: field.name
          })
        })
  } satisfies RedactedRuntimeConfigField);
}

// The single owner of secret-marker detection: a config value is a secret
// marker when it is a `$env` or `$plaintextSecret` object.
export function runtimeConfigValueIsSecretMarker(
  value: RuntimeConfigValue
): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('$env' in value || '$plaintextSecret' in value)
  );
}

function runtimeConfigRedactionPath(
  parent: string | undefined,
  key: string
): string {
  return parent === undefined ? key : `${parent}.${key}`;
}
