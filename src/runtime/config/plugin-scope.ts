import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {nestedSecretMarkerPath} from '../../shared/secret-marker.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigDiagnostic,
  RuntimeConfigFieldScope,
} from './types.ts';

export type RuntimePluginScopeOperation =
  | {readonly kind: 'activation'}
  | {readonly kind: 'field'; readonly fieldName: string};

export type RuntimePluginScopeViolation = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fieldName?: string;
};

/**
 * Pure policy predicate shared by raw-document diagnostics and every
 * mutation surface.
 */
export function runtimePluginScopeViolation(options: {
  readonly manifest: RuntimePluginManifest;
  readonly authoredScope: RuntimeConfigFieldScope;
  readonly operation: RuntimePluginScopeOperation;
}): RuntimePluginScopeViolation | undefined {
  if (options.operation.kind === 'activation') {
    return options.authoredScope === 'global' &&
      options.manifest.config.scope === 'character_only'
      ? Object.freeze({
          code: 'runtime_config_character_only_plugin_enabled_globally',
          path: `plugins.${options.manifest.id}.enabled`,
          message:
            `Plugin "${options.manifest.id}" is character-only; enable or disable ` +
            'it in a character config or character package, not the global config.',
        })
      : undefined;
  }

  const fieldName = options.operation.fieldName;
  const field = options.manifest.config.fields.find(
    candidate => candidate.name === fieldName,
  );

  if (field === undefined) {
    return undefined;
  }

  const path = `plugins.${options.manifest.id}.config.${field.name}`;

  if (options.authoredScope === 'character' && field.secret) {
    return Object.freeze({
      fieldName: field.name,
      code: 'runtime_config_secret_field_character_scoped',
      path,
      message:
        `Secret config field "${field.name}" for plugin ` +
        `"${options.manifest.id}" is global-only; keep its env reference in ` +
        'the global config.',
    });
  }

  if (
    options.authoredScope === 'global' &&
    options.manifest.config.scope === 'character_only' &&
    !field.secret
  ) {
    return Object.freeze({
      fieldName: field.name,
      code: 'runtime_config_character_only_plugin_field_globally',
      path,
      message:
        `Non-secret config field "${field.name}" for character-only ` +
        `plugin "${options.manifest.id}" belongs in a character config or ` +
        'character package, not the global config.',
    });
  }

  return undefined;
}

/**
 * The one policy judge for where plugin enablement and fields may be
 * authored. It operates on one raw document at a time so a layered
 * merge cannot hide whether a value came from the home or character.
 */
export function runtimePluginScopeDiagnostics(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifests: readonly RuntimePluginManifest[];
  readonly authoredScope: RuntimeConfigFieldScope;
}): readonly RuntimeConfigDiagnostic[] {
  const diagnostics = [...options.manifests]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap(manifest =>
      pluginScopeDiagnosticsForManifest({
        config: options.config,
        manifest,
        authoredScope: options.authoredScope,
      }),
    );

  return Object.freeze(
    options.authoredScope === 'global'
      ? diagnostics
      : [
          ...diagnostics,
          ...characterSecretValueDiagnostics(options.config, diagnostics),
        ],
  );
}

function pluginScopeDiagnosticsForManifest(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
  readonly authoredScope: RuntimeConfigFieldScope;
}): readonly RuntimeConfigDiagnostic[] {
  const plugin =
    options.config?.plugins !== undefined &&
    Object.hasOwn(options.config.plugins, options.manifest.id)
      ? options.config.plugins[options.manifest.id]
      : undefined;

  if (plugin === undefined) {
    return [];
  }

  const diagnostics: RuntimeConfigDiagnostic[] = [];
  const activationViolation = runtimePluginScopeViolation({
    manifest: options.manifest,
    authoredScope: options.authoredScope,
    operation: {kind: 'activation'},
  });

  if (plugin.enabled !== undefined && activationViolation !== undefined) {
    diagnostics.push(
      pluginScopeDiagnostic({
        manifest: options.manifest,
        code: activationViolation.code,
        path: activationViolation.path,
        message: activationViolation.message,
      }),
    );
  }

  for (const field of options.manifest.config.fields) {
    if (
      plugin.config === undefined ||
      !Object.hasOwn(plugin.config, field.name)
    ) {
      continue;
    }

    const violation = runtimePluginScopeViolation({
      manifest: options.manifest,
      authoredScope: options.authoredScope,
      operation: {kind: 'field', fieldName: field.name},
    });

    if (violation !== undefined) {
      diagnostics.push(
        pluginScopeDiagnostic({
          manifest: options.manifest,
          fieldName: field.name,
          code: violation.code,
          path: violation.path,
          message: violation.message,
        }),
      );
    }
  }

  return diagnostics;
}

function characterSecretValueDiagnostics(
  config: Project02RuntimeConfig | undefined,
  existingDiagnostics: readonly RuntimeConfigDiagnostic[],
): readonly RuntimeConfigDiagnostic[] {
  const knownSecretFieldPaths = new Set(
    existingDiagnostics
      .filter(
        diagnostic =>
          diagnostic.code === 'runtime_config_secret_field_character_scoped',
      )
      .map(diagnostic => diagnostic.path),
  );
  const diagnostics: RuntimeConfigDiagnostic[] = [];

  for (const [pluginId, plugin] of Object.entries(config?.plugins ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    for (const [fieldName, value] of Object.entries(plugin.config ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const fieldPath = `plugins.${pluginId}.config.${fieldName}`;
      const secretPath = nestedSecretMarkerPath(value, fieldPath);

      if (secretPath !== undefined && !knownSecretFieldPaths.has(fieldPath)) {
        diagnostics.push(
          createRuntimeConfigDiagnostic(
            'error',
            'runtime_config_secret_value_character_scoped',
            'Character plugin config must not contain secret references or plaintext-secret markers; keep secrets in the global config.',
            secretPath,
            {pluginId, pluginConfigField: fieldName},
          ),
        );
      }
    }
  }

  return diagnostics;
}

function pluginScopeDiagnostic(options: {
  readonly manifest: RuntimePluginManifest;
  readonly fieldName?: string;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}): RuntimeConfigDiagnostic {
  return createRuntimeConfigDiagnostic(
    'error',
    options.code,
    options.message,
    options.path,
    {
      pluginId: options.manifest.id,
      ...(options.fieldName === undefined
        ? {}
        : {pluginConfigField: options.fieldName}),
    },
  );
}
