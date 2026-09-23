import type {CharacterPluginExpectations} from '../characters/index.ts';
import {ownJsonRecordValue} from '../shared/json-boundary.ts';
import {
  validateRuntimePluginManifest,
  type RuntimePluginManifest,
} from '../plugins/index.ts';
import {
  createRuntimeConfigDiagnostic,
  resolveRuntimePluginConfigs,
  runtimeConfigDiagnosticIsReadinessFailure,
  validateProject02RuntimeConfig,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type RuntimeConfigDiagnostic,
} from '../runtime/config/index.ts';
import type {RuntimePluginActivationResult} from './activation.ts';

export type CharacterPackagePluginMaterializationPlan =
  | {
      readonly status: 'ready';
      readonly document: Project02RuntimeConfig;
    }
  | {
      readonly status: 'invalid';
      readonly diagnostics: readonly RuntimeConfigDiagnostic[];
    };

/** Global config is never read; nothing inherited leaks into the overlay. */
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
              const config = ownJsonRecordValue(expectations.config, pluginId);

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

  // A package is a shareable artifact: a credential inside one would be
  // distributed to every installer. Secrets stay the operator's to enter,
  // through their env files or their own config.
  const shippedSecrets = packagedSecretFieldPaths(
    validated.config,
    options.pluginManifests,
  );

  if (shippedSecrets.length > 0) {
    return invalidMaterialization(
      shippedSecrets.map(
        path =>
          `Character package must not carry a credential for ${path}; secret fields are the operator's to set.`,
      ),
    );
  }

  const resolved = resolveRuntimePluginConfigs({
    config: validated.config,
    pluginManifests: options.pluginManifests,
    validateInactivePluginConfigs: true,
    authoredScope: 'character',
  });
  // A readiness failure may still be met by the global layer or env.
  const blocking = resolved.diagnostics.filter(
    diagnostic =>
      diagnostic.severity === 'error' &&
      !runtimeConfigDiagnosticIsReadinessFailure(diagnostic),
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

function packagedSecretFieldPaths(
  config: Project02RuntimeConfig,
  manifests: readonly RuntimePluginManifest[],
): readonly string[] {
  const secretFieldsByPlugin = new Map(
    manifests.map(manifest => [
      manifest.id,
      manifest.config.fields
        .filter(field => field.secret)
        .map(field => field.name),
    ]),
  );

  return Object.entries(config.plugins ?? {}).flatMap(
    ([pluginId, pluginConfig]) =>
      (secretFieldsByPlugin.get(pluginId) ?? [])
        .filter(fieldName => pluginConfig.config?.[fieldName] !== undefined)
        .map(fieldName => `plugins.${pluginId}.config.${fieldName}`),
  );
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
          } plugin "${pluginId}", which is disabled. Enable it in the ` +
            "character's settings.",
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
