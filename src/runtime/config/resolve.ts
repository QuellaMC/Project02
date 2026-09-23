import type {
  RuntimePluginConfigField,
  RuntimePluginManifest,
} from '../../plugins/api/index.ts';
import {createRuntimeConfigFingerprint} from './fingerprint.ts';
import type {ResolvedProject02RuntimeLocation} from './location.ts';
import {redactResolvedRuntimeConfigField} from './redact.ts';
import {
  defaultProject02ContextWindowTokens,
  defaultProject02UserDisplayName,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RedactedPluginRuntimeConfig,
  type ResolvedPluginRuntimeConfig,
  type ResolvedProject02RuntimeConfig,
  type ResolvedRuntimeConfigField,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticPluginMetadata,
  type RuntimeConfigFieldScope,
  type RuntimeConfigSource,
  type RuntimeConfigValue,
} from './types.ts';
import {
  createJsonBoundarySnapshot,
  ownJsonRecordValue,
} from '../../shared/json-boundary.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {runtimeConfigValueMatchesField} from './schema.ts';
import {runtimePluginScopeDiagnostics} from './plugin-scope.ts';

export type ResolveProject02RuntimeConfigOptions = {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly validateInactivePluginConfigs?: boolean;
  readonly defaultEnabledPluginIds?: ReadonlySet<string>;
  readonly authoredScope?: RuntimeConfigFieldScope;
  /** Set after per-layer validation; the merged document loses origins. */
  readonly skipPluginScopeValidation?: boolean;
};

type ResolveEffectiveProject02RuntimeConfigOptions = Omit<
  ResolveProject02RuntimeConfigOptions,
  'loadedConfig'
