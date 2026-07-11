import {
  defaultRuntimePluginCatalogFactoryDefinitions,
  hasRuntimePluginCatalogFactoryMetadata,
  hostScopedFirstPartyRuntimePluginIds,
  isHostOwnedFirstPartyRuntimePluginId,
  isHostScopedFirstPartyRuntimePluginId
} from '../../plugins/catalog.ts';
import type {
  RuntimePluginFactoryDefinition as RuntimePluginFactoryDefinitionContract
} from '../../plugins/factory.ts';
import {
  createRuntimePluginHost,
  runRuntimePluginSessionEndHooks,
  type RuntimePluginHost,
  type RuntimePluginSessionEndOptions
} from '../../plugins/host.ts';
import {
  createRuntimePluginContext,
  normalizeRuntimePluginAccessMap,
  type RuntimePluginAccessMap,
  type RuntimePlugin,
  type RuntimePluginKind,
  type RuntimePluginManifest
} from '../../plugins/types.ts';
import type {
  LoadedProject02RuntimeConfig,
  RedactedPluginRuntimeConfig,
  ResolvedPluginRuntimeConfig,
  ResolvedProject02RuntimeConfig,
  RuntimeConfigDiagnostic,
  RuntimeConfigDiagnosticPluginMetadata
} from './types.ts';
import {
  diagnosticsHaveErrors,
  runtimeConfigDiagnosticMatchesPlugin,
  resolveProject02RuntimeConfig
} from './resolve.ts';
import { stableStringify } from './fingerprint.ts';

export type RuntimePluginFactoryInput = {
  readonly pluginId: string;
  readonly storeRoot: string;
  readonly resolvedConfig: ResolvedPluginRuntimeConfig;
  readonly redactedConfig: RedactedPluginRuntimeConfig;
};

export type RuntimePluginFactoryFunction = (
  input: RuntimePluginFactoryInput
) => Promise<RuntimePlugin> | RuntimePlugin;

export type RuntimePluginFactoryDefinition =
  RuntimePluginFactoryDefinitionContract<RuntimePluginFactoryFunction>;

export type RuntimePluginActivationStatus =
  | 'active'
  | 'disabled'
  | 'blocked';

