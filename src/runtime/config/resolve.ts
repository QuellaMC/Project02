import {createLocalRuntimeStorageLayout} from '../storage/layout-contract.ts';
import type {
  RuntimePluginConfigField,
  RuntimePluginManifest,
} from '../../plugins/api/index.ts';
import {createRuntimeConfigFingerprint} from './fingerprint.ts';
import {storeRootForSelectedDefaultConfigPath} from './mutate.ts';
import {redactResolvedRuntimeConfigField} from './redact.ts';
import {
  defaultProject02CharacterId,
  defaultProject02UserDisplayName,
  isRuntimeControlEnvVarName,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RedactedPluginRuntimeConfig,
  type ResolvedPluginRuntimeConfig,
  type ResolvedProject02RuntimeConfig,
  type ResolvedRuntimeConfigField,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticPluginMetadata,
  type RuntimeConfigSecretRef,
  type RuntimeConfigValue,
} from './types.ts';
import {
  createJsonBoundarySnapshot,
  ownJsonRecordValue,
} from '../../shared/json-boundary.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {runtimeConfigValueMatchesField} from './schema.ts';

export type ResolveProject02RuntimeConfigOptions = {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly env?: NodeJS.ProcessEnv;
  readonly allowPlaintextSecrets?: boolean;
  readonly validateInactivePluginConfigs?: boolean;
  readonly defaultEnabledPluginIds?: ReadonlySet<string>;
};

export function resolveProject02RuntimeConfig(
  options: ResolveProject02RuntimeConfigOptions,
): ResolvedProject02RuntimeConfig {
  const env = options.env ?? process.env;
  const config = options.loadedConfig.config;
  const storeRoot = resolveProject02RuntimeStoreRoot(options);
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...options.loadedConfig.diagnostics,
  ];
  const pluginConfigs: Record<string, ResolvedPluginRuntimeConfig> = {};
  const redactedPluginConfigs: Record<string, RedactedPluginRuntimeConfig> = {};
  const defaultMemoryProvider = config?.project02?.defaultMemoryProvider;
  const roleModelProvider = config?.project02?.roleModelProvider ?? 'local';
  const character = config?.project02?.character ?? defaultProject02CharacterId;
  // Trimmed at the resolve seam so an authored value with stray padding
  // never reaches the strict speaker constructor as a startup crash.
  const userDisplayName = (
    config?.project02?.userDisplayName ?? defaultProject02UserDisplayName
  ).trim();
  const project02 = Object.freeze({
    storeRoot,
    character,
    userDisplayName,
    ...(defaultMemoryProvider === undefined ? {} : {defaultMemoryProvider}),
    roleModelProvider,
  });

  for (const manifest of options.pluginManifests ?? []) {
    const resolved = resolvePluginConfig({
      config,
      manifest,
      env,
      allowPlaintextSecrets: options.allowPlaintextSecrets === true,
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
    source: options.loadedConfig.source,
    ...(options.loadedConfig.path === undefined
      ? {}
      : {path: options.loadedConfig.path}),
    project02,
    pluginConfigs: Object.freeze(pluginConfigs),
    redactedPluginConfigs: Object.freeze(redactedPluginConfigs),
    diagnostics: Object.freeze(diagnostics),
    effectiveConfigFingerprint: createRuntimeConfigFingerprint(
      effectiveFingerprintInput({
        config,
        storeRoot,
        redactedPluginConfigs,
      }),
    ),
  } satisfies ResolvedProject02RuntimeConfig);
}

export function resolveProject02RuntimeStoreRoot(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
}): string {
  const configuredStoreRoot =
    options.loadedConfig.config?.project02?.storeRoot ??
    options.storeRoot ??
    storeRootForLoadedDefaultConfigPath(options.loadedConfig);

  return createLocalRuntimeStorageLayout(
    configuredStoreRoot === undefined ? {} : {storeRoot: configuredStoreRoot},
  ).storeRoot;
}

export function storeRootForLoadedDefaultConfigPath(
  loadedConfig: LoadedProject02RuntimeConfig,
): string | undefined {
  return loadedConfig.path === undefined
    ? undefined
    : storeRootForSelectedDefaultConfigPath(loadedConfig.path);
}

export function diagnosticsHaveErrors(
  diagnostics: readonly RuntimeConfigDiagnostic[],
): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === 'error');
}

