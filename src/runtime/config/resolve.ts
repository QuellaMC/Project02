import {
  createLocalRuntimeStorageLayout
} from '../storage/layout.ts';
import type {
  RuntimePluginConfigField,
  RuntimePluginManifest
} from '../../plugins/types.ts';
import {
  createRuntimeConfigFingerprint
} from './fingerprint.ts';
import {
  redactResolvedRuntimeConfigField
} from './redact.ts';
import type {
  LoadedProject02RuntimeConfig,
  Project02RuntimeConfig,
  RedactedPluginRuntimeConfig,
  ResolvedPluginRuntimeConfig,
  ResolvedProject02RuntimeConfig,
  ResolvedRuntimeConfigField,
  RuntimeConfigDiagnostic,
  RuntimeConfigSecretRef,
  RuntimeConfigValue
} from './types.ts';

export type ResolveProject02RuntimeConfigOptions = {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly env?: NodeJS.ProcessEnv;
  readonly allowPlaintextSecrets?: boolean;
};

export function resolveProject02RuntimeConfig(
  options: ResolveProject02RuntimeConfigOptions
): ResolvedProject02RuntimeConfig {
  const env = options.env ?? process.env;
  const config = options.loadedConfig.config;
  const configuredStoreRoot = config?.storeRoot ?? options.storeRoot;
  const storeRoot = createLocalRuntimeStorageLayout(
    configuredStoreRoot === undefined ? {} : { storeRoot: configuredStoreRoot }
  ).storeRoot;
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...options.loadedConfig.diagnostics
  ];
  const pluginConfigs: Record<string, ResolvedPluginRuntimeConfig> = {};
  const redactedPluginConfigs: Record<string, RedactedPluginRuntimeConfig> = {};

  for (const manifest of options.pluginManifests ?? []) {
    const resolved = resolvePluginConfig({
      config,
      manifest,
      env,
      allowPlaintextSecrets: options.allowPlaintextSecrets === true,
      diagnostics
    });

    pluginConfigs[manifest.id] = resolved;
    redactedPluginConfigs[manifest.id] = Object.freeze(
      Object.fromEntries(
        Object.entries(resolved).map(([name, field]) => [
          name,
          redactResolvedRuntimeConfigField(field)
        ])
      )
    );
  }

  return Object.freeze({
    source: options.loadedConfig.source,
    ...(options.loadedConfig.path === undefined
      ? {}
      : { path: options.loadedConfig.path }),
    storeRoot,
    ...(config?.defaultMemoryProvider === undefined
      ? {}
      : { defaultMemoryProvider: config.defaultMemoryProvider }),
    pluginConfigs: Object.freeze(pluginConfigs),
    redactedPluginConfigs: Object.freeze(redactedPluginConfigs),
    diagnostics: Object.freeze(diagnostics),
    effectiveConfigFingerprint: createRuntimeConfigFingerprint(
      effectiveFingerprintInput({
        config,
        storeRoot,
        redactedPluginConfigs
      })
    )
  } satisfies ResolvedProject02RuntimeConfig);
}

export function diagnosticsHaveErrors(
  diagnostics: readonly RuntimeConfigDiagnostic[]
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

export function pluginHasConfigErrors(options: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly pluginId: string;
}): boolean {
  return options.diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === 'error' &&
      diagnostic.path?.startsWith(`plugins.${options.pluginId}.config`) === true
  );
}