> & {
  readonly config: Project02RuntimeConfig | undefined;
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export type ResolveRuntimePluginConfigsOptions = {
  readonly config: Project02RuntimeConfig | undefined;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly validateInactivePluginConfigs?: boolean;
  readonly defaultEnabledPluginIds?: ReadonlySet<string>;
  readonly authoredScope?: RuntimeConfigFieldScope;
  readonly skipPluginScopeValidation?: boolean;
};

export type ResolvedRuntimePluginConfigs = Readonly<{
  pluginConfigs: Readonly<Record<string, ResolvedPluginRuntimeConfig>>;
  redactedPluginConfigs: Readonly<Record<string, RedactedPluginRuntimeConfig>>;
  diagnostics: readonly RuntimeConfigDiagnostic[];
}>;

/** Needs no filesystem location, so package planning can call it too. */
export function resolveRuntimePluginConfigs(
  options: ResolveRuntimePluginConfigsOptions,
): ResolvedRuntimePluginConfigs {
  const diagnostics: RuntimeConfigDiagnostic[] =
    options.skipPluginScopeValidation === true
      ? []
      : [
          ...runtimePluginScopeDiagnostics({
            config: options.config,
            manifests: options.pluginManifests,
            authoredScope: options.authoredScope ?? 'global',
          }),
        ];
  const pluginConfigs: Record<string, ResolvedPluginRuntimeConfig> = {};
  const redactedPluginConfigs: Record<string, RedactedPluginRuntimeConfig> = {};

  for (const manifest of options.pluginManifests) {
    const resolved = resolvePluginConfig({
      config: options.config,
      manifest,
      validateInactivePluginConfigs:
        options.validateInactivePluginConfigs === true,
      defaultEnabled:
        options.defaultEnabledPluginIds?.has(manifest.id) ??
        manifest.activation.defaultEnabled,
      diagnostics,
    });

    pluginConfigs[manifest.id] = resolved;
    redactedPluginConfigs[manifest.id] = Object.freeze(
      Object.fromEntries(
        Object.entries(resolved).map(([name, field]) => [
          name,
          redactResolvedRuntimeConfigField(field),
        ]),
      ),
    );
  }

  return Object.freeze({
    pluginConfigs: Object.freeze(pluginConfigs),
    redactedPluginConfigs: Object.freeze(redactedPluginConfigs),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function resolveProject02RuntimeConfig(
  options: ResolveProject02RuntimeConfigOptions,
): ResolvedProject02RuntimeConfig {
  const {loadedConfig, ...effectiveOptions} = options;

  return resolveEffectiveProject02RuntimeConfig({
    ...effectiveOptions,
    config: loadedConfig.config,
    source: loadedConfig.source,
    ...(loadedConfig.path === undefined ? {} : {path: loadedConfig.path}),
    diagnostics: loadedConfig.diagnostics,
  });
}

/** Mutation code must not use this; it needs a real loader-owned snapshot. */
export function resolveEffectiveProject02RuntimeConfig(
  options: ResolveEffectiveProject02RuntimeConfigOptions,
): ResolvedProject02RuntimeConfig {
  const config = options.config;
  const storeRoot = options.runtimeLocation.homeRoot;
  const pluginResolution = resolveRuntimePluginConfigs({
    config,
    pluginManifests: options.pluginManifests ?? [],
    validateInactivePluginConfigs:
      options.validateInactivePluginConfigs === true,
    ...(options.defaultEnabledPluginIds === undefined
      ? {}
      : {defaultEnabledPluginIds: options.defaultEnabledPluginIds}),
    authoredScope: options.authoredScope ?? 'global',
    skipPluginScopeValidation: options.skipPluginScopeValidation === true,
  });
  const diagnostics = Object.freeze([
    ...options.diagnostics,
    ...pluginResolution.diagnostics,
  ]);
  const project02 = resolvedProject02HostSection({
    config,
    storeRoot,
    // Already trimmed by the character-scope helper.
    character: options.runtimeLocation.characterScope.characterId,
  });

  return Object.freeze({
    source: options.source,
    ...(options.path === undefined ? {} : {path: options.path}),
    project02,
    pluginConfigs: pluginResolution.pluginConfigs,
    redactedPluginConfigs: pluginResolution.redactedPluginConfigs,
    diagnostics,
    effectiveConfigFingerprint: createRuntimeConfigFingerprint(
      effectiveFingerprintInput({
        config,
        storeRoot,
        character: project02.character,
        enabled: project02.enabled,
        userDisplayName: project02.userDisplayName,
        redactedPluginConfigs: pluginResolution.redactedPluginConfigs,
      }),
      options.pluginManifests ?? [],
    ),
  } satisfies ResolvedProject02RuntimeConfig);
}

function resolvedProject02HostSection(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly storeRoot: string;
  readonly character: string;
}): ResolvedProject02RuntimeConfig['project02'] {
  const authored = options.config?.project02;
  const defaultMemoryProvider = authored?.defaultMemoryProvider;

  return Object.freeze({
    storeRoot: options.storeRoot,
    character: options.character,
    enabled: authored?.enabled ?? true,
    // Trimmed here: the strict speaker constructor would crash on padding.
    userDisplayName: (
      authored?.userDisplayName ?? defaultProject02UserDisplayName
    ).trim(),
    ...(defaultMemoryProvider === undefined ? {} : {defaultMemoryProvider}),
    roleModelProvider: authored?.roleModelProvider ?? 'local',
    contextWindowTokens:
      authored?.contextWindowTokens ?? defaultProject02ContextWindowTokens,
  });
}

export function diagnosticsHaveErrors(
  diagnostics: readonly RuntimeConfigDiagnostic[],
): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === 'error');
}

export function runtimeConfigDiagnosticMatchesPlugin(options: {
  readonly diagnostic: RuntimeConfigDiagnostic;
  readonly pluginId: string;
}): boolean {
  return (
    options.diagnostic.scope === 'plugin' &&
    options.diagnostic.pluginId === options.pluginId
  );
}

function resolvePluginConfig(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
  readonly validateInactivePluginConfigs: boolean;
  readonly defaultEnabled: boolean;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): ResolvedPluginRuntimeConfig {
  const configuredPlugin = ownJsonRecordValue(
    options.config?.plugins,
    options.manifest.id,
  );
  const validateReadiness = shouldValidatePluginConfig({
    config: options.config,
    manifest: options.manifest,
    defaultEnabled: options.defaultEnabled,
  });
  const validateConfig =
    options.validateInactivePluginConfigs || validateReadiness;

  if (validateConfig) {
    pushUnknownPluginConfigFieldDiagnostics({
      manifest: options.manifest,
      rawConfig: configuredPlugin?.config,
      diagnostics: options.diagnostics,
    });
  }

  return Object.freeze(
    Object.fromEntries(
      options.manifest.config.fields.map(field => [
        field.name,
        resolvePluginConfigField({
          ...options,
          validateConfig,
          validateReadiness,
          field,
          rawValue: ownJsonRecordValue(configuredPlugin?.config, field.name),
        }),
      ]),
    ),
  );
}

function resolvePluginConfigField(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
  readonly field: RuntimePluginConfigField;
  readonly rawValue: RuntimeConfigValue | undefined;
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly validateConfig: boolean;
  readonly validateReadiness: boolean;
}): ResolvedRuntimeConfigField {
  const path = `plugins.${options.manifest.id}.config.${options.field.name}`;

  if (options.field.secret) {
    return resolveSecretField({...options, path});
  }

  if (options.rawValue === undefined) {
    if (options.field.required && options.validateReadiness) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_required_value_missing',
          `Required config field "${options.field.name}" is missing for plugin "${options.manifest.id}".`,
          path,
          pluginConfigDiagnosticMetadata(options),
        ),
      );
    }

    return fieldResult({
      field: options.field,
      source: 'missing',
      resolved: !options.field.required,
    });
  }

  if (!runtimeConfigValueMatchesField(options.rawValue, options.field)) {
    if (options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_value_type_invalid',
          `Config field "${options.field.name}" does not match its declared metadata.`,
          path,
          pluginConfigDiagnosticMetadata(options),
        ),
      );
    }
    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: false,
      value: options.rawValue,
    });
  }

  return fieldResult({
    field: options.field,
    source: 'config',
    resolved: true,
    value: options.rawValue,
  });
}

