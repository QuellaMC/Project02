import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import type {LoadedProject02CharacterOverlayConfig} from './overlay.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigCharacterScope,
  RuntimeConfigValue,
} from './types.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';
import {createCanonicalJsonFingerprint} from '../../shared/canonical-json.ts';
import {project02RuntimeConfigFieldDefinitions} from './schema.ts';

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
 * An absent overlay hashes apart from an empty one, and the layer envelope
 * keeps this value off any single-file fingerprint. An invalid overlay hashes
 * as its authored document, not as one sentinel, so an edit to a broken
 * overlay stays visible; its wrapper stops a collision with a config.
 */
export function createLayeredRuntimeConfigFingerprint(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
  readonly characterId: string;
  readonly overlay: Pick<
    LoadedProject02CharacterOverlayConfig,
    'source' | 'config' | 'authoredDocument'
  >;
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): string {
  const secretFields = secretFieldsByPlugin(options.pluginManifests);
  const {source, config, authoredDocument} = options.overlay;

  return createCanonicalJsonFingerprint({
    layers: {
      global: redactAuthoredSecretFields(options.globalConfig, secretFields),
      character:
        source === 'none'
          ? null
          : config !== undefined
            ? redactAuthoredSecretFields(config, secretFields)
            : authoredDocument === undefined
              ? {$overlayUnreadable: true}
              : {
                  $overlayInvalid: redactAuthoredSecretFields(
                    authoredDocument,
                    secretFields,
                  ),
                },
    },
    characterId: options.characterId,
  });
}

/** The one composition, so any two sites comparing fingerprints agree. */
export function layeredRuntimeConfigFingerprintForScope(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  readonly overlay: LoadedProject02CharacterOverlayConfig | undefined;
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): string {
  return options.characterScope === undefined || options.overlay === undefined
    ? createRuntimeConfigFingerprint(
        options.globalConfig,
        options.pluginManifests,
      )
    : createLayeredRuntimeConfigFingerprint({
        globalConfig: options.globalConfig,
        characterId: options.characterScope.characterId,
        overlay: options.overlay,
        pluginManifests: options.pluginManifests,
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
 * Walks only the well-formed `project02.<field>` and
 * `plugins.<id>.config.<field>` positions, so an invalid authored document
 * still fingerprints as its own bytes.
 */
function redactAuthoredSecretFields(
  document: unknown,
  secretFields: ReadonlyMap<string, ReadonlySet<string>>,
): unknown {
  if (!isPlainRecord(document)) {
    return document;
  }

  const project02 = document['project02'];
  const plugins = document['plugins'];

  return {
    ...document,
    ...(isPlainRecord(project02)
      ? {
          project02: Object.fromEntries(
            Object.entries(project02).map(([name, value]) => [
              name,
              secretHostFieldNames.has(name) ? {$secret: 'authored'} : value,
            ]),
          ),
        }
      : {}),
    ...(isPlainRecord(plugins)
      ? {plugins: redactPluginSecrets(plugins, secretFields)}
      : {}),
  };
}

const secretHostFieldNames: ReadonlySet<string> = new Set(
  project02RuntimeConfigFieldDefinitions()
    .filter(field => field.secret)
    .map(field => field.name),
);

function redactPluginSecrets(
  plugins: Record<string, unknown>,
  secretFields: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(plugins).map(([pluginId, pluginConfig]) => {
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
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
