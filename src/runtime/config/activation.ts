import {
  defaultRuntimePluginHostServiceCatalogEntries,
  hostFirstPartyRuntimePluginIds,
  isHostOwnedFirstPartyRuntimePluginId,
  isHostScopedFirstPartyRuntimePluginId,
  type RuntimePluginCatalogEntry
} from '../../plugins/catalog.ts';
import {
  bundledRuntimePluginPackageRoot,
  discoverRuntimePluginPackages,
  type RuntimePluginPackageDiagnostic,
  type RuntimePluginPackageProvenance
} from '../../plugins/package-loader/index.ts';
import type {
  RuntimePluginFactoryDefinition as RuntimePluginFactoryDefinitionContract,
  RuntimePluginFactoryFunction,
  RuntimePluginPackageCatalogEntry
} from '../../plugins/factory.ts';
import type {
  RuntimePluginConfigControlHostState
} from '../../plugins/builtin/runtime-plugin/index.ts';
import type {
  RuntimePluginToolConfirmationHandler
} from '../../plugins/tool-confirmation.ts';
import { runtimePluginId } from '../../plugins/contract.ts';
import {
  createRuntimePluginHost,
  runRuntimePluginSessionEndHooks,
  runRuntimePluginShutdownHooks,
  type RuntimePluginHost,
  type RuntimePluginSessionEndOptions
} from '../../plugins/host.ts';
import {
  createRuntimePluginContext,
  runtimePluginAccessSnapshot,
  type RuntimePluginAccessMap,
  type RuntimePlugin,
  type RuntimePluginKind,
  type RuntimePluginManifest
} from '../../plugins/types.ts';
import { ownJsonRecordValue } from '../../shared/json-boundary.ts';
import type {
  LoadedProject02RuntimeConfig,
  ResolvedProject02RuntimeConfig,
  RuntimeConfigDiagnostic,
  RuntimePluginConfigActivationInspectShape
} from './types.ts';
import { createRuntimeConfigDiagnostic } from './diagnostic.ts';
import {
  diagnosticsHaveErrors,
  runtimeConfigDiagnosticMatchesPlugin,
  resolveProject02RuntimeConfig,
  resolveProject02RuntimeStoreRoot
} from './resolve.ts';
import { canonicalJsonValuesEqual } from '../../shared/canonical-json.ts';
import { createLocalRuntimeStorageLayout } from '../storage/layout.ts';

export type {
  RuntimePluginFactoryFunction,
  RuntimePluginFactoryInput
} from '../../plugins/factory.ts';

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
  readonly packageProvenanceByPluginId: Readonly<
    Record<string, RuntimePluginPackageProvenance>
  >;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState;
};

export type Project02ConfiguredPluginActivation = {
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly activation: RuntimePluginActivationResult;
  readonly packageProvenanceByPluginId: Readonly<
    Record<string, RuntimePluginPackageProvenance>
  >;
};

export type PreparedProject02PluginActivationPlan =
  Project02ConfiguredPluginActivation & {
    readonly catalogEntries: Readonly<
      Record<string, RuntimePluginCatalogEntry>
    >;
    readonly pluginConfigControl: RuntimePluginConfigControlHostState;
  };

