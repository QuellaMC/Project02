import { createHash } from 'node:crypto';

import type { RuntimeConfigValue } from './types.ts';

export function createRuntimeConfigFingerprint(value: RuntimeConfigValue): string {
  return `sha256:${createHash('sha256')
    .update(stableStringify(secretSafeFingerprintValue(value)))
    .digest('hex')}`;
}

export function stableStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(null);
}

function secretSafeFingerprintValue(value: RuntimeConfigValue): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(secretSafeFingerprintValue);
  }

  if ('$env' in value) {
    return {
      $secretRef: value.$env
    };
  }

  if ('$plaintextSecret' in value) {
    return {
      $plaintextSecret: '[redacted]',
      justification: value.justification
    };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretSafeFingerprintValue(item)
    ])
  );
}