/**
 * A secret is a plain string in whichever layer authored it. The plugin
 * reads the resolved value; every other reader is handed it redacted.
 */
function resolveSecretField(options: {
  readonly manifest: RuntimePluginManifest;
  readonly field: RuntimePluginConfigField;
  readonly rawValue: RuntimeConfigValue | undefined;
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly path: string;
  readonly validateConfig: boolean;
  readonly validateReadiness: boolean;
}): ResolvedRuntimeConfigField {
  // Silently ignoring what the operator wrote would leave a landmine in
  // the config, so a value of another shape is an error.
  if (options.rawValue !== undefined && typeof options.rawValue !== 'string') {
    if (options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_secret_value_invalid',
          `Secret config field "${options.field.name}" must be a string.`,
          options.path,
          pluginConfigDiagnosticMetadata(options),
        ),
      );
    }

    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: false,
    });
  }

  if (options.rawValue !== undefined && options.rawValue.trim().length > 0) {
    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: true,
      value: options.rawValue,
    });
  }

  if (options.field.required && options.validateReadiness) {
    options.diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_required_secret_missing',
        `Required secret "${options.field.name}" is missing for plugin "${options.manifest.id}".`,
        options.path,
        pluginConfigDiagnosticMetadata(options),
      ),
    );
  }

  return fieldResult({
    field: options.field,
    source: 'missing',
    resolved: !options.field.required,
  });
}

function shouldValidatePluginConfig(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
  readonly defaultEnabled: boolean;
}): boolean {
  const configured = ownJsonRecordValue(
    options.config?.plugins,
    options.manifest.id,
  );

  if (configured?.enabled === false) {
    return false;
  }

  if (
    !pluginCanRequireConfigValidation({
      config: options.config,
      manifest: options.manifest,
    })
  ) {
    return false;
  }

  if (configured?.enabled === true) {
    return true;
  }

  if (!options.defaultEnabled) {
    return false;
  }

  return true;
}