export type RuntimePluginCatalogSnapshot = {
  readonly storeRoot: string;
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly defaultEnabledPluginIds: readonly string[];
  readonly packageProvenanceByPluginId: Readonly<
    Record<string, RuntimePluginPackageProvenance>
  >;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
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
const defaultRuntimePluginHostServiceEntries =
  defaultRuntimePluginHostServiceCatalogEntries();

export function createRuntimePluginCatalogSnapshot(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
}): RuntimePluginCatalogSnapshot {
  const storeRoot = resolveProject02RuntimeStoreRoot(options);
  const operatorPackageRoot = createLocalRuntimeStorageLayout({ storeRoot })
    .pluginPackagesRoot;
  const discovery = discoverRuntimePluginPackages({
    sources: [
      {
        root: bundledRuntimePluginPackageRoot,
        provenance: 'bundled'
      },
      {
        root: operatorPackageRoot,
        provenance: 'operator'
      }
    ],
    reservedPluginIds: hostFirstPartyRuntimePluginIds
  });
  const ordinaryPackages = discovery.packages.filter(
    (item) => !isHostScopedFirstPartyRuntimePluginId(item.manifest.id)
  );
  const bundledSystemServiceDiagnostics = discovery.packages
    .filter((item) => isHostScopedFirstPartyRuntimePluginId(item.manifest.id))
    .map(
      (item): RuntimeConfigDiagnostic =>
        Object.freeze({
          severity: 'error',
          code: 'runtime_plugin_package_reserved_system_service_id',
          message: `Bundled runtime plugin package id "${item.manifest.id}" is reserved for a bootstrap system service.`,
          scope: 'plugin',
          pluginId: item.manifest.id
        })
    );
  const packageProvenanceByPluginId = Object.freeze(
    Object.fromEntries(
      ordinaryPackages.map((item) => [item.manifest.id, item.provenance])
    )
  );
  const catalogEntries = Object.freeze({
    ...defaultRuntimePluginHostServiceEntries,
    ...Object.fromEntries(
      ordinaryPackages.map((item) => [item.manifest.id, item])
    )
  });
  const discoveredPluginIds = new Set([
    ...ordinaryPackages.map((item) => item.manifest.id),
    ...Object.keys(defaultRuntimePluginHostServiceEntries)
  ]);
  const defaultEnabledPluginIds = new Set<string>();

  for (const definition of Object.values(
    defaultRuntimePluginHostServiceEntries
  )) {
    if (definition.manifest.activation.defaultEnabled) {
      defaultEnabledPluginIds.add(definition.manifest.id);
    }
  }
  for (const item of ordinaryPackages) {
    if (
      item.provenance === 'bundled' &&
      item.manifest.activation.defaultEnabled
    ) {
      defaultEnabledPluginIds.add(item.manifest.id);
    }
  }

  return Object.freeze({
    storeRoot,
    catalogEntries,
    defaultEnabledPluginIds: Object.freeze([...defaultEnabledPluginIds]),
    packageProvenanceByPluginId,
    diagnostics: Object.freeze([
      ...discovery.diagnostics.map((diagnostic) =>
        runtimePluginPackageDiagnostic({
          diagnostic,
          loadedConfig: options.loadedConfig,
          discoveredPluginIds
        })
      ),
      ...bundledSystemServiceDiagnostics
    ])
  } satisfies RuntimePluginCatalogSnapshot);
}

function composeRuntimePluginCatalog(
  factories: Readonly<Record<string, RuntimePluginFactoryDefinition>>
): {
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly defaultEnabledPluginIds: readonly string[];
} {
  const packageEntries = Object.fromEntries(
    Object.entries(factories)
      .filter(([pluginId]) => !isHostScopedFirstPartyRuntimePluginId(pluginId))
      .map(([pluginId, definition]) => [
        pluginId,
        Object.freeze({
          catalogKind: 'package',
          manifest: definition.manifest,
          load: (input) => definition.create(input)
        } satisfies RuntimePluginPackageCatalogEntry)
      ])
  );
  const catalogEntries = Object.freeze({
    ...defaultRuntimePluginHostServiceEntries,
    ...packageEntries
  });
  const defaultEnabledPluginIds = new Set<string>();

  for (const [pluginId, definition] of Object.entries(
    defaultRuntimePluginHostServiceEntries
  )) {
    if (
      pluginId === definition.manifest.id &&
      isHostOwnedFirstPartyRuntimePluginId(pluginId) &&
      definition.manifest.activation.defaultEnabled
    ) {
      defaultEnabledPluginIds.add(pluginId);
    }
  }
  for (const [pluginId, definition] of Object.entries(packageEntries)) {
    if (
      pluginId === definition.manifest.id &&
      !isHostOwnedFirstPartyRuntimePluginId(pluginId) &&
      definition.manifest.activation.defaultEnabled
    ) {
      defaultEnabledPluginIds.add(pluginId);
    }
  }

  return Object.freeze({
    catalogEntries,
    defaultEnabledPluginIds: Object.freeze([...defaultEnabledPluginIds])
  });
}