export type RuntimePluginActivationSnapshot = {
  readonly pluginId: string;
  readonly kind: RuntimePluginKind;
  readonly enabled: boolean;
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly grantedAccess: RuntimePluginAccessMap;
  readonly activationStatus: RuntimePluginActivationStatus;
  readonly activationReasons: readonly string[];
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export type RuntimePluginActivationResult = {
  readonly enabledPluginIds: readonly string[];
  readonly disabledPluginIds: readonly string[];
  readonly plugins: readonly RuntimePluginActivationSnapshot[];
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly defaultMemoryProvider?: string;
};

export type Project02ConfiguredPluginHost = {
  readonly host: RuntimePluginHost;
  readonly plugins: readonly RuntimePlugin[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly activation: RuntimePluginActivationResult;
};

export type Project02ConfiguredPluginActivation = {
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly activation: RuntimePluginActivationResult;
};

export type PreparedProject02PluginActivationPlan =
  Project02ConfiguredPluginActivation & {
    readonly factories: Readonly<
      Record<string, RuntimePluginFactoryDefinition>
    >;
  };

const configuredPluginConstructionCleanupSessionId =
  'configured-plugin-construction-cleanup';
const configuredPluginConstructionCleanupMessage =
  'configured plugin construction failed before host creation';
const configuredPluginConstructionCleanupCharacter = Object.freeze({
  id: 'project02-runtime-config',
  displayName: 'Project02 Runtime Config'
});
const configuredPluginConstructionCleanupOptions = Object.freeze({
  allowFileStoreWrites: false
} satisfies RuntimePluginSessionEndOptions);
const selectedAsDefaultMemoryProviderReason =
  'selected_as_default_memory_provider';
const defaultRuntimePluginFactoryDefinitions =
  defaultRuntimePluginCatalogFactoryDefinitions();

export function defaultRuntimePluginFactories(): Readonly<
  Record<string, RuntimePluginFactoryDefinition>
> {
  return defaultRuntimePluginFactoryDefinitions;
}

function composeRuntimePluginFactories(
  factories: Readonly<Record<string, RuntimePluginFactoryDefinition>>
): {
  readonly factories: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly defaultEnabledPluginIds: ReadonlySet<string>;
} {
  const includesHostCatalog = Object.entries(
    defaultRuntimePluginFactoryDefinitions
  ).every(([pluginId, canonicalDefinition]) => {
    const definition = factories[pluginId];

    return (
      definition !== undefined &&
      definition.manifest.id === pluginId &&
      hasRuntimePluginCatalogFactoryMetadata(definition) &&
      definition.construction === canonicalDefinition.construction
    );
  });
  const composedFactories = includesHostCatalog
    ? Object.freeze({
        ...factories,
        ...defaultRuntimePluginFactoryDefinitions
      })
    : factories;
  const defaultEnabledPluginIds = new Set<string>();

  for (const [pluginId, definition] of Object.entries(
    defaultRuntimePluginFactoryDefinitions
  )) {
    if (
      pluginId === definition.manifest.id &&
      isHostOwnedFirstPartyRuntimePluginId(pluginId) &&
      (definition.construction === 'host_scoped' || includesHostCatalog) &&
      definition.manifest.activation.defaultEnabled
    ) {
      defaultEnabledPluginIds.add(pluginId);
    }
  }

  return Object.freeze({
    factories: composedFactories,
    defaultEnabledPluginIds: Object.freeze(defaultEnabledPluginIds)
  });
}

export function prepareConfiguredProject02PluginActivation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly strictUnknownPlugins?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
}): PreparedProject02PluginActivationPlan {
  const composition = composeRuntimePluginFactories(
    options.factories ?? defaultRuntimePluginFactories()
  );
  const factories = Object.freeze({ ...composition.factories });
  const pluginManifests = activationPluginManifestsForFactories(factories);
  const resolvedConfig = resolveProject02RuntimeConfig({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    pluginManifests,
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const activation = resolveRuntimePluginActivation({
    pluginManifests,
    defaultEnabledPluginIds: composition.defaultEnabledPluginIds,
    resolvedConfig,
    loadedConfig: options.loadedConfig,
    strictUnknownPlugins: options.strictUnknownPlugins === true
  });

  return Object.freeze({
    factories,
    resolvedConfig,
    activation
  } satisfies PreparedProject02PluginActivationPlan);
}

export function resolveConfiguredProject02PluginActivation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly strictUnknownPlugins?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
}): Project02ConfiguredPluginActivation {
  const plan = prepareConfiguredProject02PluginActivation(options);

  return Object.freeze({
    resolvedConfig: plan.resolvedConfig,
    activation: plan.activation
  } satisfies Project02ConfiguredPluginActivation);
}

export async function createConfiguredProject02PluginHost(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly strictUnknownPlugins?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<Project02ConfiguredPluginHost> {
  const activationPlan = prepareConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    strictUnknownPlugins: options.strictUnknownPlugins === true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.factories === undefined ? {} : { factories: options.factories })
  });

  return createConfiguredProject02PluginHostFromPlan({
    activationPlan,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    ...(options.constructionCleanup === undefined
      ? {}
      : { constructionCleanup: options.constructionCleanup })
  });
}

export async function createConfiguredProject02PluginHostFromPlan(options: {
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<Project02ConfiguredPluginHost> {
  const { activationPlan } = options;
  const { factories } = activationPlan;

  if (diagnosticsHaveErrors(activationPlan.activation.diagnostics)) {
    const plugins: readonly RuntimePlugin[] = Object.freeze([]);

    return Object.freeze({
      host: createRuntimePluginHost({
        plugins,
        enabledPluginIds: activationPlan.activation.enabledPluginIds,
        storeRoot: activationPlan.resolvedConfig.storeRoot,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.sessionIdentity === undefined
          ? {}
          : { sessionIdentity: options.sessionIdentity })
      }),
      plugins,
      resolvedConfig: activationPlan.resolvedConfig,
      activation: activationPlan.activation
    } satisfies Project02ConfiguredPluginHost);
  }

  const plugins = await instantiateRuntimePluginFactories({
    factories,
    resolvedConfig: activationPlan.resolvedConfig,
    enabledPluginIds: activationPlan.activation.enabledPluginIds,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    ...(options.constructionCleanup === undefined
      ? {}
      : { constructionCleanup: options.constructionCleanup })
  });
  let host: RuntimePluginHost;

  try {
    host = createRuntimePluginHost({
      plugins,
      enabledPluginIds: activationPlan.activation.enabledPluginIds,
      storeRoot: activationPlan.resolvedConfig.storeRoot,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity })
    });
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      plugins,
      resolvedConfig: activationPlan.resolvedConfig,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity }),
      ...(options.constructionCleanup === undefined
        ? {}
        : { constructionCleanup: options.constructionCleanup })
    });
    throw error;
  }

  return Object.freeze({
    host,
    plugins,
    resolvedConfig: activationPlan.resolvedConfig,
    activation: activationPlan.activation
  } satisfies Project02ConfiguredPluginHost);
}