export function pluginHasConfigErrors(options: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly pluginId: string;
}): boolean {
  return options.diagnostics.some(
    diagnostic =>
      diagnostic.severity === 'error' &&
      runtimeConfigDiagnosticMatchesPluginConfig({
        diagnostic,
        pluginId: options.pluginId,
      }),
  );
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

export function runtimeConfigDiagnosticMatchesPluginConfig(options: {
  readonly diagnostic: RuntimeConfigDiagnostic;
  readonly pluginId: string;
}): boolean {
  return (
    options.diagnostic.scope === 'plugin' &&
    options.diagnostic.pluginId === options.pluginId &&
    options.diagnostic.pluginConfigField !== undefined
  );
}

function resolvePluginConfig(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
  readonly env: NodeJS.ProcessEnv;
  readonly allowPlaintextSecrets: boolean;
  readonly validateInactivePluginConfigs: boolean;
  readonly defaultEnabled: boolean;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): ResolvedPluginRuntimeConfig {
  const configuredPlugin = ownJsonRecordValue(
    options.config?.plugins,
    options.manifest.id,
  );
  const validateConfig =
    options.validateInactivePluginConfigs ||
    shouldValidatePluginConfig({
      config: options.config,
      manifest: options.manifest,
      defaultEnabled: options.defaultEnabled,
    });

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
  readonly env: NodeJS.ProcessEnv;
  readonly allowPlaintextSecrets: boolean;
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly validateConfig: boolean;
}): ResolvedRuntimeConfigField {
  const path = `plugins.${options.manifest.id}.config.${options.field.name}`;

  if (options.field.secret) {
    return resolveSecretField({...options, path});
  }

  if (options.rawValue === undefined) {
    if (options.field.required && options.validateConfig) {
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

  const secretValuePath = nestedSecretValuePath(options.rawValue, path);

  if (secretValuePath !== undefined) {
    if (options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_secret_ref_for_non_secret',
          `Non-secret config field "${options.field.name}" cannot contain a secret value.`,
          secretValuePath,
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

function resolveSecretField(options: {
  readonly manifest: RuntimePluginManifest;
  readonly field: RuntimePluginConfigField;
  readonly rawValue: RuntimeConfigValue | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly allowPlaintextSecrets: boolean;
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly path: string;
  readonly validateConfig: boolean;
}): ResolvedRuntimeConfigField {
  const envRef =
    options.rawValue === undefined && options.field.envVar !== undefined
      ? {$env: options.field.envVar}
      : isSecretRef(options.rawValue)
        ? options.rawValue
        : undefined;

  if (envRef !== undefined) {
    if (isRuntimeControlEnvVarName(envRef.$env)) {
      if (options.validateConfig) {
        options.diagnostics.push(
          createRuntimeConfigDiagnostic(
            'error',
            'runtime_config_reserved_control_env_var',
            `Secret config field "${options.field.name}" for plugin "${options.manifest.id}" cannot use reserved Project02 runtime control env var "${envRef.$env}".`,
            options.path,
            pluginConfigDiagnosticMetadata(options),
          ),
        );
      }

      return fieldResult({
        field: options.field,
        source: `env:${envRef.$env}`,
        resolved: false,
      });
    }

    const secretValue = options.env[envRef.$env];
    const resolved = secretValue !== undefined && secretValue.length > 0;

    if (!resolved && options.field.required && options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_required_secret_missing',
          `Required secret "${options.field.name}" for plugin "${options.manifest.id}" is missing from env:${envRef.$env}.`,
          options.path,
          pluginConfigDiagnosticMetadata(options),
        ),
      );
    }

    return fieldResult({
      field: options.field,
      source: `env:${envRef.$env}`,
      resolved,
      ...(resolved ? {value: secretValue} : {}),
    });
  }

  if (isPlaintextSecretOverride(options.rawValue)) {
    if (!options.allowPlaintextSecrets && options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_plaintext_secret_rejected',
          `Plaintext secret override for "${options.field.name}" is not allowed.`,
          options.path,
          pluginConfigDiagnosticMetadata(options),
        ),
      );
    }

    return fieldResult({
      field: options.field,
      source: 'plaintext_override',
      resolved: options.allowPlaintextSecrets,
      ...(options.allowPlaintextSecrets
        ? {value: options.rawValue.$plaintextSecret}
        : {}),
    });
  }

  if (options.rawValue !== undefined) {
    if (options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_plaintext_secret_rejected',
          `Secret config field "${options.field.name}" must use an env ref.`,
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

  if (options.field.required && options.validateConfig) {
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

function isSecretRef(
  value: RuntimeConfigValue | undefined,
): value is RuntimeConfigSecretRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '$env' in value &&
    typeof value.$env === 'string'
  );
}

function isPlaintextSecretOverride(
  value: RuntimeConfigValue | undefined,
): value is {
  readonly $plaintextSecret: string;
  readonly allowPlaintextSecret: true;
  readonly justification: string;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '$plaintextSecret' in value
  );
}

function nestedSecretValuePath(
  value: RuntimeConfigValue | undefined,
  path: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isSecretRef(value) || isPlaintextSecretOverride(value)) {
    return path;
  }

  if (Array.isArray(value)) {
    const items: readonly RuntimeConfigValue[] = value;

    for (const [index, item] of items.entries()) {
      const nestedPath = nestedSecretValuePath(
        item,
        `${path}.${String(index)}`,
      );

      if (nestedPath !== undefined) {
        return nestedPath;
      }
    }

    return undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    const nestedPath = nestedSecretValuePath(item, `${path}.${key}`);

    if (nestedPath !== undefined) {
      return nestedPath;
    }
  }

  return undefined;
}

function effectiveFingerprintInput(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly storeRoot: string;
  readonly redactedPluginConfigs: Readonly<
    Record<string, RedactedPluginRuntimeConfig>
  >;
}): RuntimeConfigValue {
  const pluginActivation = pluginActivationFingerprintInput(options.config);

  return Object.freeze({
    version: options.config?.version ?? 'none',
    project02: Object.freeze({
      storeRoot: options.storeRoot,
      defaultMemoryProvider:
        options.config?.project02?.defaultMemoryProvider ?? null,
      roleModelProvider:
        options.config?.project02?.roleModelProvider ?? 'local',
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