export function prepareConfiguredProject02PluginActivation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly strictUnknownPlugins?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
}): PreparedProject02PluginActivationPlan {
  if (options.factories !== undefined && options.catalogSnapshot !== undefined) {
    throw new TypeError(
      'Runtime plugin factories and a catalog snapshot cannot both be provided.'
    );
  }

  const composition = options.factories === undefined
    ? options.catalogSnapshot ?? createRuntimePluginCatalogSnapshot({
        loadedConfig: options.loadedConfig,
        ...(options.storeRoot === undefined
          ? {}
          : { storeRoot: options.storeRoot })
      })
    : Object.freeze({
        storeRoot: resolveProject02RuntimeStoreRoot(options),
        ...composeRuntimePluginCatalog(options.factories),
        packageProvenanceByPluginId: Object.freeze({}),
        diagnostics: Object.freeze([])
      } satisfies RuntimePluginCatalogSnapshot);
  const expectedStoreRoot = resolveProject02RuntimeStoreRoot(options);

  if (composition.storeRoot !== expectedStoreRoot) {
    throw new TypeError(
      'Runtime plugin catalog snapshot does not match the resolved store root.'
    );
  }
  const catalogEntries = Object.freeze({ ...composition.catalogEntries });
  const pluginManifests = activationPluginManifests(catalogEntries);
  const defaultEnabledPluginIds = new Set(composition.defaultEnabledPluginIds);
  const resolvedConfig = resolveProject02RuntimeConfig({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    pluginManifests,
    defaultEnabledPluginIds,
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const activation = resolveRuntimePluginActivation({
    pluginManifests,
    defaultEnabledPluginIds,
    resolvedConfig,
    loadedConfig: options.loadedConfig,
    strictUnknownPlugins: options.strictUnknownPlugins === true,
    catalogDiagnostics: composition.diagnostics
  });

  return Object.freeze({
    catalogEntries,
    packageProvenanceByPluginId: composition.packageProvenanceByPluginId,
    resolvedConfig,
    activation,
    pluginConfigControl: Object.freeze({
      pluginManifests,
      activationByPluginId: runtimePluginConfigActivationByPluginId(activation),
      defaultEnabledPluginIds: Object.freeze([
        ...composition.defaultEnabledPluginIds
      ]),
      ...(resolvedConfig.path === undefined
        ? {}
        : { configPath: resolvedConfig.path }),
      ...(options.env === undefined
        ? {}
        : { env: Object.freeze({ ...options.env }) })
    })
  } satisfies PreparedProject02PluginActivationPlan);
}

function runtimePluginConfigActivationByPluginId(
  activation: RuntimePluginActivationResult
): Readonly<Record<string, RuntimePluginConfigActivationInspectShape>> {
  return Object.freeze(
    Object.fromEntries(
      activation.plugins.map((plugin) => [
        plugin.pluginId,
        Object.freeze({
          enabled: plugin.enabled,
          status: plugin.activationStatus,
          reasons: Object.freeze([...plugin.activationReasons])
        } satisfies RuntimePluginConfigActivationInspectShape)
      ])
    )
  );
}

export async function createConfiguredProject02PluginHost(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly strictUnknownPlugins?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
}): Promise<Project02ConfiguredPluginHost> {
  const activationPlan = prepareConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    strictUnknownPlugins: options.strictUnknownPlugins === true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.factories === undefined ? {} : { factories: options.factories }),
    ...(options.catalogSnapshot === undefined
      ? {}
      : { catalogSnapshot: options.catalogSnapshot })
  });

  return createConfiguredProject02PluginHostFromPlan({
    activationPlan,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    ...(options.constructionCleanup === undefined
      ? {}
      : { constructionCleanup: options.constructionCleanup }),
    ...(options.toolConfirmationHandler === undefined
      ? {}
      : { toolConfirmationHandler: options.toolConfirmationHandler })
  });
}

export async function createConfiguredProject02PluginHostFromPlan(options: {
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
}): Promise<Project02ConfiguredPluginHost> {
  const { activationPlan } = options;
  const { catalogEntries } = activationPlan;

  if (diagnosticsHaveErrors(activationPlan.activation.diagnostics)) {
    const plugins: readonly RuntimePlugin[] = Object.freeze([]);

    return Object.freeze({
      host: createRuntimePluginHost({
        plugins,
        enabledPluginIds: activationPlan.activation.enabledPluginIds,
        storeRoot: activationPlan.resolvedConfig.project02.storeRoot,
        pluginInventoryState: runtimePluginInventoryStateForInvalidConfig(
          activationPlan.pluginConfigControl
        ),
        ...(options.toolConfirmationHandler === undefined
          ? {}
          : { toolConfirmationHandler: options.toolConfirmationHandler }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.sessionIdentity === undefined
          ? {}
          : { sessionIdentity: options.sessionIdentity })
      }),
      plugins,
      resolvedConfig: activationPlan.resolvedConfig,
      activation: activationPlan.activation,
      packageProvenanceByPluginId:
        activationPlan.packageProvenanceByPluginId,
      pluginConfigControl: activationPlan.pluginConfigControl
    } satisfies Project02ConfiguredPluginHost);
  }

  const plugins = await instantiateRuntimePluginPackages({
    catalogEntries,
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
      storeRoot: activationPlan.resolvedConfig.project02.storeRoot,
      pluginConfigControl: activationPlan.pluginConfigControl,
      ...(options.toolConfirmationHandler === undefined
        ? {}
        : { toolConfirmationHandler: options.toolConfirmationHandler }),
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
    activation: activationPlan.activation,
    packageProvenanceByPluginId: activationPlan.packageProvenanceByPluginId,
    pluginConfigControl: activationPlan.pluginConfigControl
  } satisfies Project02ConfiguredPluginHost);
}