export function resolveRuntimePluginActivation(options: {
  readonly plugins?: readonly RuntimePlugin[];
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly defaultEnabledPluginIds?: ReadonlySet<string>;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly strictUnknownPlugins?: boolean;
}): RuntimePluginActivationResult {
  const pluginManifests =
    options.pluginManifests ?? options.plugins?.map((plugin) => plugin.manifest) ?? [];
  const config = options.loadedConfig.config;
  const pluginIds = new Set(pluginManifests.map((manifest) => manifest.id));
  const baseDiagnostics: readonly RuntimeConfigDiagnostic[] = Object.freeze([
    ...unknownPluginDiagnostics({
      knownPluginIds: pluginIds,
      loadedPlugins: config?.plugins ?? {},
      ...(config?.defaultMemoryProvider === undefined
        ? {}
        : { defaultMemoryProviderId: config.defaultMemoryProvider }),
      strict: options.strictUnknownPlugins === true
    }),
    ...options.resolvedConfig.diagnostics
  ]);
  const loadedConfigHasErrors = diagnosticsHaveErrors(options.loadedConfig.diagnostics);
  const globalConfigErrors = hasGlobalRuntimeConfigErrors({
    diagnostics: baseDiagnostics,
    knownPluginIds: pluginIds
  });
  const enabledPluginIds: string[] = [];
  const disabledPluginIds: string[] = [];
  const snapshots: RuntimePluginActivationSnapshot[] = [];
  const preliminaryDecisions = pluginManifests.map((manifest) => {
    const configured = config?.plugins?.[manifest.id];
    const defaultEnabled =
      options.defaultEnabledPluginIds?.has(manifest.id) === true;
    const configErrors =
      loadedConfigHasErrors ||
      globalConfigErrors ||
      pluginHasRuntimeConfigErrors({
        diagnostics: baseDiagnostics,
        pluginId: manifest.id
      });

    return Object.freeze({
      manifest,
      duplicateCandidateDecision: activationDecision({
        configuredEnabled: configured?.enabled,
        defaultEnabled,
        configErrors: false
      }),
      decision: activationDecision({
        configuredEnabled: configured?.enabled,
        defaultEnabled,
        configErrors
      })
    });
  });
  const duplicateCandidateMemoryProviderDecision = defaultMemoryProviderDecision({
    ...(config?.defaultMemoryProvider === undefined
      ? {}
      : { configDefaultMemoryProvider: config.defaultMemoryProvider }),
    pluginManifests,
    memoryProviderManifests: pluginManifests.filter(
      (manifest) => manifest.kind === 'memory_provider'
    ),
    enabledPluginManifests: preliminaryDecisions
      .filter((preliminary) => preliminary.duplicateCandidateDecision.enabled)
      .map((preliminary) => preliminary.manifest)
  });
  const duplicateManifestDiagnostics =
    duplicatePluginManifestIdDiagnostics({
      pluginManifests: duplicateDiagnosticPluginManifests({
        preliminaryDecisions,
        memoryProviderDecision: duplicateCandidateMemoryProviderDecision
      }),
      reservedPluginIds: []
    });
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...duplicateManifestDiagnostics,
    ...baseDiagnostics
  ];

  const memoryProviderDecision = defaultMemoryProviderDecision({
    ...(config?.defaultMemoryProvider === undefined
      ? {}
      : { configDefaultMemoryProvider: config.defaultMemoryProvider }),
    pluginManifests,
    memoryProviderManifests: pluginManifests.filter(
      (manifest) => manifest.kind === 'memory_provider'
    ),
    enabledPluginManifests: preliminaryDecisions
      .filter((preliminary) => preliminary.decision.enabled)
      .map((preliminary) => preliminary.manifest)
  });

  diagnostics.push(...memoryProviderDecision.diagnostics);
  const activationConfigErrors = diagnosticsHaveErrors(diagnostics);

  for (const preliminaryDecision of preliminaryDecisions) {
    const manifest = preliminaryDecision.manifest;
    const memoryDecision = finalizeMemoryProviderActivation({
      manifest,
      decision: preliminaryDecision.decision,
      memoryProviderDecision
    });
    const decision = blockActivationAfterRuntimeConfigErrors({
      decision: memoryDecision,
      configErrors: activationConfigErrors
    });

    if (decision.enabled) {
      enabledPluginIds.push(manifest.id);
    } else {
      disabledPluginIds.push(manifest.id);
    }

    snapshots.push(
      Object.freeze({
        pluginId: manifest.id,
        kind: manifest.kind,
        enabled: decision.enabled,
        requestedAccess: normalizeRuntimePluginAccessMap(
          manifest.requestedAccess,
          `${manifest.id}.requestedAccess`
        ),
        grantedAccess: decision.enabled
          ? normalizeRuntimePluginAccessMap(
              manifest.requestedAccess,
              `${manifest.id}.grantedAccess`
            )
          : Object.freeze({}),
        activationStatus: decision.status,
        activationReasons: Object.freeze([
          ...manifest.activation.reasons,
          ...decision.reasons
        ]),
        diagnostics: Object.freeze(
          diagnostics.filter((diagnostic) =>
            runtimeConfigDiagnosticMatchesPlugin({
              diagnostic,
              pluginId: manifest.id
            })
          )
        )
      } satisfies RuntimePluginActivationSnapshot)
    );
  }

  return Object.freeze({
    enabledPluginIds: Object.freeze(enabledPluginIds),
    disabledPluginIds: Object.freeze(disabledPluginIds),
    plugins: Object.freeze(snapshots),
    diagnostics: Object.freeze(diagnostics),
    ...(memoryProviderDecision.defaultMemoryProvider === undefined
      ? {}
      : { defaultMemoryProvider: memoryProviderDecision.defaultMemoryProvider })
  } satisfies RuntimePluginActivationResult);
}

