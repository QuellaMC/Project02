import type {RuntimePluginConfigValueType} from '../../plugins/api/index.ts';

export const runtimeConfigVersion = 'project02.config.v2';
export const runtimeConfigEnvVarName = 'PROJECT02_RUNTIME_CONFIG';
export const roleModelProviderEnvVarName = 'PROJECT02_ROLE_MODEL_PROVIDER';
export const project02RoleModelProviderValues = ['local', 'nvidia'] as const;
export const runtimeControlEnvVarNames: readonly string[] = Object.freeze([
  runtimeConfigEnvVarName,
  roleModelProviderEnvVarName,
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

export type Project02RoleModelProvider =
  (typeof project02RoleModelProviderValues)[number];

export const defaultProject02CharacterId = 'mira';
export const defaultProject02UserDisplayName = 'You';

export type Project02HostConfig = Readonly<
  Record<string, RuntimeConfigValue | undefined>
> & {
  readonly storeRoot?: string;
  readonly character?: string;
  readonly userDisplayName?: string;
  readonly defaultMemoryProvider?: string;
  readonly roleModelProvider?: Project02RoleModelProvider;
};

export type Project02RuntimeConfig = {
  readonly version: typeof runtimeConfigVersion;
  readonly project02?: Project02HostConfig;
  readonly plugins?: Readonly<Record<string, Project02RuntimePluginConfig>>;
};

export type Project02RuntimePluginConfig = {
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, RuntimeConfigValue>>;
};

export type RuntimeConfigSource = 'none' | 'default' | 'path' | 'env';
export type RuntimeConfigDiagnosticSeverity = 'warning' | 'error';

export type RuntimeConfigFieldScope = 'global' | 'character';

/**
 * Which config document a diagnostic came from. Global-document
 * diagnostics carry no origin; character-overlay diagnostics name the
 * character and overlay path so CLI output can attribute them.
 */
export type RuntimeConfigDiagnosticOrigin = {
  readonly scope: RuntimeConfigFieldScope;
  readonly characterId?: string;
  readonly path?: string;
};

type RuntimeConfigDiagnosticBase = {
  readonly severity: RuntimeConfigDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly origin?: RuntimeConfigDiagnosticOrigin;
};

export type RuntimeConfigDiagnostic =
  | (RuntimeConfigDiagnosticBase & {
      readonly scope: 'global';
    })
  | (RuntimeConfigDiagnosticBase & {
      readonly scope: 'plugin';
      readonly pluginId: string;
      readonly pluginConfigField?: string;
    });

export type RuntimeConfigDiagnosticPluginMetadata = {
  readonly pluginId: string;
  readonly pluginConfigField?: string;
};

export type LoadedProject02RuntimeConfig = {
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export type RuntimeConfigFieldSource =
  'config' | 'default' | 'missing' | 'plaintext_override' | `env:${string}`;

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
  readonly project02: {
    readonly storeRoot: string;
    readonly character: string;
    readonly userDisplayName: string;
    readonly defaultMemoryProvider?: string;
    readonly roleModelProvider: Project02RoleModelProvider;
  };
  readonly pluginConfigs: Readonly<Record<string, ResolvedPluginRuntimeConfig>>;
  readonly redactedPluginConfigs: Readonly<
    Record<string, RedactedPluginRuntimeConfig>
  >;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly effectiveConfigFingerprint: string;
};

export type RuntimeConfigInspectShape = {
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly project02: {
    readonly storeRoot: string;
    readonly character: string;
    readonly userDisplayName: string;
    readonly defaultMemoryProvider?: string;
    readonly roleModelProvider: Project02RoleModelProvider;
  };
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly fingerprint: string;
};

export type RuntimePluginConfigFieldInspectShape = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly valueType?: RuntimePluginConfigValueType;
  readonly defaultValueSummary?: string;
  readonly allowedValues?: readonly string[];
  readonly agentMutable: boolean;
  readonly reloadRequired: boolean;
  readonly authored: {
    readonly configured: boolean;
    readonly value?: RuntimeConfigValue;
  };
  readonly effective: RedactedRuntimeConfigField;
};

export type RuntimePluginConfigActivationInspectShape = {
  readonly enabled: boolean;
  readonly status: 'active' | 'disabled' | 'blocked';
  readonly reasons: readonly string[];
};

export type RuntimePluginConfigInspectShape = {
  readonly pluginId: string;
  readonly displayName: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly activation: RuntimePluginConfigActivationInspectShape;
  readonly fields: readonly RuntimePluginConfigFieldInspectShape[];
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
      readonly kind: 'plugin_config_set';
      readonly pluginId: string;
      readonly fieldName: string;
      readonly value: RuntimeConfigValue;
    }
  | {
      readonly kind: 'plugin_config_unset';
      readonly pluginId: string;
      readonly fieldName: string;
    }
  | {
      readonly kind: 'secret_set';
      readonly pluginId: string;
      readonly fieldName: string;
      readonly envVar: string;
      readonly secretValue: string;
    };