function resolvePluginConfig(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly manifest: RuntimePluginManifest;
  readonly env: NodeJS.ProcessEnv;
  readonly allowPlaintextSecrets: boolean;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): ResolvedPluginRuntimeConfig {
  return Object.freeze(
    Object.fromEntries(
      options.manifest.config.fields.map((field) => [
        field.name,
        resolvePluginConfigField({
          ...options,
          field,
          rawValue:
            options.config?.plugins?.[options.manifest.id]?.config?.[field.name]
        })
      ])
    )
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
}): ResolvedRuntimeConfigField {
  const path = `plugins.${options.manifest.id}.config.${options.field.name}`;

  if (options.field.secret) {
    return resolveSecretField({ ...options, path });
  }

  if (options.rawValue === undefined) {
    if (options.field.required) {
      options.diagnostics.push(
        diagnostic(
          'error',
          'runtime_config_required_value_missing',
          `Required config field "${options.field.name}" is missing for plugin "${options.manifest.id}".`,
          path
        )
      );
    }

    return fieldResult({
      field: options.field,
      source: 'missing',
      resolved: !options.field.required
    });
  }

  if (isSecretRef(options.rawValue) || isPlaintextSecretOverride(options.rawValue)) {
    options.diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_secret_ref_for_non_secret',
        `Non-secret config field "${options.field.name}" cannot use a secret value.`,
        path
      )
    );
    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: false
    });
  }

  if (!valueMatchesField(options.rawValue, options.field)) {
    options.diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_value_type_invalid',
        `Config field "${options.field.name}" does not match its declared metadata.`,
        path
      )
    );
    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: false,
      value: options.rawValue
    });
  }

  return fieldResult({
    field: options.field,
    source: 'config',
    resolved: true,
    value: options.rawValue
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
}): ResolvedRuntimeConfigField {
  const envRef =
    options.rawValue === undefined && options.field.envVar !== undefined
      ? { $env: options.field.envVar }
      : isSecretRef(options.rawValue)
        ? options.rawValue
        : undefined;

  if (envRef !== undefined) {
    const resolved = options.env[envRef.$env] !== undefined;

    if (!resolved && options.field.required) {
      options.diagnostics.push(
        diagnostic(
          'error',
          'runtime_config_required_secret_missing',
          `Required secret "${options.field.name}" for plugin "${options.manifest.id}" is missing from env:${envRef.$env}.`,
          options.path
        )
      );
    }

    return fieldResult({
      field: options.field,
      source: `env:${envRef.$env}`,
      resolved,
      ...(resolved ? { value: options.env[envRef.$env] ?? '' } : {})
    });
  }

  if (isPlaintextSecretOverride(options.rawValue)) {
    if (!options.allowPlaintextSecrets) {
      options.diagnostics.push(
        diagnostic(
          'error',
          'runtime_config_plaintext_secret_rejected',
          `Plaintext secret override for "${options.field.name}" is not allowed.`,
          options.path
        )
      );
    }

    return fieldResult({
      field: options.field,
      source: 'plaintext_override',
      resolved: options.allowPlaintextSecrets,
      ...(options.allowPlaintextSecrets
        ? { value: options.rawValue.$plaintextSecret }
        : {})
    });
  }

  if (options.rawValue !== undefined) {
    options.diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_plaintext_secret_rejected',
        `Secret config field "${options.field.name}" must use an env ref.`,
        options.path
      )
    );
    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: false
    });
  }

  if (options.field.required) {
    options.diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_required_secret_missing',
        `Required secret "${options.field.name}" is missing for plugin "${options.manifest.id}".`,
        options.path
      )
    );
  }

  return fieldResult({
    field: options.field,
    source: 'missing',
    resolved: !options.field.required
  });
}

function valueMatchesField(
  value: RuntimeConfigValue,
  field: RuntimePluginConfigField
): boolean {
  if (
    field.allowedValues !== undefined &&
    (typeof value !== 'string' || !field.allowedValues.includes(value))
  ) {
    return false;
  }

  switch (field.valueType) {
    case undefined:
      return true;
    case 'string':
    case 'path':
    case 'enum':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'secret':
      return field.secret;
  }

  return true;
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
    ...(options.value === undefined ? {} : { value: options.value })
  } satisfies ResolvedRuntimeConfigField);
}

function isSecretRef(
  value: RuntimeConfigValue | undefined
): value is RuntimeConfigSecretRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '$env' in value &&
    typeof value.$env === 'string'
  );
}

function isPlaintextSecretOverride(value: RuntimeConfigValue | undefined): value is {
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

function effectiveFingerprintInput(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly storeRoot: string;
  readonly redactedPluginConfigs: Readonly<Record<string, RedactedPluginRuntimeConfig>>;
}): RuntimeConfigValue {
  return Object.freeze({
    version: options.config?.version ?? 'none',
    storeRoot: options.storeRoot,
    enabledPlugins: Object.freeze([...(options.config?.enabledPlugins ?? [])]),
    defaultMemoryProvider: options.config?.defaultMemoryProvider ?? null,
    plugins: options.redactedPluginConfigs
  });
}

function diagnostic(
  severity: RuntimeConfigDiagnostic['severity'],
  code: string,
  message: string,
  path: string
): RuntimeConfigDiagnostic {
  return Object.freeze({
    severity,
    code,
    message,
    path
  } satisfies RuntimeConfigDiagnostic);
}
