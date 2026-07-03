export const runtimeConfigVersion = 'project02.runtime_config.v1';
export const runtimeConfigEnvVarName = 'PROJECT02_RUNTIME_CONFIG';
export const roleModelProviderEnvVarName = 'PROJECT02_ROLE_MODEL_PROVIDER';
export const runtimeControlEnvVarNames: readonly string[] = Object.freeze([
  runtimeConfigEnvVarName,
  roleModelProviderEnvVarName
]);

export function isRuntimeControlEnvVarName(name: string): boolean {
  return runtimeControlEnvVarNames.includes(name);
}

export type RuntimeConfigSecretRef = {
  readonly $env: string;
  readonly description?: string;
};

export type RuntimeConfigPlaintextSecretOverride = {
  readonly $plaintextSecret: string;
  readonly allowPlaintextSecret: true;
  readonly justification: string;
};

export type RuntimeConfigObject = {
  readonly [key: string]: RuntimeConfigValue;
};

export type RuntimeConfigValue =
  | string
  | number
  | boolean
  | null
  | RuntimeConfigSecretRef
  | RuntimeConfigPlaintextSecretOverride
  | readonly RuntimeConfigValue[]
  | RuntimeConfigObject;

export type Project02RuntimeConfig = {
  readonly version: typeof runtimeConfigVersion;
  readonly storeRoot?: string;
  readonly enabledPlugins?: readonly string[];
  readonly defaultMemoryProvider?: string;
  readonly plugins?: Readonly<Record<string, Project02RuntimePluginConfig>>;
};

export type Project02RuntimePluginConfig = {
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, RuntimeConfigValue>>;
};

export type RuntimeConfigSource = 'none' | 'default' | 'path' | 'env';
export type RuntimeConfigDiagnosticSeverity = 'warning' | 'error';

export type RuntimeConfigDiagnostic = {
  readonly severity: RuntimeConfigDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly pluginId?: string;
  readonly pluginConfigField?: string;
};

export type LoadedProject02RuntimeConfig = {
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export type RuntimeConfigFieldSource =
  | 'config'
  | 'default'
  | 'missing'
  | 'plaintext_override'
  | `env:${string}`;

export type ResolvedRuntimeConfigField = {
  readonly name: string;
  readonly secret: boolean;
  readonly source: RuntimeConfigFieldSource;
  readonly resolved: boolean;
  readonly value?: RuntimeConfigValue;
};

export type RedactedRuntimeConfigField = {
  readonly name: string;
  readonly secret: boolean;
  readonly source: RuntimeConfigFieldSource;
  readonly resolved: boolean;
  readonly value?: RuntimeConfigValue;
};

export type ResolvedPluginRuntimeConfig = Readonly<
  Record<string, ResolvedRuntimeConfigField>
>;

export type RedactedPluginRuntimeConfig = Readonly<
  Record<string, RedactedRuntimeConfigField>
>;

export type ResolvedProject02RuntimeConfig = {
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly storeRoot: string;
  readonly defaultMemoryProvider?: string;
  readonly pluginConfigs: Readonly<Record<string, ResolvedPluginRuntimeConfig>>;
  readonly redactedPluginConfigs: Readonly<Record<string, RedactedPluginRuntimeConfig>>;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly effectiveConfigFingerprint: string;
};

export type RuntimeConfigInspectShape = {
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly storeRoot: string;
  readonly defaultMemoryProvider?: string;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly fingerprint: string;
};

export type RuntimeConfigMutationOperation =
  | {
      readonly kind: 'set';
      readonly path: string;
      readonly value: RuntimeConfigValue;
    }
  | {
      readonly kind: 'unset';
      readonly path: string;
    }
  | {
      readonly kind: 'plugin_enable';
      readonly pluginId: string;
    }
  | {
      readonly kind: 'plugin_disable';
      readonly pluginId: string;
    }
  | {
      readonly kind: 'default_memory_provider';
      readonly pluginId?: string;
    }
  | {
      readonly kind: 'secret_set';
      readonly pluginId: string;
      readonly fieldName: string;
      readonly envVar: string;
      readonly secretValue: string;
    };