function hasGlobalRuntimeConfigErrors(options: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly knownPluginIds: ReadonlySet<string>;
}): boolean {
  return options.diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === 'error' &&
      !isKnownPluginRuntimeConfigDiagnostic({
        diagnostic,
        knownPluginIds: options.knownPluginIds
      })
  );
}

function pluginHasRuntimeConfigErrors(options: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly pluginId: string;
}): boolean {
  return options.diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === 'error' &&
      runtimeConfigDiagnosticMatchesPlugin({
        diagnostic,
        pluginId: options.pluginId
      })
  );
}

function isKnownPluginRuntimeConfigDiagnostic(options: {
  readonly diagnostic: RuntimeConfigDiagnostic;
  readonly knownPluginIds: ReadonlySet<string>;
}): boolean {
  for (const pluginId of options.knownPluginIds) {
    if (
      runtimeConfigDiagnosticMatchesPlugin({
        diagnostic: options.diagnostic,
        pluginId
      })
    ) {
      return true;
    }
  }

  return false;
}

async function instantiateRuntimePluginFactories(options: {
  readonly factories: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly enabledPluginIds: readonly string[];
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<readonly RuntimePlugin[]> {
  const plugins: RuntimePlugin[] = [];
  const enabledPluginIds = new Set(options.enabledPluginIds);

  try {
    for (const [pluginId, factory] of Object.entries(options.factories)) {
      if (
        isHostScopedFirstPartyRuntimePluginId(pluginId) ||
        !enabledPluginIds.has(factory.manifest.id)
      ) {
        continue;
      }

      const plugin = await factory.create({
        pluginId: factory.manifest.id,
        storeRoot: options.resolvedConfig.storeRoot,
        resolvedConfig:
          options.resolvedConfig.pluginConfigs[factory.manifest.id] ?? {},
        redactedConfig:
          options.resolvedConfig.redactedPluginConfigs[factory.manifest.id] ?? {}
      });
      plugins.push(plugin);

      if (plugin.manifest.id !== factory.manifest.id) {
        throw new TypeError(
          `Plugin factory "${pluginId}" returned plugin "${plugin.manifest.id}" after declaring manifest "${factory.manifest.id}".`
        );
      }

      if (!runtimePluginManifestsMatch(plugin.manifest, factory.manifest)) {
        throw new TypeError(
          `Plugin factory "${pluginId}" returned a manifest that differs from its declared manifest "${factory.manifest.id}".`
        );
      }
    }
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      plugins,
      resolvedConfig: options.resolvedConfig,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity }),
      ...(options.constructionCleanup === undefined
        ? {}
        : { constructionCleanup: options.constructionCleanup })
    });
    throw error;
  }

  return Object.freeze(plugins);
}

async function cleanupPartiallyInstantiatedPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<void> {
  if (options.plugins.length === 0) {
    return;
  }

  const sessionId =
    options.sessionId ?? configuredPluginConstructionCleanupSessionId;
  const context = createRuntimePluginContext({
    eventId: 'evt_configured_plugin_construction_cleanup',
    traceId: 'trace_configured_plugin_construction_cleanup',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessionId,
    eventType: 'USER_MESSAGE',
    currentUserMessage: configuredPluginConstructionCleanupMessage,
    character: configuredPluginConstructionCleanupCharacter
  });

  try {
    await runRuntimePluginSessionEndHooks({
      plugins: options.plugins,
      context,
      storeRoot: options.resolvedConfig.storeRoot,
      sessionId,
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity }),
      hookOptions: {
        ...options.constructionCleanup,
        ...configuredPluginConstructionCleanupOptions
      }
    });
  } catch {
    // Construction cleanup is best-effort and must not mask the factory or host error.
  }
}

function runtimePluginManifestsMatch(
  actual: RuntimePluginManifest,
  expected: RuntimePluginManifest
): boolean {
  return stableStringify(actual) === stableStringify(expected);
}

function activationPluginManifestsForFactories(
  factories: Readonly<Record<string, RuntimePluginFactoryDefinition>>
): readonly RuntimePluginManifest[] {
  return Object.freeze([
    ...hostScopedCatalogPluginManifests(),
    ...Object.entries(factories)
      .filter(([pluginId]) => !isHostScopedFirstPartyRuntimePluginId(pluginId))
      .map(([, factory]) => factory.manifest)
  ]);
}

function hostScopedCatalogPluginManifests(): readonly RuntimePluginManifest[] {
  return Object.freeze(
    hostScopedFirstPartyRuntimePluginIds.flatMap((pluginId) => {
      const definition = defaultRuntimePluginFactoryDefinitions[pluginId];

      return definition === undefined ? [] : [definition.manifest];
    })
  );
}

function activationDecision(options: {
  readonly configuredEnabled: boolean | undefined;
  readonly defaultEnabled: boolean;
  readonly configErrors: boolean;
}): {
  readonly enabled: boolean;
  readonly status: RuntimePluginActivationStatus;
  readonly reasons: readonly string[];
} {
  if (options.configuredEnabled === false) {
    return {
      enabled: false,
      status: 'disabled',
      reasons: ['disabled_by_config']
    };
  }

  if (options.configErrors) {
    return {
      enabled: false,
      status: 'blocked',
      reasons: ['blocked_by_config_errors']
    };
  }

  if (options.configuredEnabled === true) {
    return {
      enabled: true,
      status: 'active',
      reasons: ['enabled_by_config']
    };
  }

  if (options.defaultEnabled) {
    return {
      enabled: true,
      status: 'active',
      reasons: ['enabled_by_default']
    };
  }

  return {
    enabled: false,
    status: 'disabled',
    reasons: ['not_enabled']
  };
}

