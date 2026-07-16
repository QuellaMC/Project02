import { createHash } from 'node:crypto';

import type {
  Project02RuntimeConfig,
  RuntimeConfigValue
} from './types.ts';

export function createRuntimeConfigFingerprint(
  value: RuntimeConfigValue | Project02RuntimeConfig
): string {
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

export function createProject02RuntimeConfigFingerprint(
  config: Project02RuntimeConfig
): string {
  return createRuntimeConfigFingerprint(config);
}

function secretSafeFingerprintValue(value: unknown): unknown {
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

  if (typeof value !== 'object') {
    return null;
  }

  if ('$env' in value && typeof value.$env === 'string') {
    return {
      $secretRef: value.$env
    };
  }

  if (
    '$plaintextSecret' in value &&
    'justification' in value &&
    typeof value.justification === 'string'
  ) {
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
