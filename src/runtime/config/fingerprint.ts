import type {Project02RuntimeConfig, RuntimeConfigValue} from './types.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';
import {createCanonicalJsonFingerprint} from '../../shared/canonical-json.ts';
import {secretEnvMarkerField} from '../../shared/secret-marker.ts';

export function createRuntimeConfigFingerprint(
  value: RuntimeConfigValue | Project02RuntimeConfig | JsonBoundaryObject,
): string {
  return createCanonicalJsonFingerprint(secretSafeFingerprintValue(value));
}

/**
 * A null overlay means an absent file, distinct from an empty document.
 * The layer envelope keeps this value off any single-file fingerprint.
 */
export function createLayeredRuntimeConfigFingerprint(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
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

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretSafeFingerprintValue(item),
    ]),
  );
}
