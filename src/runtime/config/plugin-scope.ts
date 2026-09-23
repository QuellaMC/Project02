import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
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
            `Plugin "${options.manifest.id}" belongs to a character; turn it ` +
            "on or off in that character's settings, not the home's.",
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

  if (
    options.authoredScope === 'global' &&
    options.manifest.config.scope === 'character_only'
  ) {
    return Object.freeze({
      fieldName: field.name,
      code: 'runtime_config_character_only_plugin_field_globally',
      path,
      message:
        `Setting "${field.name}" of plugin "${options.manifest.id}" belongs ` +
        "to a character; set it in that character's settings, not the home's.",
    });
  }

  return undefined;
}

/** Takes one raw document; a merged one hides which layer authored a value. */
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

  return Object.freeze(diagnostics);
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
