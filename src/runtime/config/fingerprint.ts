import type {Project02RuntimeConfig, RuntimeConfigValue} from './types.ts';
import {createCanonicalJsonFingerprint} from '../../shared/canonical-json.ts';
import {
  plaintextSecretMarkerField,
  secretEnvMarkerField,
} from '../../shared/secret-marker.ts';

export function createRuntimeConfigFingerprint(
  value: RuntimeConfigValue | Project02RuntimeConfig,
): string {
  return createCanonicalJsonFingerprint(secretSafeFingerprintValue(value));
}

/**
 * Authored-config fingerprint across both layers: the global document
 * plus the active character's overlay document (null when the overlay
 * file is absent — deliberately distinct from an empty document). The
 * envelope also makes a layered fingerprint of a global document differ
 * from that document's per-file fingerprint, so a layered currency gate
 * can never be satisfied with a single-file value.
 */
export function createLayeredRuntimeConfigFingerprint(options: {
  readonly globalConfig: Project02RuntimeConfig;
  readonly characterId: string;
  readonly overlayConfig: RuntimeConfigValue | Project02RuntimeConfig | null;
}): string {
  return createCanonicalJsonFingerprint(
    secretSafeFingerprintValue({
      layers: {
        global: options.globalConfig,
        character: options.overlayConfig,
      },
      characterId: options.characterId,
    }),
  );
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

  if (secretEnvMarkerField in value && typeof value.$env === 'string') {
    return {
      $secretRef: value.$env,
    };
  }

  if (
    plaintextSecretMarkerField in value &&
    'justification' in value &&
    typeof value.justification === 'string'
  ) {
    return {
      $plaintextSecret: '[redacted]',
      justification: value.justification,
    };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretSafeFingerprintValue(item),
    ]),
  );
}
