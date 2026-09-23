import type {RuntimePluginConfigValueType} from '../../plugins/api/index.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';

export const runtimeConfigVersion = 'project02.config.v2';
export const runtimeConfigEnvVarName = 'PROJECT02_RUNTIME_CONFIG';
export const roleModelProviderEnvVarName = 'PROJECT02_ROLE_MODEL_PROVIDER';
export const project02RoleModelProviderValues = ['local', 'nvidia'] as const;

export type RuntimeConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeConfigValue[]
  | {readonly [key: string]: RuntimeConfigValue};

type Project02RoleModelProvider =
  (typeof project02RoleModelProviderValues)[number];

/** A safe floor for small local models; a stopgap until providers report their own limit. */
export const defaultProject02ContextWindowTokens = 32768;
export const defaultProject02UserDisplayName = 'You';

export type Project02HostConfig = Readonly<
  Record<string, RuntimeConfigValue | undefined>
> & {
  readonly storeRoot?: string;
  readonly enabled?: boolean;
  readonly userDisplayName?: string;
  readonly defaultMemoryProvider?: string;
  readonly roleModelProvider?: Project02RoleModelProvider;
  readonly contextWindowTokens?: number;
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
export type SelectedProject02RuntimeConfigOwner =
  Readonly<{kind: 'home'; homeRoot: string}> | Readonly<{kind: 'standalone'}>;
export type SelectedProject02RuntimeConfigLocation = {
  readonly source: Exclude<RuntimeConfigSource, 'none'>;
  readonly path: string;
  readonly canonicalPath: string;
  /** Owner of the selected file, distinct from its effective runtime home. */
  readonly owner: SelectedProject02RuntimeConfigOwner;
  /** Overridable for the effective runtime; never re-derived after load. */
  readonly runtimeHomeRoot?: string;
};
type RuntimeConfigDiagnosticSeverity = 'warning' | 'error';

export type RuntimeConfigFieldScope = 'global' | 'character';

/** Threaded from activation so every fingerprint site sees one pair. */
export type RuntimeConfigCharacterScope = {
  readonly characterId: string;
  readonly dataRoot: string;
};

/** An absent origin means the global document. */
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

/** One spelling of a diagnostic's location for every operator surface. */
export function runtimeConfigDiagnosticLocation(
  diagnostic: RuntimeConfigDiagnostic,
): string {
  return diagnostic.path === undefined
    ? diagnostic.code
    : `${diagnostic.code} at ${diagnostic.path}`;
}

export type LoadedProject02RuntimeConfig = {
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  /** Immutable operator selection provenance, independent from file absence. */
  readonly selectedConfig?: SelectedProject02RuntimeConfigLocation;
  /** Survives failed validation so control can repair the real document. */
  readonly authoredDocument?: JsonBoundaryObject;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export type SelectedLoadedProject02RuntimeConfig =
  LoadedProject02RuntimeConfig & {
    readonly path: string;
    readonly selectedConfig: SelectedProject02RuntimeConfigLocation;
  };

type RuntimeConfigFieldSource = 'config' | 'missing';

/** Distinct from RuntimeConfigFieldSource, which says how a field resolves. */
export type RuntimeConfigEffectiveSource = 'default' | RuntimeConfigFieldScope;

export type ResolvedRuntimeConfigField = {
  readonly name: string;
  readonly secret: boolean;
  readonly source: RuntimeConfigFieldSource;
  readonly resolved: boolean;
  readonly value?: RuntimeConfigValue;
};

/** Same shape; the alias marks which side of the redaction boundary it is. */
export type RedactedRuntimeConfigField = ResolvedRuntimeConfigField;

export type ResolvedPluginRuntimeConfig = Readonly<
  Record<string, ResolvedRuntimeConfigField>
>;

export type RedactedPluginRuntimeConfig = ResolvedPluginRuntimeConfig;

export type ResolvedProject02RuntimeConfig = {
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly project02: {
    readonly storeRoot: string;
    readonly character: string;
    readonly enabled: boolean;
    readonly userDisplayName: string;
    readonly defaultMemoryProvider?: string;
    readonly roleModelProvider: Project02RoleModelProvider;
    readonly contextWindowTokens: number;
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
    readonly enabled: boolean;
    readonly userDisplayName: string;
    readonly defaultMemoryProvider?: string;
    readonly roleModelProvider: Project02RoleModelProvider;
    readonly contextWindowTokens: number;
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
  /**
   * false when this scope may not author the field, so a console never
   * offers a setting whose save the scope rules would reject.
   */
  readonly editableInScope: boolean;
  readonly reloadRequired: boolean;
  /** Value authored in the inspection's explicit mutation target only. */
  readonly authored: {
    readonly configured: boolean;
    readonly value?: RuntimeConfigValue;
  };
  readonly effectiveSource: RuntimeConfigEffectiveSource;
  readonly effective: RedactedRuntimeConfigField;
};

/** What the activation plan decided; carries no scope-authoring judgement. */
export type RuntimePluginActivationStatusShape = {
  readonly enabled: boolean;
  readonly status: 'active' | 'disabled' | 'blocked';
  readonly reasons: readonly string[];
};

export type RuntimePluginConfigActivationInspectShape =
  RuntimePluginActivationStatusShape & {
    /** false when this scope may not turn the plugin on or off. */
    readonly editableInScope: boolean;
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
      readonly kind: 'plugin_activation_clear';
      readonly pluginId: string;
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
    };