function pluginCanRequireConfigValidation(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
}): boolean {
  if (
    options.manifest.kind !== 'memory_provider' ||
    options.config?.project02?.defaultMemoryProvider === undefined
  ) {
    return true;
  }

  return isSelectedDefaultMemoryProvider(options);
}

function isSelectedDefaultMemoryProvider(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
}): boolean {
  return (
    options.manifest.kind === 'memory_provider' &&
    options.config?.project02?.defaultMemoryProvider === options.manifest.id
  );
}

function pushUnknownPluginConfigFieldDiagnostics(options: {
  readonly manifest: RuntimePluginManifest;
  readonly rawConfig: Readonly<Record<string, RuntimeConfigValue>> | undefined;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): void {
  if (options.rawConfig === undefined) {
    return;
  }

  const declaredFields = new Set(
    options.manifest.config.fields.map(field => field.name),
  );

  for (const fieldName of Object.keys(options.rawConfig).sort((a, b) =>
    a.localeCompare(b),
  )) {
    if (declaredFields.has(fieldName)) {
      continue;
    }

    options.diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_unknown_plugin_config_field',
        `Unknown config field "${fieldName}" for plugin "${options.manifest.id}".`,
        `plugins.${options.manifest.id}.config.${fieldName}`,
        {
          pluginId: options.manifest.id,
          pluginConfigField: fieldName,
        },
      ),
    );
  }
}

function pluginConfigDiagnosticMetadata(options: {
  readonly manifest: RuntimePluginManifest;
  readonly field: RuntimePluginConfigField;
}): RuntimeConfigDiagnosticPluginMetadata {
  return {
    pluginId: options.manifest.id,
    pluginConfigField: options.field.name,
  };
}

function fieldResult(options: {
  readonly field: RuntimePluginConfigField;
  readonly source: ResolvedRuntimeConfigField['source'];
  readonly resolved: boolean;
  readonly value?: RuntimeConfigValue;
}): ResolvedRuntimeConfigField {
  return Object.freeze({
    name: options.field.name,
    secret: options.field.secret,
    source: options.source,
    resolved: options.resolved,
    ...(options.value === undefined
      ? {}
      : {
          value: createJsonBoundarySnapshot(options.value, {
            field: `Resolved runtime config field ${options.field.name}`,
          }),
        }),
  } satisfies ResolvedRuntimeConfigField);
}

function effectiveFingerprintInput(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly storeRoot: string;
  readonly character: string;
  readonly enabled: boolean;
  readonly userDisplayName: string;
  readonly redactedPluginConfigs: Readonly<
    Record<string, RedactedPluginRuntimeConfig>
  >;
}): RuntimeConfigValue {
  const pluginActivation = pluginActivationFingerprintInput(options.config);

  return Object.freeze({
    version: options.config?.version ?? 'none',
    project02: Object.freeze({
      storeRoot: options.storeRoot,
      character: options.character,
      enabled: options.enabled,
      userDisplayName: options.userDisplayName,
      defaultMemoryProvider:
        options.config?.project02?.defaultMemoryProvider ?? null,
      roleModelProvider:
        options.config?.project02?.roleModelProvider ?? 'local',
      contextWindowTokens:
        options.config?.project02?.contextWindowTokens ??
        defaultProject02ContextWindowTokens,
    }),
    plugins: options.redactedPluginConfigs,
    ...(pluginActivation === undefined ? {} : {pluginActivation}),
  });
}

function pluginActivationFingerprintInput(
  config: Project02RuntimeConfig | undefined,
): RuntimeConfigValue | undefined {
  const plugins = config?.plugins;

  if (plugins === undefined) {
    return undefined;
  }

  const activation: Record<string, RuntimeConfigValue> = {};

  for (const [pluginId, pluginConfig] of Object.entries(plugins)) {
    if (pluginConfig.enabled !== undefined) {
      activation[pluginId] = Object.freeze({
        enabled: pluginConfig.enabled,
      });
    }
  }

  return Object.keys(activation).length === 0
    ? undefined
    : Object.freeze(activation);
}