function duplicateDiagnosticPluginManifests(options: {
  readonly preliminaryDecisions: readonly {
    readonly manifest: RuntimePluginManifest;
    readonly duplicateCandidateDecision: ReturnType<typeof activationDecision>;
  }[];
  readonly memoryProviderDecision: ReturnType<typeof defaultMemoryProviderDecision>;
}): readonly RuntimePluginManifest[] {
  const activePluginIds = new Set<string>();

  for (const preliminary of options.preliminaryDecisions) {
    const decision = options.memoryProviderDecision.ambiguous
      ? preliminary.duplicateCandidateDecision
      : finalizeMemoryProviderActivation({
          manifest: preliminary.manifest,
          decision: preliminary.duplicateCandidateDecision,
          memoryProviderDecision: options.memoryProviderDecision
        });

    if (decision.enabled) {
      activePluginIds.add(preliminary.manifest.id);
    }
  }

  return Object.freeze(
    options.preliminaryDecisions
      .filter((preliminary) => activePluginIds.has(preliminary.manifest.id))
      .map((preliminary) => preliminary.manifest)
  );
}

function blockActivationAfterRuntimeConfigErrors(options: {
  readonly decision: ReturnType<typeof activationDecision>;
  readonly configErrors: boolean;
}): ReturnType<typeof activationDecision> {
  if (!options.configErrors || !options.decision.enabled) {
    return options.decision;
  }

  return {
    enabled: false,
    status: 'blocked',
    reasons: Object.freeze([
      ...options.decision.reasons,
      'blocked_by_config_errors'
    ])
  };
}

function unknownPluginDiagnostics(options: {
  readonly knownPluginIds: ReadonlySet<string>;
  readonly loadedPlugins: NonNullable<LoadedProject02RuntimeConfig['config']>['plugins'];
  readonly defaultMemoryProviderId?: string;
  readonly strict: boolean;
}): readonly RuntimeConfigDiagnostic[] {
  const unknown = new Map<string, string>();
  const addUnknown = (pluginId: string, path: string): void => {
    if (!options.knownPluginIds.has(pluginId) && !unknown.has(pluginId)) {
      unknown.set(pluginId, path);
    }
  };

  for (const [pluginId, pluginConfig] of Object.entries(
    options.loadedPlugins ?? {}
  )) {
    if (
      pluginConfig.enabled === false &&
      options.defaultMemoryProviderId !== pluginId
    ) {
      continue;
    }

    addUnknown(pluginId, `plugins.${pluginId}`);
  }

  if (options.defaultMemoryProviderId !== undefined) {
    addUnknown(options.defaultMemoryProviderId, 'defaultMemoryProvider');
  }

  return Object.freeze(
    [...unknown].map(([pluginId, path]) =>
      diagnostic(
        options.strict ? 'error' : 'warning',
        'runtime_config_unknown_plugin',
        `Runtime config references unknown plugin "${pluginId}".`,
        path,
        { pluginId }
      )
    )
  );
}

function duplicatePluginManifestIdDiagnostics(options: {
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly reservedPluginIds: readonly string[];
}): readonly RuntimeConfigDiagnostic[] {
  const seen = new Set<string>(options.reservedPluginIds);
  const duplicateIds = new Set<string>();

  for (const manifest of options.pluginManifests) {
    if (seen.has(manifest.id)) {
      duplicateIds.add(manifest.id);
      continue;
    }

    seen.add(manifest.id);
  }

  return Object.freeze(
    [...duplicateIds].map((pluginId) =>
      diagnostic(
        'error',
        'runtime_config_duplicate_plugin_manifest_id',
        `Runtime plugin manifest id "${pluginId}" is declared more than once.`,
        `plugins.${pluginId}`,
        { pluginId }
      )
    )
  );
}

