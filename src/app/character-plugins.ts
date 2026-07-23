/**
 * Character plugin policy at the composition root: one pure planner
 * turns package declarations into a validated overlay contribution,
 * and the existing enforcement judges the finished activation.
 */
import type {CharacterPluginExpectations} from '../characters/index.ts';
import {
  validateRuntimePluginManifest,
  type RuntimePluginManifest,
} from '../plugins/index.ts';
import {
  createRuntimeConfigDiagnostic,
  resolveProject02RuntimeConfig,
  validateProject02RuntimeConfig,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type RuntimeConfigDiagnostic,
} from '../runtime/config/index.ts';
import type {RuntimePluginActivationResult} from './activation.ts';

const packageConfigBlockingDiagnosticCodes = new Set([
  'runtime_config_unknown_plugin_config_field',
  'runtime_config_value_type_invalid',
  'runtime_config_secret_ref_for_non_secret',
  'runtime_config_plaintext_secret_rejected',
  'runtime_config_reserved_control_env_var',
  'runtime_config_secret_field_character_scoped',
  'runtime_config_secret_value_character_scoped',
]);

export type CharacterPackagePluginMaterializationPlan =
  | {
      readonly status: 'ready';
      readonly document: Project02RuntimeConfig;
    }
  | {
      readonly status: 'invalid';
      readonly diagnostics: readonly RuntimeConfigDiagnostic[];
    };

/**
 * Builds the package contribution only. It never reads global config,
 * so inherited values cannot accidentally be copied into a character
 * overlay. Unknown plugin ids remain in the document for later install.
 */
export function planCharacterPackagePluginMaterialization(options: {
  readonly expectations: CharacterPluginExpectations | undefined;
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): CharacterPackagePluginMaterializationPlan {
  const manifestDiagnostics = validateMaterializationManifests(
    options.pluginManifests,
  );

  if (manifestDiagnostics.length > 0) {
    return Object.freeze({
      status: 'invalid',
      diagnostics: manifestDiagnostics,
    });
  }

  const expectations: CharacterPluginExpectations =
    options.expectations ??
    Object.freeze({
      required: Object.freeze([]),
      recommended: Object.freeze([]),
      config: Object.freeze({}),
    });
  const enabledIds = [
    ...new Set([...expectations.required, ...expectations.recommended]),
  ].sort((left, right) => left.localeCompare(right));
  const allPluginIds = [
    ...new Set([...enabledIds, ...Object.keys(expectations.config)]),
  ].sort((left, right) => left.localeCompare(right));
  const candidate = {
    version: runtimeConfigVersion,
    ...(allPluginIds.length === 0
      ? {}
      : {
          plugins: Object.fromEntries(
            allPluginIds.map(pluginId => {
              const config = expectations.config[pluginId];

              return [
                pluginId,
                {
                  ...(enabledIds.includes(pluginId) ? {enabled: true} : {}),
                  ...(config === undefined ? {} : {config}),
                },
              ];
            }),
          ),
        }),
  };
  const validated = validateProject02RuntimeConfig(candidate);
  const documentError = validated.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (validated.config === undefined || documentError !== undefined) {
    return invalidMaterialization(
      validated.diagnostics
        .filter(diagnostic => diagnostic.severity === 'error')
        .map(diagnostic => diagnostic.message),
    );
  }

  const resolved = resolveProject02RuntimeConfig({
    loadedConfig: {
      source: 'none',
      config: validated.config,
      diagnostics: Object.freeze([]),
    },
    pluginManifests: options.pluginManifests,
    validateInactivePluginConfigs: true,
    authoredScope: 'character',
    env: {},
  });
  const blocking = resolved.diagnostics.filter(
    diagnostic =>
      diagnostic.severity === 'error' &&
      packageConfigBlockingDiagnosticCodes.has(diagnostic.code),
  );

  if (blocking.length > 0) {
    return invalidMaterialization([
      ...new Set(blocking.map(diagnostic => diagnostic.message)),
    ]);
  }

  return Object.freeze({
    status: 'ready',
    document: validated.config,
  });
}

function validateMaterializationManifests(
  manifests: readonly RuntimePluginManifest[],
): readonly RuntimeConfigDiagnostic[] {
  const diagnostics: RuntimeConfigDiagnostic[] = [];

  for (const manifest of [...manifests].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const validated = validateRuntimePluginManifest(manifest);

    if (validated.status === 'accepted') {
      continue;
    }

    diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'character_package_plugin_manifest_invalid',
        `Cannot materialize character plugin config because installed ` +
          `plugin "${manifest.id}" has invalid manifest policy: ` +
          validated.details,
        `plugins.${manifest.id}`,
        {pluginId: manifest.id},
      ),
    );
  }

  return Object.freeze(diagnostics);
}

function invalidMaterialization(
  messages: readonly string[],
): CharacterPackagePluginMaterializationPlan {
  return Object.freeze({
    status: 'invalid',
    diagnostics: Object.freeze(
      messages.map(message =>
        createRuntimeConfigDiagnostic(
          'error',
          'character_package_plugin_config_invalid',
          `Character package plugin config is invalid: ${message}`,
        ),
      ),
    ),
  });
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
  /** Selected home, so the recovery command edits the right store. */
  readonly storeRoot?: string;
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
            `runtime-config ${
              options.storeRoot === undefined
                ? ''
                : `--store ${options.storeRoot} `
            }--character ${options.characterId} plugin ` +
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
