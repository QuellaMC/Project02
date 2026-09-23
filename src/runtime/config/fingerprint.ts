import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import type {Project02RuntimeConfig, RuntimeConfigValue} from './types.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';
import {createCanonicalJsonFingerprint} from '../../shared/canonical-json.ts';

/**
 * Fingerprints are shown to surfaces that must never see a secret -- the
 * model reads one back from `runtime.plugin.config` -- and an unsalted
 * hash of a mostly-known document lets a weak plaintext secret be guessed
 * offline. Every fingerprint therefore takes the manifests and replaces
 * authored values of secret-declared fields with a constant: presence is
 * hashed, the value never is.
 */
export function createRuntimeConfigFingerprint(
  value: RuntimeConfigValue | Project02RuntimeConfig | JsonBoundaryObject,
  pluginManifests: readonly RuntimePluginManifest[],
): string {
  return createCanonicalJsonFingerprint(
    redactAuthoredSecretFields(value, secretFieldsByPlugin(pluginManifests)),
  );
}

/**
 * A null overlay means an absent file, distinct from an empty document.
 * The layer envelope keeps this value off any single-file fingerprint.
 */
export function createLayeredRuntimeConfigFingerprint(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
  readonly characterId: string;
  readonly overlayConfig: RuntimeConfigValue | Project02RuntimeConfig | null;
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): string {
  const secretFields = secretFieldsByPlugin(options.pluginManifests);

  return createCanonicalJsonFingerprint({
    layers: {
      global: redactAuthoredSecretFields(options.globalConfig, secretFields),
      character:
        options.overlayConfig === null
          ? null
          : redactAuthoredSecretFields(options.overlayConfig, secretFields),
    },
    characterId: options.characterId,
  });
}

function secretFieldsByPlugin(
  pluginManifests: readonly RuntimePluginManifest[],
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    pluginManifests.map(manifest => [
      manifest.id,
      new Set(
        manifest.config.fields
          .filter(field => field.secret)
          .map(field => field.name),
      ),
    ]),
  );
}

/**
 * Walks only the well-formed `plugins.<id>.config.<field>` positions, so
 * an invalid authored document still fingerprints as its own bytes.
 */
function redactAuthoredSecretFields(
  document: unknown,
  secretFields: ReadonlyMap<string, ReadonlySet<string>>,
): unknown {
  if (!isPlainRecord(document) || !isPlainRecord(document['plugins'])) {
    return document;
  }

  return {
    ...document,
    plugins: Object.fromEntries(
      Object.entries(document['plugins']).map(([pluginId, pluginConfig]) => {
        const fields = secretFields.get(pluginId);

        if (
          fields === undefined ||
          fields.size === 0 ||
          !isPlainRecord(pluginConfig) ||
          !isPlainRecord(pluginConfig['config'])
        ) {
          return [pluginId, pluginConfig];
        }

        return [
          pluginId,
          {
            ...pluginConfig,
            config: Object.fromEntries(
              Object.entries(pluginConfig['config']).map(([name, value]) => [
                name,
                fields.has(name) ? {$secret: 'authored'} : value,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