function defaultMemoryProviderDecision(options: {
  readonly configDefaultMemoryProvider?: string;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly memoryProviderManifests: readonly RuntimePluginManifest[];
  readonly enabledPluginManifests: readonly RuntimePluginManifest[];
}): {
  readonly activeMemoryProviderIds: readonly string[];
  readonly ambiguous: boolean;
  readonly defaultMemoryProvider?: string;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
} {
  const enabledMemoryProviders = options.enabledPluginManifests.filter(
    (manifest) => manifest.kind === 'memory_provider'
  );

  if (options.configDefaultMemoryProvider !== undefined) {
    const knownPlugin = options.pluginManifests.find(
      (manifest) => manifest.id === options.configDefaultMemoryProvider
    );
    const knownMemoryProvider = options.memoryProviderManifests.find(
      (manifest) => manifest.id === options.configDefaultMemoryProvider
    );
    const selected = enabledMemoryProviders.find(
      (manifest) => manifest.id === options.configDefaultMemoryProvider
    );

    if (selected === undefined) {
      if (knownPlugin !== undefined && knownPlugin.kind !== 'memory_provider') {
        return {
          activeMemoryProviderIds: [],
          ambiguous: false,
          diagnostics: [
            diagnostic(
              'error',
              'default_memory_provider_not_memory_provider',
              `Default memory provider "${options.configDefaultMemoryProvider}" is a "${knownPlugin.kind}" plugin, not a memory_provider plugin.`,
              'defaultMemoryProvider',
              { pluginId: knownPlugin.id }
            )
          ]
        };
      }

      return {
        activeMemoryProviderIds: [],
        ambiguous: false,
        diagnostics: [
          diagnostic(
            enabledMemoryProviders.length > 0 ||
              knownMemoryProvider !== undefined
              ? 'error'
              : 'warning',
            'default_memory_provider_unavailable',
            `Default memory provider "${options.configDefaultMemoryProvider}" is not active.`,
            'defaultMemoryProvider',
            knownMemoryProvider === undefined
              ? undefined
              : { pluginId: knownMemoryProvider.id }
          )
        ]
      };
    }

    return {
      activeMemoryProviderIds: [selected.id],
      ambiguous: false,
      defaultMemoryProvider: selected.id,
      diagnostics: []
    };
  }

  if (enabledMemoryProviders.length > 1) {
    return {
      activeMemoryProviderIds: [],
      ambiguous: true,
      diagnostics: [
        diagnostic(
          'error',
          'ambiguous_memory_provider_selection',
          'Multiple memory providers are active without defaultMemoryProvider.',
          'defaultMemoryProvider'
        )
      ]
    };
  }

  return {
    activeMemoryProviderIds:
      enabledMemoryProviders[0] === undefined
        ? []
        : [enabledMemoryProviders[0].id],
    ambiguous: false,
    diagnostics: []
  };
}

function finalizeMemoryProviderActivation(options: {
  readonly manifest: RuntimePluginManifest;
  readonly decision: ReturnType<typeof activationDecision>;
  readonly memoryProviderDecision: ReturnType<typeof defaultMemoryProviderDecision>;
}): ReturnType<typeof activationDecision> {
  if (!options.decision.enabled || options.manifest.kind !== 'memory_provider') {
    return options.decision;
  }

  if (
    options.memoryProviderDecision.activeMemoryProviderIds.includes(
      options.manifest.id
    )
  ) {
    return {
      ...options.decision,
      reasons: Object.freeze([
        ...options.decision.reasons,
        ...(options.memoryProviderDecision.defaultMemoryProvider ===
          options.manifest.id &&
        !options.decision.reasons.includes(selectedAsDefaultMemoryProviderReason)
          ? [selectedAsDefaultMemoryProviderReason]
          : [])
      ])
    };
  }

  return {
    enabled: false,
    status: options.memoryProviderDecision.ambiguous ? 'blocked' : 'disabled',
    reasons: Object.freeze([
      ...options.decision.reasons,
      options.memoryProviderDecision.ambiguous
        ? 'ambiguous_memory_provider_selection'
        : 'not_selected_as_default_memory_provider'
    ])
  };
}

function diagnostic(
  severity: RuntimeConfigDiagnostic['severity'],
  code: string,
  message: string,
  path: string,
  metadata?: RuntimeConfigDiagnosticPluginMetadata
): RuntimeConfigDiagnostic {
  const base = {
    severity,
    code,
    message,
    path
  } as const;

  return metadata === undefined
    ? Object.freeze({ ...base, scope: 'global' })
    : Object.freeze({
        ...base,
        scope: 'plugin',
        pluginId: metadata.pluginId,
        ...(metadata.pluginConfigField === undefined
          ? {}
          : { pluginConfigField: metadata.pluginConfigField })
      });
}
