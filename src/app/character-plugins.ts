/**
 * Character plugin expectations at the composition root: turns a
 * character package's plugins block into the first-selection overlay
 * seed, and judges the finished plugin activation against the block.
 * Required and recommended ids are never injected into the default
 * enablement set — they act through the materialized explicit
 * enabled:true rung, so an operator's explicit false still wins the
 * ladder and then trips enforcement here instead of being silently
 * overridden.
 */
import type {CharacterPluginExpectations} from '../characters/index.ts';
import type {RuntimePluginManifest} from '../plugins/index.ts';
import {
  createRuntimeConfigDiagnostic,
  resolveProject02RuntimeConfig,
  validateProject02RuntimeConfig,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type RuntimeConfigDiagnostic,
} from '../runtime/config/index.ts';
import type {RuntimePluginActivationResult} from './activation.ts';

// Manifest-shape violations a seed must not persist: an unknown field
// or a value the manifest rejects poisons the overlay until it is
// hand-edited (the file is never re-materialized). Secret and
// required-field resolution stay out — they depend on env and the
// global layer, not on the package's defaults being well-formed.
const seedBlockingDiagnosticCodes = new Set([
  'runtime_config_unknown_plugin_config_field',
  'runtime_config_value_type_invalid',
  'runtime_config_secret_ref_for_non_secret',
  'runtime_config_plaintext_secret_rejected',
]);

/**
 * Judges a first-selection seed against the installed manifests before
 * anything is written; ids without an installed manifest stay verbatim
 * and are judged later by enforcement instead.
 */
export function validateCharacterOverlaySeedAgainstManifests(options: {
  readonly document: Project02RuntimeConfig;
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): readonly string[] {
  const resolved = resolveProject02RuntimeConfig({
    loadedConfig: {
      source: 'none',
      config: options.document,
      diagnostics: Object.freeze([]),
    },
    pluginManifests: options.pluginManifests,
    validateInactivePluginConfigs: true,
    env: {},
  });

  return Object.freeze(
    resolved.diagnostics
      .filter(
        diagnostic =>
          diagnostic.severity === 'error' &&
          seedBlockingDiagnosticCodes.has(diagnostic.code),
      )
      .map(
        diagnostic =>
          `Character plugin defaults are rejected by the installed ` +
          `plugin manifests: ${diagnostic.message}`,
      ),
  );
}

export type CharacterOverlaySeed =
  | {readonly status: 'none'}
  | {readonly status: 'seed'; readonly document: Project02RuntimeConfig}
  | {readonly status: 'invalid'; readonly messages: readonly string[]};

/**
 * The overlay document a first selection materializes: enabled:true for
 * every required and recommended plugin, plus the package's per-plugin
 * config defaults — verbatim, even for plugin ids that are not
 * installed yet, so the declared intent survives until they are. A
 * block whose config defaults do not form a valid config document is
 * reported instead of seeded.
 */
export function characterOverlaySeedDocument(
  expectations: CharacterPluginExpectations | undefined,
): CharacterOverlaySeed {
  if (expectations === undefined) {
    return Object.freeze({status: 'none'});
  }

  const enabledIds = [
    ...new Set([...expectations.required, ...expectations.recommended]),
  ].sort((a, b) => a.localeCompare(b));
  const configOnlyIds = Object.keys(expectations.config)
    .filter(pluginId => !enabledIds.includes(pluginId))
    .sort((a, b) => a.localeCompare(b));

  if (enabledIds.length === 0 && configOnlyIds.length === 0) {
    return Object.freeze({status: 'none'});
  }

  const pluginEntries: ReadonlyArray<
    readonly [string, Readonly<Record<string, unknown>>]
  > = [
    ...enabledIds.map(
      (pluginId): readonly [string, Readonly<Record<string, unknown>>] => [
        pluginId,
        {
          enabled: true,
          ...(expectations.config[pluginId] === undefined
            ? {}
            : {config: expectations.config[pluginId]}),
        },
      ],
    ),
    ...configOnlyIds.map(
      (pluginId): readonly [string, Readonly<Record<string, unknown>>] => [
        pluginId,
        {config: expectations.config[pluginId]},
      ],
    ),
  ];
  const candidate = {
    version: runtimeConfigVersion,
    plugins: Object.fromEntries(pluginEntries),
  };
  const validated = validateProject02RuntimeConfig(candidate);

  if (validated.config === undefined) {
    return Object.freeze({
      status: 'invalid',
      messages: Object.freeze(
        validated.diagnostics
          .filter(diagnostic => diagnostic.severity === 'error')
          .map(
            diagnostic =>
              `Character plugin defaults do not form a valid config ` +
              `document: ${diagnostic.message}`,
          ),
      ),
    });
  }

  return Object.freeze({status: 'seed', document: validated.config});
}

/**
 * Judges the finished activation against the character's expectations.
 * Required plugins that are missing or resolved-disabled are errors
 * that block startup; recommended ones only warn. Every diagnostic
 * names the plugin, the character, and the recovery.
 */
export function enforceCharacterPluginExpectations(options: {
  readonly expectations: CharacterPluginExpectations | undefined;
  readonly characterId: string;
  readonly activation: RuntimePluginActivationResult;
  readonly installedPluginIds: ReadonlySet<string>;
}): readonly RuntimeConfigDiagnostic[] {
  if (options.expectations === undefined) {
    return Object.freeze([]);
  }

  const enabledIds = new Set(options.activation.enabledPluginIds);
  const diagnostics: RuntimeConfigDiagnostic[] = [];
  const judge = (pluginId: string, level: 'required' | 'recommended') => {
    const severity = level === 'required' ? 'error' : 'warning';

    if (!options.installedPluginIds.has(pluginId)) {
      diagnostics.push(
        createRuntimeConfigDiagnostic(
          severity,
          level === 'required'
            ? 'character_required_plugin_missing'
            : 'character_recommended_plugin_missing',
          `Character "${options.characterId}" ${
            level === 'required' ? 'requires' : 'recommends'
          } plugin "${pluginId}", which is not installed. Install the ` +
            `plugin package under the home plugins directory` +
            `${level === 'required' ? ' or remove it from the character package' : ''}.`,
          `plugins.${pluginId}`,
          {pluginId},
        ),
      );
      return;
    }

    if (!enabledIds.has(pluginId)) {
      diagnostics.push(
        createRuntimeConfigDiagnostic(
          severity,
          level === 'required'
            ? 'character_required_plugin_disabled'
            : 'character_recommended_plugin_disabled',
          `Character "${options.characterId}" ${
            level === 'required' ? 'requires' : 'recommends'
          } plugin "${pluginId}", which is disabled. Enable it with: ` +
            `runtime-config --character ${options.characterId} plugin ` +
            `enable ${pluginId}`,
          `plugins.${pluginId}.enabled`,
          {pluginId},
        ),
      );
    }
  };

  for (const pluginId of options.expectations.required) {
    judge(pluginId, 'required');
  }
  for (const pluginId of options.expectations.recommended) {
    if (!options.expectations.required.includes(pluginId)) {
      judge(pluginId, 'recommended');
    }
  }

  return Object.freeze(diagnostics);
}
