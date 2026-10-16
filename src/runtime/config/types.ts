import type {
  RuntimeConfigFieldDeclaration,
  RuntimeConfigSectionScope,
  RuntimeConfigValueType,
  RuntimePluginKind,
} from '../../plugins/api/index.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';

export const runtimeConfigVersion = 'project02.config.v2';
export const project02RoleModelProviderValues = ['local', 'nvidia'] as const;
/** The document's top-level stanzas that hold declared sections by id. */
export const runtimeConfigSectionNamespaces = [
  'plugins',
  'connectors',
] as const;

export type RuntimeConfigSectionNamespace =
  (typeof runtimeConfigSectionNamespaces)[number];

export type RuntimeConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeConfigValue[]
  | {readonly [key: string]: RuntimeConfigValue};

type Project02RoleModelProvider =
  (typeof project02RoleModelProviderValues)[number];

export type Project02HostConfig = Readonly<
  Record<string, RuntimeConfigValue | undefined>
> & {
  readonly enabled?: boolean;
  readonly userDisplayName?: string;
  readonly defaultMemoryProvider?: string;
  readonly roleModelProvider?: Project02RoleModelProvider;
  readonly nvidiaApiKey?: string;
  readonly nvidiaModel?: string;
  readonly contextWindowTokens?: number;
};

export type Project02RuntimeConfig = {
  readonly version: typeof runtimeConfigVersion;
  readonly project02?: Project02HostConfig;
  readonly plugins?: Readonly<Record<string, Project02RuntimeSectionConfig>>;
  readonly connectors?: Readonly<Record<string, Project02RuntimeSectionConfig>>;
};

export type Project02RuntimeSectionConfig = {
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, RuntimeConfigValue>>;
};

/**
 * What the config functions read of a section's owner. A plugin manifest is
 * one as it stands.
 */
export type RuntimeConfigSectionDeclaration = {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly config: {
    readonly scope: RuntimeConfigSectionScope;
    readonly fields: readonly RuntimeConfigFieldDeclaration[];
  };
  readonly activation: {
    readonly defaultEnabled: boolean;
    readonly reasons: readonly string[];
  };
  /** Only a plugin has one; the resolver's memory-provider rule reads it. */
  readonly kind?: RuntimePluginKind;
};

/** Declarations travel under their namespace; nothing is stamped onto one. */
export type RuntimeConfigSections = Readonly<
  Record<
    RuntimeConfigSectionNamespace,
    readonly RuntimeConfigSectionDeclaration[]
  >
>;

/** Keyed by namespace, then id, so two sections that share an id never meet. */
export type RuntimeConfigSectionMap<T> = Readonly<
  Record<RuntimeConfigSectionNamespace, Readonly<Record<string, T>>>
>;

export function createRuntimeConfigSectionMap<T>(
  sectionsOf: (
    namespace: RuntimeConfigSectionNamespace,
  ) => Readonly<Record<string, T>>,
): RuntimeConfigSectionMap<T> {
  // Sound: the entries come from the namespace list, which is exactly the keys.
  return Object.freeze(
    Object.fromEntries(
      runtimeConfigSectionNamespaces.map(namespace => [
        namespace,
        Object.freeze(sectionsOf(namespace)),
      ]),
    ),
  ) as RuntimeConfigSectionMap<T>;
}

/** 'none' is an absent file; a file that exists, however broken, is 'path'. */
export type RuntimeConfigSource = 'none' | 'path';
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
      readonly scope: 'section';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
      readonly field?: string;
    });

export type RuntimeConfigDiagnosticSectionMetadata = {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly id: string;
  readonly field?: string;
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
  /** Survives failed validation so control can repair the real document. */
  readonly authoredDocument?: JsonBoundaryObject;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

type RuntimeConfigFieldSource = 'config' | 'default' | 'missing';

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

export type ResolvedRuntimeSectionConfig = Readonly<
  Record<string, ResolvedRuntimeConfigField>
>;

export type RedactedRuntimeSectionConfig = ResolvedRuntimeSectionConfig;

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
    readonly nvidiaApiKey?: string;
    readonly nvidiaModel?: string;
    readonly contextWindowTokens: number;
  };
  readonly sectionConfigs: RuntimeConfigSectionMap<ResolvedRuntimeSectionConfig>;
  readonly redactedSectionConfigs: RuntimeConfigSectionMap<RedactedRuntimeSectionConfig>;
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
    /** Never the key: '[redacted]' whenever one is set. */
    readonly nvidiaApiKey?: string;
    readonly nvidiaModel?: string;
    readonly contextWindowTokens: number;
  };
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly fingerprint: string;
};

export type RuntimeConfigFieldInspectShape = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly valueType?: RuntimeConfigValueType;
  readonly allowedValues?: readonly string[];
  readonly agentMutable: boolean;
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
export type RuntimeConfigSectionActivationShape = {
  readonly enabled: boolean;
  readonly status: 'active' | 'disabled' | 'blocked';
  readonly reasons: readonly string[];
};

export type RuntimeConfigSectionInspectShape = {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly enabled: boolean;
  /** Which document decides `enabled`: this character's, the home's, or the manifest's default. */
  readonly enabledSource: RuntimeConfigEffectiveSource;
  readonly activation: RuntimeConfigSectionActivationShape;
  readonly fields: readonly RuntimeConfigFieldInspectShape[];
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
      readonly kind: 'section_enable';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
    }
  | {
      readonly kind: 'section_disable';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
    }
  | {
      readonly kind: 'section_activation_clear';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
    }
  | {
      readonly kind: 'section_field_set';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
      readonly fieldName: string;
      readonly value: RuntimeConfigValue;
    }
  | {
      readonly kind: 'section_field_unset';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
      readonly fieldName: string;
    };
