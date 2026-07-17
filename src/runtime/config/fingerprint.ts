import type {
  Project02RuntimeConfig,
  RuntimeConfigValue
} from './types.ts';
import { createCanonicalJsonFingerprint } from '../../shared/canonical-json.ts';

export function createRuntimeConfigFingerprint(
  value: RuntimeConfigValue | Project02RuntimeConfig
): string {
  return createCanonicalJsonFingerprint(secretSafeFingerprintValue(value));
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
