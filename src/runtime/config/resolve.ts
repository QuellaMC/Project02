import {localUserSpeaker} from '../../core/index.ts';
import {
  runtimeConfigValueMatchesField,
  type RuntimeConfigFieldDeclaration,
} from '../../plugins/api/index.ts';
import {createRuntimeConfigFingerprint} from './fingerprint.ts';
import type {ResolvedProject02RuntimeLocation} from './location.ts';
import {runtimeConfigSectionPath} from './path.ts';
import {redactResolvedRuntimeConfigField} from './redact.ts';
import {runtimeSectionValueLayers} from './section-scope.ts';
import {
  createRuntimeConfigSectionMap,
  runtimeConfigSectionNamespaces,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RedactedRuntimeSectionConfig,
  type ResolvedRuntimeSectionConfig,
  type ResolvedProject02RuntimeConfig,
  type ResolvedRuntimeConfigField,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticSectionMetadata,
  type RuntimeConfigFieldScope,
  type RuntimeConfigSectionDeclaration,
  type RuntimeConfigSectionMap,
  type RuntimeConfigSectionNamespace,
  type RuntimeConfigSections,
  type RuntimeConfigSource,
  type RuntimeConfigValue,
} from './types.ts';
import {
  createJsonBoundarySnapshot,
  ownJsonRecordValue,
} from '../../shared/json-boundary.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {
  defaultProject02ContextWindowTokens,
  defaultProject02Enabled,
  defaultProject02RoleModelProvider,
} from './schema.ts';

export type ResolveProject02RuntimeConfigOptions = {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly sections: RuntimeConfigSections;
  readonly validateInactiveSectionConfigs?: boolean;
  /** Overrides a declaration's own default where a namespace lists its ids. */
  readonly defaultEnabledSectionIds?: Readonly<
    Partial<Record<RuntimeConfigSectionNamespace, ReadonlySet<string>>>
  >;
};

type ResolveEffectiveProject02RuntimeConfigOptions = Omit<
  ResolveProject02RuntimeConfigOptions,
  'loadedConfig'
> & {
  readonly config: Project02RuntimeConfig | undefined;
  readonly target: RuntimeConfigFieldScope;
  readonly source: RuntimeConfigSource;
  readonly path?: string;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export type ResolveRuntimeSectionConfigsOptions = Omit<
  ResolveProject02RuntimeConfigOptions,
  'loadedConfig' | 'runtimeLocation'
> & {
  readonly config: Project02RuntimeConfig | undefined;
  /** Whose effective document `config` is. */
  readonly target: RuntimeConfigFieldScope;
};

export type ResolvedRuntimeSectionConfigs = Readonly<{
  sectionConfigs: RuntimeConfigSectionMap<ResolvedRuntimeSectionConfig>;
  redactedSectionConfigs: RuntimeConfigSectionMap<RedactedRuntimeSectionConfig>;
  diagnostics: readonly RuntimeConfigDiagnostic[];
}>;

/** Needs no filesystem location, so package planning can call it too. */
export function resolveRuntimeSectionConfigs(
  options: ResolveRuntimeSectionConfigsOptions,
): ResolvedRuntimeSectionConfigs {
  const diagnostics: RuntimeConfigDiagnostic[] = [];
  const sectionConfigs = createRuntimeConfigSectionMap(namespace =>
    Object.fromEntries(
      options.sections[namespace].map(declaration => [
        declaration.id,
        resolveSectionConfig({
          config: options.config,
          target: options.target,
          namespace,
          declaration,
          validateInactiveSectionConfigs:
            options.validateInactiveSectionConfigs === true,
          defaultEnabled:
            options.defaultEnabledSectionIds?.[namespace]?.has(
              declaration.id,
            ) ?? declaration.activation.defaultEnabled,
          diagnostics,
        }),
      ]),
    ),
  );
  const redactedSectionConfigs = createRuntimeConfigSectionMap(namespace =>
    Object.fromEntries(
      Object.entries(sectionConfigs[namespace]).map(([id, resolved]) => [
        id,
        Object.freeze(
          Object.fromEntries(
            Object.entries(resolved).map(([name, field]) => [
              name,
              redactResolvedRuntimeConfigField(field),
            ]),
          ),
        ),
      ]),
    ),
  );

  return Object.freeze({
    sectionConfigs,
    redactedSectionConfigs,
    diagnostics: Object.freeze(diagnostics),
  });
}

/** Mutation code must not use this; it needs a real loader-owned snapshot. */
export function resolveEffectiveProject02RuntimeConfig(
  options: ResolveEffectiveProject02RuntimeConfigOptions,
): ResolvedProject02RuntimeConfig {
  const config = options.config;
  const storeRoot = options.runtimeLocation.homeRoot;
  const sectionResolution = resolveRuntimeSectionConfigs({
    config,
    target: options.target,
    sections: options.sections,
    validateInactiveSectionConfigs:
      options.validateInactiveSectionConfigs === true,
    ...(options.defaultEnabledSectionIds === undefined
      ? {}
      : {defaultEnabledSectionIds: options.defaultEnabledSectionIds}),
  });
  const diagnostics = Object.freeze([
    ...options.diagnostics,
    ...sectionResolution.diagnostics,
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
    sectionConfigs: sectionResolution.sectionConfigs,
    redactedSectionConfigs: sectionResolution.redactedSectionConfigs,
    diagnostics,
    effectiveConfigFingerprint: createRuntimeConfigFingerprint(
      effectiveFingerprintInput({
        config,
        project02,
        redactedSectionConfigs: sectionResolution.redactedSectionConfigs,
      }),
      options.sections,
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
    enabled: authored?.enabled ?? defaultProject02Enabled,
    // Trimmed here: the strict speaker constructor would crash on padding.
    userDisplayName: (
      authored?.userDisplayName ?? localUserSpeaker.displayName
    ).trim(),
    ...(defaultMemoryProvider === undefined ? {} : {defaultMemoryProvider}),
    roleModelProvider:
      authored?.roleModelProvider ?? defaultProject02RoleModelProvider,
    ...(authored?.nvidiaApiKey === undefined
      ? {}
      : {nvidiaApiKey: authored.nvidiaApiKey}),
    ...(authored?.nvidiaModel === undefined
      ? {}
      : {nvidiaModel: authored.nvidiaModel}),
    contextWindowTokens:
      authored?.contextWindowTokens ?? defaultProject02ContextWindowTokens,
  });
}

export function diagnosticsHaveErrors(
  diagnostics: readonly RuntimeConfigDiagnostic[],
): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === 'error');
}

