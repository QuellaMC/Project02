import {
  characterStatePluginId,
  createCharacterStatePlugin,
  createCharacterStatePluginManifest
} from '../../plugins/builtin/character-state/index.ts';
import {
  createRuntimePluginHost,
  runRuntimePluginSessionEndHooks,
  runtimePluginDiscoveryPluginId,
  type RuntimePluginHost,
  type RuntimePluginSessionEndOptions
} from '../../plugins/host.ts';
import {
  characterStateDefaultAllowedApis,
  resolveRuntimePluginApiPermissionsForManifest,
  resolveRuntimePluginApiPermissionsForPlugin
} from '../../plugins/api-permissions.ts';
import {
  createRuntimePluginContext,
  type RuntimePluginApiPermissionSnapshot,
  type RuntimePluginApiPermissions,
  type RuntimePlugin,
  type RuntimePluginKind,
  type RuntimePluginManifest
} from '../../plugins/types.ts';
import type {
  LoadedProject02RuntimeConfig,
  RedactedPluginRuntimeConfig,
  ResolvedPluginRuntimeConfig,
  ResolvedProject02RuntimeConfig,
  RuntimeConfigDiagnostic
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

export type RuntimePluginFactoryDefinition = {
  readonly manifest: RuntimePluginManifest;
  readonly create: RuntimePluginFactoryFunction;
};

export type RuntimePluginFactory =
  | RuntimePluginFactoryFunction
  | RuntimePluginFactoryDefinition;

export type RuntimePluginActivationStatus =
  | 'active'
  | 'disabled'
  | 'blocked';

export type RuntimePluginActivationSnapshot = {
  readonly pluginId: string;
  readonly kind: RuntimePluginKind;
  readonly enabled: boolean;
  readonly requestedApis: RuntimePluginApiPermissions;
  readonly allowedApis: RuntimePluginApiPermissions;
  readonly effectiveApis: RuntimePluginApiPermissions;
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
const defaultRuntimePluginFactoryDefinitions = Object.freeze({
  [characterStatePluginId]: Object.freeze({
    manifest: createCharacterStatePluginManifest(),
    create: () => createCharacterStatePlugin()
  } satisfies RuntimePluginFactoryDefinition)
});

export function defaultRuntimePluginFactories(): Readonly<
  Record<string, RuntimePluginFactory>
> {
  return defaultRuntimePluginFactoryDefinitions;
}

function defaultAllowedApisByPluginIdForFactories(
  factories: Readonly<Record<string, RuntimePluginFactory>>
): Readonly<Record<string, RuntimePluginApiPermissions>> {
  const defaultCharacterStateFactory =
    defaultRuntimePluginFactoryDefinitions[characterStatePluginId];
  const hasHostOwnedCharacterStateFactory =
    factories[characterStatePluginId] === defaultCharacterStateFactory;

  if (!hasHostOwnedCharacterStateFactory) {
    return Object.freeze({});
  }

  return Object.freeze({
    [characterStatePluginId]: characterStateDefaultAllowedApis
  });
}

export function resolveConfiguredProject02PluginActivation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly strictUnknownPlugins?: boolean;
  readonly diagnoseUncheckedLegacyFactories?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactory>>;
}): Project02ConfiguredPluginActivation {
  const factories = options.factories ?? defaultRuntimePluginFactories();
  const defaultAllowedApisByPluginId =
    defaultAllowedApisByPluginIdForFactories(factories);
  const legacyFactoryIds = legacyFunctionFactoryIds(factories);
  const disabledLegacyFactoryIds = explicitlyDisabledLegacyFactoryIds({
    factories,
    loadedConfig: options.loadedConfig
  });
  const pluginManifests = manifestBackedPluginManifests(factories);
  const resolvedConfig = resolveProject02RuntimeConfig({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    pluginManifests,
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const activation = resolveRuntimePluginActivation({
    pluginManifests,
    additionalKnownPluginIds: legacyFactoryIds,
    disabledKnownPluginIds: [...disabledLegacyFactoryIds],
    defaultAllowedApisByPluginId,
    uncheckedLegacyFactoryIds:
      options.diagnoseUncheckedLegacyFactories === true ? legacyFactoryIds : [],
    resolvedConfig,
    loadedConfig: options.loadedConfig,
    strictUnknownPlugins: options.strictUnknownPlugins === true
  });

  return Object.freeze({
    resolvedConfig,
    activation
  } satisfies Project02ConfiguredPluginActivation);
}

export async function createConfiguredProject02PluginHost(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly strictUnknownPlugins?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactory>>;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<Project02ConfiguredPluginHost> {
  const factories = options.factories ?? defaultRuntimePluginFactories();
  const defaultAllowedApisByPluginId =
    defaultAllowedApisByPluginIdForFactories(factories);
  const legacyFactoryIds = legacyFunctionFactoryIds(factories);
  const activationPlan = resolveConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    strictUnknownPlugins: options.strictUnknownPlugins === true,
    diagnoseUncheckedLegacyFactories: true,
    ...(options.env === undefined ? {} : { env: options.env }),
    factories
  });

  if (diagnosticsHaveErrors(activationPlan.activation.diagnostics)) {
    const plugins: readonly RuntimePlugin[] = Object.freeze([]);

    return Object.freeze({
      host: createRuntimePluginHost({
        plugins,
        enabledPluginIds: activationPlan.activation.enabledPluginIds,
        allowedApisByPluginId: activationPlan.resolvedConfig.allowedApisByPluginId,
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

  const initialStoreRoot = activationPlan.resolvedConfig.storeRoot;
  const loadedConfigHasErrors = diagnosticsHaveErrors(options.loadedConfig.diagnostics);
  const disabledLegacyFactoryIds = explicitlyDisabledLegacyFactoryIds({
    factories,
    loadedConfig: options.loadedConfig
  });
  const selectedLegacyFactoryIdsSet = selectedLegacyFactoryIds({
    factories,
    loadedConfig: options.loadedConfig
  });
  const preparedFactories = await prepareRuntimePluginFactories({
    factories,
    storeRoot: initialStoreRoot,
    skipLegacyFactoryCreation: loadedConfigHasErrors,
    disabledLegacyFactoryIds,
    selectedLegacyFactoryIds: selectedLegacyFactoryIdsSet,
    resolvedConfig: activationPlan.resolvedConfig,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    ...(options.constructionCleanup === undefined
      ? {}
      : { constructionCleanup: options.constructionCleanup })
  });
  const resolvedConfig = resolveProject02RuntimeConfig({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    pluginManifests: preparedFactories.map((factory) => factory.manifest),
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const activation = resolveRuntimePluginActivation({
    pluginManifests: preparedFactories.map((factory) => factory.manifest),
    additionalKnownPluginIds: legacyFactoryIds,
    disabledKnownPluginIds: [...disabledLegacyFactoryIds],
    defaultAllowedApisByPluginId,
    resolvedConfig,
    loadedConfig: options.loadedConfig,
    strictUnknownPlugins: options.strictUnknownPlugins === true
  });
  const plugins = await instantiatePreparedPlugins({
    preparedFactories,
    resolvedConfig,
    enabledPluginIds: activation.enabledPluginIds,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    ...(options.constructionCleanup === undefined
      ? {}
      : { constructionCleanup: options.constructionCleanup })
  });
  const finalActivation = resolveRuntimePluginActivation({
    plugins,
    pluginManifests: preparedFactories.map((factory) => factory.manifest),
    additionalKnownPluginIds: legacyFactoryIds,
    disabledKnownPluginIds: [...disabledLegacyFactoryIds],
    defaultAllowedApisByPluginId,
    resolvedConfig,
    loadedConfig: options.loadedConfig,
    strictUnknownPlugins: options.strictUnknownPlugins === true
  });
  let host: RuntimePluginHost;

  try {
    host = createRuntimePluginHost({
      plugins,
      enabledPluginIds: finalActivation.enabledPluginIds,
      allowedApisByPluginId: resolvedConfig.allowedApisByPluginId,
      storeRoot: resolvedConfig.storeRoot,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity })
    });
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      plugins,
      resolvedConfig,
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
    resolvedConfig,
    activation: finalActivation
  } satisfies Project02ConfiguredPluginHost);
}

export function resolveRuntimePluginActivation(options: {
  readonly plugins?: readonly RuntimePlugin[];
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly additionalKnownPluginIds?: readonly string[];
  readonly disabledKnownPluginIds?: readonly string[];
  readonly defaultAllowedApisByPluginId?: Readonly<Record<string, RuntimePluginApiPermissions>>;
  readonly uncheckedLegacyFactoryIds?: readonly string[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly strictUnknownPlugins?: boolean;
}): RuntimePluginActivationResult {
  const pluginManifests =
    options.pluginManifests ?? options.plugins?.map((plugin) => plugin.manifest) ?? [];
  const runtimePluginsByPluginId = new Map(
    (options.plugins ?? []).map((plugin) => [plugin.manifest.id, plugin])
  );
  const config = options.loadedConfig.config;
  const pluginIds = new Set([
    ...pluginManifests.map((manifest) => manifest.id),
    ...(options.additionalKnownPluginIds ?? []),
    ...(options.disabledKnownPluginIds ?? [])
  ]);
  const baseDiagnostics: readonly RuntimeConfigDiagnostic[] = Object.freeze([
    ...unknownPluginDiagnostics({
      knownPluginIds: pluginIds,
      loadedPlugins: config?.plugins ?? {},
      legacyEnabledPluginIds: config?.enabledPlugins ?? [],
      ...(config?.defaultMemoryProvider === undefined
        ? {}
        : { defaultMemoryProviderId: config.defaultMemoryProvider }),
      strict: options.strictUnknownPlugins === true
    }),
    ...uncheckedLegacyFactoryDiagnostics({
      loadedConfig: options.loadedConfig,
      legacyFactoryIds: options.uncheckedLegacyFactoryIds ?? []
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
    const legacyEnabled =
      config?.enabledPlugins?.includes(manifest.id) === true;
    const selectedAsDefaultMemoryProvider =
      manifest.kind === 'memory_provider' &&
      config?.defaultMemoryProvider === manifest.id;
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
        legacyEnabled,
        selectedAsDefaultMemoryProvider,
        defaultEnabled: manifest.activation.defaultEnabled,
        configErrors: false
      }),
      decision: activationDecision({
        configuredEnabled: configured?.enabled,
        legacyEnabled,
        selectedAsDefaultMemoryProvider,
        defaultEnabled: manifest.activation.defaultEnabled,
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
      .map((preliminary) => preliminary.manifest),
    disabledKnownPluginIds: options.disabledKnownPluginIds ?? []
  });
  const duplicateManifestDiagnostics =
    duplicatePluginManifestIdDiagnostics({
      pluginManifests: duplicateDiagnosticPluginManifests({
        preliminaryDecisions,
        memoryProviderDecision: duplicateCandidateMemoryProviderDecision
      }),
      reservedPluginIds: [runtimePluginDiscoveryPluginId]
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
      .map((preliminary) => preliminary.manifest),
    disabledKnownPluginIds: options.disabledKnownPluginIds ?? []
  });

  diagnostics.push(...memoryProviderDecision.diagnostics);
  const activationConfigErrors = diagnosticsHaveErrors(diagnostics);

  for (const preliminaryDecision of preliminaryDecisions) {
    const manifest = preliminaryDecision.manifest;
    const runtimePlugin = runtimePluginsByPluginId.get(manifest.id);
    const defaultAllowedApis = options.defaultAllowedApisByPluginId?.[manifest.id];
    const apiPermissions = resolveActivationApiPermissions({
      manifest,
      explicitAllowedApisByPluginId: options.resolvedConfig.allowedApisByPluginId,
      ...(runtimePlugin === undefined ? {} : { plugin: runtimePlugin }),
      ...(defaultAllowedApis === undefined ? {} : { defaultAllowedApis })
    });
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
        requestedApis: apiPermissions.requestedApis,
        allowedApis: apiPermissions.allowedApis,
        effectiveApis: apiPermissions.effectiveApis,
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

function resolveActivationApiPermissions(options: {
  readonly manifest: RuntimePluginManifest;
  readonly plugin?: RuntimePlugin;
  readonly explicitAllowedApisByPluginId: Readonly<
    Record<string, RuntimePluginApiPermissions>
  >;
  readonly defaultAllowedApis?: RuntimePluginApiPermissions;
}): RuntimePluginApiPermissionSnapshot {
  if (
    options.plugin !== undefined &&
    runtimePluginManifestsMatch(options.plugin.manifest, options.manifest)
  ) {
    return resolveRuntimePluginApiPermissionsForPlugin({
      plugin: options.plugin,
      explicitAllowedApisByPluginId: options.explicitAllowedApisByPluginId
    });
  }

  return resolveRuntimePluginApiPermissionsForManifest({
    manifest: options.manifest,
    explicitAllowedApisByPluginId: options.explicitAllowedApisByPluginId,
    ...(options.defaultAllowedApis === undefined
      ? {}
      : { defaultAllowedApis: options.defaultAllowedApis })
  });
}

type PreparedRuntimePluginFactory =
  | {
      readonly kind: 'manifest_backed_factory';
      readonly pluginId: string;
      readonly manifest: RuntimePluginManifest;
      readonly create: RuntimePluginFactoryFunction;
    }
  | {
      readonly kind: 'legacy_prepared_plugin';
      readonly pluginId: string;
      readonly manifest: RuntimePluginManifest;
      readonly plugin: RuntimePlugin;
    };

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

async function prepareRuntimePluginFactories(options: {
  readonly factories: Readonly<Record<string, RuntimePluginFactory>>;
  readonly storeRoot: string;
  readonly skipLegacyFactoryCreation: boolean;
  readonly disabledLegacyFactoryIds: ReadonlySet<string>;
  readonly selectedLegacyFactoryIds: ReadonlySet<string>;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<readonly PreparedRuntimePluginFactory[]> {
  const preparedFactories: PreparedRuntimePluginFactory[] = [];

  try {
    for (const [pluginId, factory] of Object.entries(options.factories)) {
      if (isRuntimePluginFactoryDefinition(factory)) {
        preparedFactories.push(
          Object.freeze({
            kind: 'manifest_backed_factory',
            pluginId,
            manifest: factory.manifest,
            create: factory.create
          } satisfies PreparedRuntimePluginFactory)
        );
        continue;
      }

      if (options.skipLegacyFactoryCreation) {
        continue;
      }

      if (options.disabledLegacyFactoryIds.has(pluginId)) {
        continue;
      }

      if (!options.selectedLegacyFactoryIds.has(pluginId)) {
        continue;
      }

      const plugin = await factory({
        pluginId,
        storeRoot: options.storeRoot,
        resolvedConfig: {},
        redactedConfig: {}
      });

      preparedFactories.push(
        Object.freeze({
          kind: 'legacy_prepared_plugin',
          pluginId,
          manifest: plugin.manifest,
          plugin
        } satisfies PreparedRuntimePluginFactory)
      );
    }
  } catch (error: unknown) {
    await cleanupPreparedLegacyPlugins({
      preparedFactories,
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

  return Object.freeze(preparedFactories);
}

async function instantiatePreparedPlugins(options: {
  readonly preparedFactories: readonly PreparedRuntimePluginFactory[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly enabledPluginIds: readonly string[];
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<readonly RuntimePlugin[]> {
  const plugins: RuntimePlugin[] = [];
  const createdPlugins: RuntimePlugin[] = [];
  const inactivePreparedLegacyPlugins: RuntimePlugin[] = [];
  const enabledPluginIds = new Set(options.enabledPluginIds);

  try {
    for (const preparedFactory of options.preparedFactories) {
      if (!enabledPluginIds.has(preparedFactory.manifest.id)) {
        if (preparedFactory.kind === 'legacy_prepared_plugin') {
          inactivePreparedLegacyPlugins.push(preparedFactory.plugin);
        }

        continue;
      }

      if (preparedFactory.kind === 'legacy_prepared_plugin') {
        createdPlugins.push(preparedFactory.plugin);
        plugins.push(preparedFactory.plugin);
        continue;
      }

      const plugin = await preparedFactory.create({
        pluginId: preparedFactory.manifest.id,
        storeRoot: options.resolvedConfig.storeRoot,
        resolvedConfig:
          options.resolvedConfig.pluginConfigs[preparedFactory.manifest.id] ?? {},
        redactedConfig:
          options.resolvedConfig.redactedPluginConfigs[preparedFactory.manifest.id] ?? {}
      });
      createdPlugins.push(plugin);

      if (plugin.manifest.id !== preparedFactory.manifest.id) {
        throw new TypeError(
          `Plugin factory "${preparedFactory.pluginId}" returned plugin "${plugin.manifest.id}" after declaring manifest "${preparedFactory.manifest.id}".`
        );
      }

      if (!runtimePluginManifestsMatch(plugin.manifest, preparedFactory.manifest)) {
        throw new TypeError(
          `Plugin factory "${preparedFactory.pluginId}" returned a manifest that differs from its declared manifest "${preparedFactory.manifest.id}".`
        );
      }

      plugins.push(plugin);
    }
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      plugins: [...inactivePreparedLegacyPlugins, ...createdPlugins],
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

  await cleanupPartiallyInstantiatedPlugins({
    plugins: inactivePreparedLegacyPlugins,
    resolvedConfig: options.resolvedConfig,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    ...(options.constructionCleanup === undefined
      ? {}
      : { constructionCleanup: options.constructionCleanup })
  });

  return Object.freeze(plugins);
}

async function cleanupPreparedLegacyPlugins(options: {
  readonly preparedFactories: readonly PreparedRuntimePluginFactory[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<void> {
  await cleanupPartiallyInstantiatedPlugins({
    plugins: options.preparedFactories
      .filter(isPreparedLegacyPlugin)
      .map((preparedFactory) => preparedFactory.plugin),
    resolvedConfig: options.resolvedConfig,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    ...(options.constructionCleanup === undefined
      ? {}
      : { constructionCleanup: options.constructionCleanup })
  });
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
      allowedApisByPluginId: options.resolvedConfig.allowedApisByPluginId,
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

function isRuntimePluginFactoryDefinition(
  factory: RuntimePluginFactory
): factory is RuntimePluginFactoryDefinition {
  return typeof factory !== 'function';
}

function manifestBackedPluginManifests(
  factories: Readonly<Record<string, RuntimePluginFactory>>
): readonly RuntimePluginManifest[] {
  return Object.freeze(
    Object.values(factories)
      .filter(isRuntimePluginFactoryDefinition)
      .map((factory) => factory.manifest)
  );
}

function legacyFunctionFactoryIds(
  factories: Readonly<Record<string, RuntimePluginFactory>>
): readonly string[] {
  return Object.freeze(
    Object.entries(factories)
      .filter(([, factory]) => !isRuntimePluginFactoryDefinition(factory))
      .map(([pluginId]) => pluginId)
  );
}

function isPreparedLegacyPlugin(
  preparedFactory: PreparedRuntimePluginFactory
): preparedFactory is Extract<
  PreparedRuntimePluginFactory,
  { readonly kind: 'legacy_prepared_plugin' }
> {
  return preparedFactory.kind === 'legacy_prepared_plugin';
}

function explicitlyDisabledLegacyFactoryIds(options: {
  readonly factories: Readonly<Record<string, RuntimePluginFactory>>;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
}): ReadonlySet<string> {
  const disabledPluginIds = new Set<string>();

  for (const pluginId of legacyFunctionFactoryIds(options.factories)) {
    if (
      legacyFactorySelection({
        loadedConfig: options.loadedConfig,
        pluginId
      }).disabledByConfig
    ) {
      disabledPluginIds.add(pluginId);
    }
  }

  return disabledPluginIds;
}

function selectedLegacyFactoryIds(options: {
  readonly factories: Readonly<Record<string, RuntimePluginFactory>>;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
}): ReadonlySet<string> {
  const selectedPluginIds = new Set<string>();

  for (const pluginId of legacyFunctionFactoryIds(options.factories)) {
    const selection = legacyFactorySelection({
      loadedConfig: options.loadedConfig,
      pluginId
    });

    if (!selection.disabledByConfig && selection.selected) {
      selectedPluginIds.add(pluginId);
    }
  }

  return selectedPluginIds;
}

function uncheckedLegacyFactoryDiagnostics(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly legacyFactoryIds: readonly string[];
}): readonly RuntimeConfigDiagnostic[] {
  if (options.legacyFactoryIds.length === 0) {
    return Object.freeze([]);
  }

  const diagnostics: RuntimeConfigDiagnostic[] = [];

  for (const pluginId of options.legacyFactoryIds) {
    const selection = legacyFactorySelection({
      loadedConfig: options.loadedConfig,
      pluginId
    });

    if (selection.disabledByConfig) {
      continue;
    }

    if (!selection.selected) {
      continue;
    }

    diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_legacy_factory_unchecked',
        `Runtime config enables legacy function plugin factory "${pluginId}", but activation checks require a manifest-backed factory to validate plugin config.`,
        legacyFactoryDiagnosticPath({
          pluginId,
          enabledByPluginConfig: selection.enabledByPluginConfig,
          enabledByLegacyList: selection.enabledByLegacyList,
          selectedAsDefaultMemoryProvider:
            selection.selectedAsDefaultMemoryProvider
        }),
        { pluginId }
      )
    );
  }

  return Object.freeze(diagnostics);
}

function legacyFactorySelection(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly pluginId: string;
}): {
  readonly disabledByConfig: boolean;
  readonly enabledByPluginConfig: boolean;
  readonly enabledByLegacyList: boolean;
  readonly selectedAsDefaultMemoryProvider: boolean;
  readonly selected: boolean;
} {
  const config = options.loadedConfig.config;
  const configuredPlugin = config?.plugins?.[options.pluginId];
  const enabledByPluginConfig = configuredPlugin?.enabled === true;
  const enabledByLegacyList =
    config?.enabledPlugins?.includes(options.pluginId) === true;
  const selectedAsDefaultMemoryProvider =
    config?.defaultMemoryProvider === options.pluginId;

  return Object.freeze({
    disabledByConfig: configuredPlugin?.enabled === false,
    enabledByPluginConfig,
    enabledByLegacyList,
    selectedAsDefaultMemoryProvider,
    selected:
      enabledByPluginConfig ||
      enabledByLegacyList ||
      selectedAsDefaultMemoryProvider
  });
}

function legacyFactoryDiagnosticPath(options: {
  readonly pluginId: string;
  readonly enabledByPluginConfig: boolean;
  readonly enabledByLegacyList: boolean;
  readonly selectedAsDefaultMemoryProvider: boolean;
}): string {
  if (options.enabledByPluginConfig) {
    return `plugins.${options.pluginId}.enabled`;
  }

  if (options.enabledByLegacyList) {
    return 'enabledPlugins';
  }

  if (options.selectedAsDefaultMemoryProvider) {
    return 'defaultMemoryProvider';
  }

  return `plugins.${options.pluginId}.enabled`;
}

function activationDecision(options: {
  readonly configuredEnabled: boolean | undefined;
  readonly legacyEnabled: boolean;
  readonly selectedAsDefaultMemoryProvider: boolean;
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

  if (options.legacyEnabled) {
    return {
      enabled: true,
      status: 'active',
      reasons: ['enabled_by_legacy_config']
    };
  }

  if (options.selectedAsDefaultMemoryProvider) {
    return {
      enabled: true,
      status: 'active',
      reasons: [selectedAsDefaultMemoryProviderReason]
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
  readonly legacyEnabledPluginIds: readonly string[];
  readonly defaultMemoryProviderId?: string;
  readonly strict: boolean;
}): readonly RuntimeConfigDiagnostic[] {
  const unknown = new Map<string, string>();
  const legacyEnabledPluginIds = new Set(options.legacyEnabledPluginIds);
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
      !legacyEnabledPluginIds.has(pluginId) &&
      options.defaultMemoryProviderId !== pluginId
    ) {
      continue;
    }

    addUnknown(pluginId, `plugins.${pluginId}`);
  }

  for (const pluginId of legacyEnabledPluginIds) {
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
        path
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
  readonly disabledKnownPluginIds: readonly string[];
}): {
  readonly activeMemoryProviderIds: readonly string[];
  readonly ambiguous: boolean;
  readonly defaultMemoryProvider?: string;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
} {
  const enabledMemoryProviders = options.enabledPluginManifests.filter(
    (manifest) => manifest.kind === 'memory_provider'
  );
  const disabledKnownPluginIds = new Set(options.disabledKnownPluginIds);

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
    const disabledKnownPlugin = disabledKnownPluginIds.has(
      options.configDefaultMemoryProvider
    );
    const unavailablePluginId = disabledKnownPlugin
      ? options.configDefaultMemoryProvider
      : knownMemoryProvider?.id;

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
              knownMemoryProvider !== undefined ||
              disabledKnownPlugin
              ? 'error'
              : 'warning',
            'default_memory_provider_unavailable',
            `Default memory provider "${options.configDefaultMemoryProvider}" is not active.`,
            'defaultMemoryProvider',
            unavailablePluginId === undefined ? {} : { pluginId: unavailablePluginId }
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
  metadata: {
    readonly pluginId?: string;
    readonly pluginConfigField?: string;
  } = {}
): RuntimeConfigDiagnostic {
  return Object.freeze({
    severity,
    code,
    message,
    path,
    ...(metadata.pluginId === undefined ? {} : { pluginId: metadata.pluginId }),
    ...(metadata.pluginConfigField === undefined
      ? {}
      : { pluginConfigField: metadata.pluginConfigField })
  } satisfies RuntimeConfigDiagnostic);
}