export function resolveRuntimePluginActivation(options: {
  readonly plugins?: readonly RuntimePlugin[];
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly defaultEnabledPluginIds?: ReadonlySet<string>;
  readonly catalogDiagnostics?: readonly RuntimeConfigDiagnostic[];
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
      ...(config?.project02?.defaultMemoryProvider === undefined
        ? {}
        : {
            defaultMemoryProviderId:
              config.project02.defaultMemoryProvider
          }),
      strict: options.strictUnknownPlugins === true
    }),
    ...options.resolvedConfig.diagnostics,
    ...(options.catalogDiagnostics ?? [])
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
    const configured = ownJsonRecordValue(config?.plugins, manifest.id);
    const defaultEnabled =
      options.defaultEnabledPluginIds?.has(manifest.id) === true;
    const configErrors =
      !isRuntimePluginInventoryRecoveryManifest(manifest) &&
      (loadedConfigHasErrors ||
        globalConfigErrors ||
        pluginHasRuntimeConfigErrors({
          diagnostics: baseDiagnostics,
          pluginId: manifest.id
        }));

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
    ...(config?.project02?.defaultMemoryProvider === undefined
      ? {}
      : {
          configDefaultMemoryProvider:
            config.project02.defaultMemoryProvider
        }),
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
    ...(config?.project02?.defaultMemoryProvider === undefined
      ? {}
      : {
          configDefaultMemoryProvider:
            config.project02.defaultMemoryProvider
        }),
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
      configErrors:
        activationConfigErrors &&
        !isRuntimePluginInventoryRecoveryManifest(manifest)
    });
    const access = runtimePluginAccessSnapshot({
      requestedAccess: manifest.requestedAccess,
      enabled: decision.enabled,
      fieldPrefix: manifest.id
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
        requestedAccess: access.requestedAccess,
        grantedAccess: access.grantedAccess,
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

async function instantiateRuntimePluginPackages(options: {
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly enabledPluginIds: readonly string[];
  readonly sessionId?: string;
  readonly sessionIdentity?: object;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions;
}): Promise<readonly RuntimePlugin[]> {
  const plugins: RuntimePlugin[] = [];
  const enabledPluginIds = new Set(options.enabledPluginIds);

  try {
    for (const [pluginId, entry] of Object.entries(options.catalogEntries)) {
      if (
        entry.catalogKind === 'host_service' ||
        !enabledPluginIds.has(entry.manifest.id)
      ) {
        continue;
      }

      const plugin = await entry.load({
        pluginId: entry.manifest.id,
        manifest: entry.manifest,
        storeRoot: options.resolvedConfig.project02.storeRoot,
        resolvedConfig: ownJsonRecordValue(
          options.resolvedConfig.pluginConfigs,
          entry.manifest.id
        ) ?? {},
        redactedConfig: ownJsonRecordValue(
          options.resolvedConfig.redactedPluginConfigs,
          entry.manifest.id
        ) ?? {}
      });
      plugins.push(plugin);

      if (plugin.manifest.id !== entry.manifest.id) {
        throw new TypeError(
          `Plugin package loader "${pluginId}" returned plugin "${plugin.manifest.id}" after declaring manifest "${entry.manifest.id}".`
        );
      }

      if (!runtimePluginManifestsMatch(plugin.manifest, entry.manifest)) {
        throw new TypeError(
          `Plugin package loader "${pluginId}" returned a manifest that differs from its declared manifest "${entry.manifest.id}".`
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

function runtimePluginPackageDiagnostic(options: {
  readonly diagnostic: RuntimePluginPackageDiagnostic;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly discoveredPluginIds: ReadonlySet<string>;
}): RuntimeConfigDiagnostic {
  const { diagnostic } = options;
  const diagnosticPluginIds = [
    diagnostic.pluginId,
    diagnostic.claimedPluginId
  ].filter((pluginId): pluginId is string => pluginId !== undefined);
  const configuredPluginId = diagnosticPluginIds.find(
    (pluginId) =>
      ownJsonRecordValue(
        options.loadedConfig.config?.plugins,
        pluginId
      )?.enabled === true
  );
  const pluginId = configuredPluginId ?? diagnostic.pluginId ??
    diagnostic.claimedPluginId;
  const hasDiscoveredWinner = diagnosticPluginIds.some((candidateId) =>
    options.discoveredPluginIds.has(candidateId)
  );
  const severity = diagnostic.provenance === 'bundled' ||
    pluginId === undefined ||
    (configuredPluginId !== undefined && !hasDiscoveredWinner)
    ? 'error'
    : 'warning';
  const base = {
    severity,
    code: `runtime_plugin_package_${diagnostic.code}`,
    message: diagnostic.message,
    path: diagnostic.path
  } as const;

  return pluginId === undefined
    ? Object.freeze({ ...base, scope: 'global' })
    : Object.freeze({
        ...base,
        scope: 'plugin',
        pluginId
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
      storeRoot: options.resolvedConfig.project02.storeRoot,
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

  try {
    await runRuntimePluginShutdownHooks({
      plugins: options.plugins,
      context,
      storeRoot: options.resolvedConfig.project02.storeRoot,
      sessionId,
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity })
    });
  } catch {
    // Shutdown is best-effort and must not mask the factory or host error.
  }
}

function runtimePluginManifestsMatch(
  actual: RuntimePluginManifest,
  expected: RuntimePluginManifest
): boolean {
  return canonicalJsonValuesEqual(actual, expected);
}

function activationPluginManifests(
  catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>
): readonly RuntimePluginManifest[] {
  return Object.freeze(
    Object.values(catalogEntries).map((entry) => entry.manifest)
  );
}

function isRuntimePluginInventoryRecoveryManifest(
  manifest: RuntimePluginManifest
): boolean {
  return (
    defaultRuntimePluginHostServiceEntries[runtimePluginId]?.manifest ===
    manifest
  );
}

function runtimePluginInventoryStateForInvalidConfig(
  state: RuntimePluginConfigControlHostState
): RuntimePluginConfigControlHostState {
  const manifestsById = new Map<string, RuntimePluginManifest>();

  for (const manifest of state.pluginManifests) {
    if (!manifestsById.has(manifest.id)) {
      manifestsById.set(manifest.id, manifest);
    }
  }

  return Object.freeze({
    pluginManifests: Object.freeze([...manifestsById.values()]),
    ...(state.activationByPluginId === undefined
      ? {}
      : { activationByPluginId: state.activationByPluginId }),
    ...(state.defaultEnabledPluginIds === undefined
      ? {}
      : { defaultEnabledPluginIds: state.defaultEnabledPluginIds }),
    ...(state.configPath === undefined ? {} : { configPath: state.configPath }),
    ...(state.env === undefined ? {} : { env: state.env })
  });
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
    addUnknown(options.defaultMemoryProviderId, 'project02.defaultMemoryProvider');
  }

  return Object.freeze(
    [...unknown].map(([pluginId, path]) =>
      createRuntimeConfigDiagnostic(
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
      createRuntimeConfigDiagnostic(
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
            createRuntimeConfigDiagnostic(
              'error',
              'default_memory_provider_not_memory_provider',
              `Default memory provider "${options.configDefaultMemoryProvider}" is a "${knownPlugin.kind}" plugin, not a memory_provider plugin.`,
              'project02.defaultMemoryProvider',
              { pluginId: knownPlugin.id }
            )
          ]
        };
      }

      return {
        activeMemoryProviderIds: [],
        ambiguous: false,
        diagnostics: [
          createRuntimeConfigDiagnostic(
            enabledMemoryProviders.length > 0 ||
              knownMemoryProvider !== undefined
              ? 'error'
              : 'warning',
            'default_memory_provider_unavailable',
            `Default memory provider "${options.configDefaultMemoryProvider}" is not active.`,
            'project02.defaultMemoryProvider',
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
        createRuntimeConfigDiagnostic(
          'error',
          'ambiguous_memory_provider_selection',
          'Multiple memory providers are active without defaultMemoryProvider.',
          'project02.defaultMemoryProvider'
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