export function runtimeConfigDiagnosticMatchesSection(options: {
  readonly diagnostic: RuntimeConfigDiagnostic;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly id: string;
}): boolean {
  return (
    options.diagnostic.scope === 'section' &&
    options.diagnostic.namespace === options.namespace &&
    options.diagnostic.id === options.id
  );
}

/** A field no layer its scope permits has authored takes its declared default. */
export function unauthoredRuntimeConfigField(
  field: RuntimeConfigFieldDeclaration,
  required: boolean,
): ResolvedRuntimeConfigField {
  return field.defaultValue === undefined
    ? fieldResult({field, source: 'missing', resolved: !required})
    : fieldResult({
        field,
        source: 'default',
        resolved: true,
        value: field.defaultValue,
      });
}

function resolveSectionConfig(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly target: RuntimeConfigFieldScope;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly validateInactiveSectionConfigs: boolean;
  readonly defaultEnabled: boolean;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): ResolvedRuntimeSectionConfig {
  const configuredSection = ownJsonRecordValue(
    options.config?.[options.namespace],
    options.declaration.id,
  );
  const validateReadiness = shouldValidateSectionConfig({
    config: options.config,
    namespace: options.namespace,
    declaration: options.declaration,
    defaultEnabled: options.defaultEnabled,
  });
  const validateConfig =
    options.validateInactiveSectionConfigs || validateReadiness;

  if (validateConfig) {
    pushUnknownSectionConfigFieldDiagnostics({
      namespace: options.namespace,
      declaration: options.declaration,
      rawConfig: configuredSection?.config,
      diagnostics: options.diagnostics,
    });
  }

  return Object.freeze(
    Object.fromEntries(
      options.declaration.config.fields.map(field => [
        field.name,
        resolveSectionConfigField({
          ...options,
          validateConfig,
          validateReadiness,
          field,
          rawValue: ownJsonRecordValue(configuredSection?.config, field.name),
        }),
      ]),
    ),
  );
}

function resolveSectionConfigField(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly target: RuntimeConfigFieldScope;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly field: RuntimeConfigFieldDeclaration;
  readonly rawValue: RuntimeConfigValue | undefined;
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly validateConfig: boolean;
  readonly validateReadiness: boolean;
}): ResolvedRuntimeConfigField {
  const path = runtimeConfigSectionPath(
    options.namespace,
    options.declaration.id,
    options.field.name,
  );
  // A target is held only to values its layers can supply; a value only
  // another target's layers supply is that target's to report missing.
  const required =
    options.field.required &&
    runtimeSectionValueLayers({
      declaration: options.declaration,
      field: options.field,
      target: options.target,
    }).length > 0;

  if (options.field.secret) {
    return resolveSecretField({...options, path, required});
  }

  if (options.rawValue === undefined) {
    if (required && options.validateReadiness) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_required_value_missing',
          `Required config field "${options.field.name}" is missing for section "${options.declaration.id}".`,
          path,
          sectionFieldDiagnosticMetadata(options),
        ),
      );
    }

    return unauthoredRuntimeConfigField(options.field, required);
  }

  if (!runtimeConfigValueMatchesField(options.rawValue, options.field)) {
    if (options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_value_type_invalid',
          `Config field "${options.field.name}" does not match its declared metadata.`,
          path,
          sectionFieldDiagnosticMetadata(options),
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
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly field: RuntimeConfigFieldDeclaration;
  readonly rawValue: RuntimeConfigValue | undefined;
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly path: string;
  readonly required: boolean;
  readonly validateConfig: boolean;
  readonly validateReadiness: boolean;
}): ResolvedRuntimeConfigField {
  // Silently ignoring what the operator wrote would leave a landmine in
  // the config, so a value of another shape, or a blank one, is an error:
  // a blank would read as set and resolve as absent at once.
  if (
    options.rawValue !== undefined &&
    (typeof options.rawValue !== 'string' ||
      options.rawValue.trim().length === 0)
  ) {
    if (options.validateConfig) {
      options.diagnostics.push(
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_secret_value_invalid',
          `Secret config field "${options.field.name}" must be a non-blank string.`,
          options.path,
          sectionFieldDiagnosticMetadata(options),
        ),
      );
    }

    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: false,
    });
  }

  if (options.rawValue !== undefined) {
    return fieldResult({
      field: options.field,
      source: 'config',
      resolved: true,
      value: options.rawValue,
    });
  }

  if (options.required && options.validateReadiness) {
    options.diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_required_secret_missing',
        `Required secret "${options.field.name}" is missing for section "${options.declaration.id}".`,
        options.path,
        sectionFieldDiagnosticMetadata(options),
      ),
    );
  }

  return unauthoredRuntimeConfigField(options.field, options.required);
}

function shouldValidateSectionConfig(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly defaultEnabled: boolean;
}): boolean {
  const configured = ownJsonRecordValue(
    options.config?.[options.namespace],
    options.declaration.id,
  );

  if (configured?.enabled === false) {
    return false;
  }

  if (
    !sectionCanRequireConfigValidation({
      config: options.config,
      declaration: options.declaration,
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

function sectionCanRequireConfigValidation(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly declaration: RuntimeConfigSectionDeclaration;
}): boolean {
  if (
    options.declaration.kind !== 'memory_provider' ||
    options.config?.project02?.defaultMemoryProvider === undefined
  ) {
    return true;
  }

  return isSelectedDefaultMemoryProvider(options);
}

function isSelectedDefaultMemoryProvider(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly declaration: RuntimeConfigSectionDeclaration;
}): boolean {
  return (
    options.declaration.kind === 'memory_provider' &&
    options.config?.project02?.defaultMemoryProvider === options.declaration.id
  );
}

function pushUnknownSectionConfigFieldDiagnostics(options: {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly rawConfig: Readonly<Record<string, RuntimeConfigValue>> | undefined;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): void {
  if (options.rawConfig === undefined) {
    return;
  }

  const declaredFields = new Set(
    options.declaration.config.fields.map(field => field.name),
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
        `Unknown config field "${fieldName}" for section "${options.declaration.id}".`,
        runtimeConfigSectionPath(
          options.namespace,
          options.declaration.id,
          fieldName,
        ),
        {
          namespace: options.namespace,
          id: options.declaration.id,
          field: fieldName,
        },
      ),
    );
  }
}

function sectionFieldDiagnosticMetadata(options: {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly field: RuntimeConfigFieldDeclaration;
}): RuntimeConfigDiagnosticSectionMetadata {
  return {
    namespace: options.namespace,
    id: options.declaration.id,
    field: options.field.name,
  };
}

function fieldResult(options: {
  readonly field: RuntimeConfigFieldDeclaration;
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
  readonly project02: ResolvedProject02RuntimeConfig['project02'];
  readonly redactedSectionConfigs: RuntimeConfigSectionMap<RedactedRuntimeSectionConfig>;
}): RuntimeConfigValue {
  const {project02} = options;
  const activation = sectionActivationFingerprintInput(options.config);

  return Object.freeze({
    version: options.config?.version ?? 'none',
    project02: Object.freeze({
      storeRoot: project02.storeRoot,
      character: project02.character,
      enabled: project02.enabled,
      userDisplayName: project02.userDisplayName,
      defaultMemoryProvider: project02.defaultMemoryProvider ?? null,
      roleModelProvider: project02.roleModelProvider,
      // Presence only: this fingerprint is shown, so the key never is.
      nvidiaApiKeySet: project02.nvidiaApiKey !== undefined,
      nvidiaModel: project02.nvidiaModel ?? null,
      contextWindowTokens: project02.contextWindowTokens,
    }),
    sections: options.redactedSectionConfigs,
    ...(activation === undefined ? {} : {activation}),
  });
}

function sectionActivationFingerprintInput(
  config: Project02RuntimeConfig | undefined,
): RuntimeConfigValue | undefined {
  const activation: Record<string, RuntimeConfigValue> = {};

  for (const namespace of runtimeConfigSectionNamespaces) {
    const enabledById: Record<string, RuntimeConfigValue> = {};

    for (const [id, section] of Object.entries(config?.[namespace] ?? {})) {
      if (section.enabled !== undefined) {
        enabledById[id] = Object.freeze({enabled: section.enabled});
      }
    }

    if (Object.keys(enabledById).length > 0) {
      activation[namespace] = Object.freeze(enabledById);
    }
  }

  return Object.keys(activation).length === 0
    ? undefined
    : Object.freeze(activation);
}
