import {
  createProject02HomeLayout,
  createRuntimePluginFileStore,
  createRuntimePluginFileStoreTransaction,
  LocalRuntimeStorageContractError,
  requireCharacterDataMarker,
  type RuntimePluginFileStoreProvider,
} from '../runtime/storage/index.ts';
import {
  createRuntimePluginContext,
  createRuntimePluginHost,
  hostFirstPartyRuntimePluginIds,
  isHostScopedFirstPartyRuntimePluginId,
  runRuntimePluginSessionEndHooks,
  runRuntimePluginShutdownHooks,
  runtimePluginAccessSnapshot,
  runtimePluginId,
  type RuntimePlugin,
  type RuntimePluginAccessMap,
  type RuntimePluginCatalogEntry,
  type RuntimePluginConfigControlHostState,
  type RuntimePluginInventoryHostState,
  type RuntimePluginHost,
  type RuntimePluginKind,
  type RuntimePluginManifest,
  type RuntimePluginSessionEndOptions,
  type RuntimePluginToolConfirmationHandler,
} from '../plugins/index.ts';
import {
  bundledRuntimePluginPackageRoot,
  discoverRuntimePluginPackages,
  type RuntimePluginPackageDiagnostic,
  type RuntimePluginPackageProvenance,
} from '../plugins/package-loader/index.ts';
import {ownJsonRecordValue} from '../shared/json-boundary.ts';
import {
  createRuntimeConfigDiagnostic,
  createRuntimeConfigMutationBase,
  createRuntimePluginConfigControlCapability,
  diagnosticsHaveErrors,
  layeredRuntimeConfigFingerprintForScope,
  mergedLoadedConfigForOverlay,
  readCharacterOverlayForScope,
  resolveLayeredProject02RuntimeConfig,
  runtimeConfigDiagnosticMatchesPlugin,
  type LoadedProject02CharacterOverlayConfig,
  type LoadedProject02RuntimeConfig,
  type ResolvedProject02RuntimeLocation,
  type ResolvedProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimePluginConfigActivationInspectShape,
} from '../runtime/config/index.ts';
import {canonicalJsonValuesEqual} from '../shared/canonical-json.ts';
import {createConfiguredRuntimePluginReloader} from './plugin-reload.ts';
import {
  composeRuntimePluginCatalog,
  defaultRuntimePluginHostServiceEntries,
  type RuntimePluginFactoryDefinition,
} from './plugin-catalog.ts';

export type {
  RuntimePluginFactoryFunction,
  RuntimePluginFactoryInput,
} from '../plugins/index.ts';
export type {RuntimePluginFactoryDefinition} from './plugin-catalog.ts';

export type RuntimePluginActivationStatus = 'active' | 'disabled' | 'blocked';

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
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
};

export type Project02ConfiguredPluginActivation = {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
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
    /** Fingerprint of the authored config this plan's plugins are built from. */
    readonly authoredConfigFingerprint: string;
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

/**
 * One immutable filesystem discovery, classified per config layer:
 * package scanning is config-free, so a startup discovers once and
 * re-classifies the same manifests against each layer state instead of
 * re-scanning — package defaults and final activation then always
 * judge one manifest snapshot.
 */
export type RuntimePluginCatalogDiscovery = {
  readonly storeRoot: string;
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly defaultEnabledPluginIds: readonly string[];
  readonly packageProvenanceByPluginId: Readonly<
    Record<string, RuntimePluginPackageProvenance>
  >;
  /** Raw package diagnostics awaiting per-layer severity classification. */
  readonly packageDiagnostics: readonly RuntimePluginPackageDiagnostic[];
  /** Config-independent catalog errors (reserved system-service ids). */
  readonly reservedIdDiagnostics: readonly RuntimeConfigDiagnostic[];
  readonly discoveredPluginIds: ReadonlySet<string>;
};

// The host must not import the file-store engine (arch rule: plugins never
// value-import runtime storage); the composition root supplies it instead.
const configuredRuntimePluginFileStoreProvider: RuntimePluginFileStoreProvider =
  Object.freeze({
    createFileStore: createRuntimePluginFileStore,
    createFileStoreTransaction: createRuntimePluginFileStoreTransaction,
  });

const configuredPluginConstructionCleanupSessionId =
  'configured-plugin-construction-cleanup';
const configuredPluginConstructionCleanupMessage =
  'configured plugin construction failed before host creation';
const configuredPluginConstructionCleanupCharacter = Object.freeze({
  id: 'project02-runtime-config',
  displayName: 'Project02 Runtime Config',
});
const configuredPluginConstructionCleanupOptions = Object.freeze({
  allowFileStoreWrites: false,
} satisfies RuntimePluginSessionEndOptions);
const selectedAsDefaultMemoryProviderReason =
  'selected_as_default_memory_provider';

export function createRuntimePluginCatalogSnapshot(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  /**
   * Test or embedding overrides extend the discovered catalog instead of
   * replacing it. Character-package requirements must keep seeing bundled
   * and operator-installed plugins on every startup path.
   */
  readonly factoryOverrides?: Readonly<
    Record<string, RuntimePluginFactoryDefinition>
  >;
  /**
   * When present, package diagnostics are classified against the merged
   * two-layer view: an overlay-enabled broken package is as much an
   * error as a globally enabled one.
   */
  readonly overlayConfig?: LoadedProject02CharacterOverlayConfig;
}): RuntimePluginCatalogSnapshot {
  return classifyRuntimePluginCatalogDiscovery({
    discovery: discoverRuntimePluginCatalog({
      storeRoot: options.runtimeLocation.homeRoot,
      ...(options.factoryOverrides === undefined
        ? {}
        : {factoryOverrides: options.factoryOverrides}),
    }),
    classificationConfig:
      options.overlayConfig === undefined
        ? options.loadedConfig
        : mergedLoadedConfigForOverlay(
            options.loadedConfig,
            options.overlayConfig,
          ),
  });
}

export function discoverRuntimePluginCatalog(options: {
  /** The resolved home; installed packages live at the home level. */
  readonly storeRoot: string;
  readonly factoryOverrides?: Readonly<
    Record<string, RuntimePluginFactoryDefinition>
  >;
}): RuntimePluginCatalogDiscovery {
  const operatorPackageRoot = createProject02HomeLayout({
    homeRoot: options.storeRoot,
  }).pluginPackagesRoot;
  const discovery = discoverRuntimePluginPackages({
    sources: [
      {
        root: bundledRuntimePluginPackageRoot,
        provenance: 'bundled',
      },
      {
        root: operatorPackageRoot,
        provenance: 'operator',
      },
    ],
    reservedPluginIds: hostFirstPartyRuntimePluginIds,
  });
  const ordinaryPackages = discovery.packages.filter(
    item => !isHostScopedFirstPartyRuntimePluginId(item.manifest.id),
  );
  const reservedIdDiagnostics = discovery.packages
    .filter(item => isHostScopedFirstPartyRuntimePluginId(item.manifest.id))
    .map((item): RuntimeConfigDiagnostic =>
      Object.freeze({
        severity: 'error',
        code: 'runtime_plugin_package_reserved_system_service_id',
        message: `Bundled runtime plugin package id "${item.manifest.id}" is reserved for a bootstrap system service.`,
        scope: 'plugin',
        pluginId: item.manifest.id,
      }),
    );
  const composition = composeRuntimePluginCatalog({
    discoveredPackages: ordinaryPackages,
    ...(options.factoryOverrides === undefined
      ? {}
      : {factories: options.factoryOverrides}),
  });

  return Object.freeze({
    storeRoot: options.storeRoot,
    catalogEntries: composition.catalogEntries,
    defaultEnabledPluginIds: composition.defaultEnabledPluginIds,
    packageProvenanceByPluginId: Object.freeze(
      Object.fromEntries(
        ordinaryPackages.map(item => [item.manifest.id, item.provenance]),
      ),
    ),
    packageDiagnostics: discovery.diagnostics,
    reservedIdDiagnostics: Object.freeze(reservedIdDiagnostics),
    discoveredPluginIds: new Set([
      ...ordinaryPackages.map(item => item.manifest.id),
      ...Object.keys(defaultRuntimePluginHostServiceEntries),
      ...Object.keys(options.factoryOverrides ?? {}),
    ]),
  } satisfies RuntimePluginCatalogDiscovery);
}

/**
 * Severity classification of one discovery against one config layer
 * view: an overlay-enabled broken package is as much an error as a
 * globally enabled one, and the same discovery re-classifies cheaply
 * as the layer state changes.
 */
export function classifyRuntimePluginCatalogDiscovery(options: {
  readonly discovery: RuntimePluginCatalogDiscovery;
  readonly classificationConfig: LoadedProject02RuntimeConfig;
}): RuntimePluginCatalogSnapshot {
  const {discovery} = options;

  return Object.freeze({
    storeRoot: discovery.storeRoot,
    catalogEntries: discovery.catalogEntries,
    defaultEnabledPluginIds: discovery.defaultEnabledPluginIds,
    packageProvenanceByPluginId: discovery.packageProvenanceByPluginId,
    diagnostics: Object.freeze([
      ...discovery.packageDiagnostics.map(diagnostic =>
        runtimePluginPackageDiagnostic({
          diagnostic,
          loadedConfig: options.classificationConfig,
          discoveredPluginIds: discovery.discoveredPluginIds,
        }),
      ),
      ...discovery.reservedIdDiagnostics,
    ]),
  } satisfies RuntimePluginCatalogSnapshot);
}

export function prepareConfiguredProject02PluginActivation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly overlayConfig?: LoadedProject02CharacterOverlayConfig;
  readonly strictUnknownPlugins?: boolean;
  readonly validateInactivePluginConfigs?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
}): PreparedProject02PluginActivationPlan {
  if (
    options.factories !== undefined &&
    options.catalogSnapshot !== undefined
  ) {
    throw new TypeError(
      'Runtime plugin factories and a catalog snapshot cannot both be provided.',
    );
  }

  // One character scope and one overlay snapshot feed the catalog
  // classification, the layered resolve, the construction snapshot, and
  // the control state, so every downstream site composes the same pair
  // of documents — including direct callers that never went through
  // startup. A supplied overlay is the scope authority: its character
  // id may be a flag override the loaded config knows nothing about.
  const characterScope = options.runtimeLocation.characterScope;
  if (
    options.overlayConfig !== undefined &&
    options.overlayConfig.characterId !== characterScope.characterId
  ) {
    throw new TypeError(
      'Runtime character overlay does not match the resolved runtime location.',
    );
  }
  const overlayConfig =
    options.overlayConfig ??
    readCharacterOverlayForScope(characterScope).overlay;
  const composition = activationCatalogComposition({
    ...options,
    overlayConfig,
  });
  const expectedStoreRoot = options.runtimeLocation.homeRoot;

  if (composition.storeRoot !== expectedStoreRoot) {
    throw new TypeError(
      'Runtime plugin catalog snapshot does not match the resolved store root.',
    );
  }
  const catalogEntries = Object.freeze({...composition.catalogEntries});
  const pluginManifests = activationPluginManifests(catalogEntries);
  const defaultEnabledPluginIds = new Set(composition.defaultEnabledPluginIds);
  const resolvedConfig = resolveLayeredProject02RuntimeConfig({
    loadedConfig: options.loadedConfig,
    runtimeLocation: options.runtimeLocation,
    overlayConfig,
    pluginManifests,
    defaultEnabledPluginIds,
    validateInactivePluginConfigs:
      options.validateInactivePluginConfigs === true,
    ...(options.env === undefined ? {} : {env: options.env}),
  });
  const activation = resolveRuntimePluginActivation({
    pluginManifests,
    defaultEnabledPluginIds,
    resolvedConfig,
    // The enablement ladder judges the merged view, so an overlay's
    // explicit enabled rung carries the same weight as a global one.
    loadedConfig: mergedLoadedConfigForOverlay(
      options.loadedConfig,
      overlayConfig,
    ),
    strictUnknownPlugins: options.strictUnknownPlugins === true,
    catalogDiagnostics: composition.diagnostics,
  });
  const globalMutationBase = createRuntimeConfigMutationBase({
    loadedConfig: options.loadedConfig,
    ...(resolvedConfig.path === undefined
      ? {}
      : {configPath: resolvedConfig.path}),
    ...(options.runtimeLocation.selection.storeRoot === undefined
      ? {}
      : {storeRoot: options.runtimeLocation.selection.storeRoot}),
  });

  return Object.freeze({
    runtimeLocation: options.runtimeLocation,
    catalogEntries,
    packageProvenanceByPluginId: composition.packageProvenanceByPluginId,
    resolvedConfig,
    activation,
    authoredConfigFingerprint: layeredRuntimeConfigFingerprintForScope({
      globalConfig: globalMutationBase,
      characterScope,
      overlay: overlayConfig,
    }),
    pluginConfigControl: Object.freeze({
      pluginManifests,
      control: createRuntimePluginConfigControlCapability(),
      activationByPluginId: runtimePluginConfigActivationByPluginId(activation),
      defaultEnabledPluginIds: Object.freeze([
        ...composition.defaultEnabledPluginIds,
      ]),
      runtimeLocation: options.runtimeLocation,
      configScope: 'character',
      ...(options.env === undefined
        ? {}
        : {env: Object.freeze({...options.env})}),
    }),
  } satisfies PreparedProject02PluginActivationPlan);
}

function activationCatalogComposition(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly overlayConfig: LoadedProject02CharacterOverlayConfig;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
}): RuntimePluginCatalogSnapshot {
  if (options.factories !== undefined) {
    return Object.freeze({
      storeRoot: options.runtimeLocation.homeRoot,
      ...composeRuntimePluginCatalog({factories: options.factories}),
      packageProvenanceByPluginId: Object.freeze({}),
      diagnostics: Object.freeze([]),
    } satisfies RuntimePluginCatalogSnapshot);
  }

  return (
    options.catalogSnapshot ??
    createRuntimePluginCatalogSnapshot({
      loadedConfig: options.loadedConfig,
      runtimeLocation: options.runtimeLocation,
      overlayConfig: options.overlayConfig,
    })
  );
}

function runtimePluginConfigActivationByPluginId(
  activation: RuntimePluginActivationResult,
): Readonly<Record<string, RuntimePluginConfigActivationInspectShape>> {
  return Object.freeze(
    Object.fromEntries(
      activation.plugins.map(plugin => [
        plugin.pluginId,
        Object.freeze({
          enabled: plugin.enabled,
          status: plugin.activationStatus,
          reasons: Object.freeze([...plugin.activationReasons]),
        } satisfies RuntimePluginConfigActivationInspectShape),
      ]),
    ),
  );
}

export async function createConfiguredProject02PluginHostFromPlan(options: {
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions | undefined;
  readonly toolConfirmationHandler?:
    RuntimePluginToolConfirmationHandler | undefined;
}): Promise<Project02ConfiguredPluginHost> {
  const {activationPlan} = options;
  const {catalogEntries} = activationPlan;

  if (diagnosticsHaveErrors(activationPlan.activation.diagnostics)) {
    const plugins: readonly RuntimePlugin[] = Object.freeze([]);

    return Object.freeze({
      host: createRuntimePluginHost({
        plugins,
        enabledPluginIds: activationPlan.activation.enabledPluginIds,
        storeRoot: activationPlan.runtimeLocation.characterScope.dataRoot,
        fileStore: configuredRuntimePluginFileStoreProvider,
        pluginInventoryState: runtimePluginInventoryStateForInvalidConfig(
          activationPlan.pluginConfigControl,
        ),
        toolConfirmationHandler: options.toolConfirmationHandler,
        sessionId: options.sessionId,
        sessionIdentity: options.sessionIdentity,
      }),
      plugins,
      resolvedConfig: activationPlan.resolvedConfig,
      activation: activationPlan.activation,
      packageProvenanceByPluginId: activationPlan.packageProvenanceByPluginId,
      pluginConfigControl: activationPlan.pluginConfigControl,
      runtimeLocation: activationPlan.runtimeLocation,
    } satisfies Project02ConfiguredPluginHost);
  }

  // Host construction is downstream of character initialization: it
  // asserts the guarded initializer already ran (identity marker
  // present and matching) and never creates durable character state
  // itself — a direct caller on an uninitialized home used to get a
  // partially initialized character with no package defaults and no
  // diagnostics.
  assertCharacterRuntimeInitialized(activationPlan.runtimeLocation);

  const plugins = await instantiateRuntimePluginPackages({
    catalogEntries,
    runtimeLocation: activationPlan.runtimeLocation,
    resolvedConfig: activationPlan.resolvedConfig,
    enabledPluginIds: activationPlan.activation.enabledPluginIds,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    constructionCleanup: options.constructionCleanup,
  });
  let host: RuntimePluginHost;

  try {
    host = createRuntimePluginHost({
      plugins,
      enabledPluginIds: activationPlan.activation.enabledPluginIds,
      storeRoot: activationPlan.runtimeLocation.characterScope.dataRoot,
      fileStore: configuredRuntimePluginFileStoreProvider,
      pluginConfigControl: activationPlan.pluginConfigControl,
      toolConfirmationHandler: options.toolConfirmationHandler,
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      pluginReloader: createConfiguredRuntimePluginReloader({activationPlan}),
      constructionConfigFingerprint: activationPlan.authoredConfigFingerprint,
    });
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      plugins,
      runtimeLocation: activationPlan.runtimeLocation,
      resolvedConfig: activationPlan.resolvedConfig,
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      constructionCleanup: options.constructionCleanup,
    });
    throw error;
  }

  return Object.freeze({
    host,
    plugins,
    resolvedConfig: activationPlan.resolvedConfig,
    activation: activationPlan.activation,
    packageProvenanceByPluginId: activationPlan.packageProvenanceByPluginId,
    pluginConfigControl: activationPlan.pluginConfigControl,
    runtimeLocation: activationPlan.runtimeLocation,
  } satisfies Project02ConfiguredPluginHost);
}

function assertCharacterRuntimeInitialized(
  runtimeLocation: ResolvedProject02RuntimeLocation,
): void {
  try {
    requireCharacterDataMarker({
      storageOptions: {
        storeRoot: runtimeLocation.characterScope.dataRoot,
      },
      characterId: runtimeLocation.characterScope.characterId,
    });
  } catch (error: unknown) {
    if (
      error instanceof LocalRuntimeStorageContractError &&
      error.code === 'missing_file'
    ) {
      throw new TypeError(
        `Character "${runtimeLocation.characterScope.characterId}" is not ` +
          'initialized in this home. Run the character initializer ' +
          '(initializeProject02CharacterRuntime, or any project02 CLI ' +
          'startup) before constructing the plugin host.',
        {cause: error},
      );
    }

    throw error;
  }
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
    options.pluginManifests ??
    options.plugins?.map(plugin => plugin.manifest) ??
    [];
  const config = options.loadedConfig.config;
  const pluginIds = new Set(pluginManifests.map(manifest => manifest.id));
  const baseDiagnostics: readonly RuntimeConfigDiagnostic[] = Object.freeze([
    ...unknownPluginDiagnostics({
      knownPluginIds: pluginIds,
      loadedPlugins: config?.plugins ?? {},
      ...(config?.project02?.defaultMemoryProvider === undefined
        ? {}
        : {
            defaultMemoryProviderId: config.project02.defaultMemoryProvider,
          }),
      strict: options.strictUnknownPlugins === true,
    }),
    ...options.resolvedConfig.diagnostics,
    ...(options.catalogDiagnostics ?? []),
  ]);
  const loadedConfigHasErrors = diagnosticsHaveErrors(
    options.loadedConfig.diagnostics,
  );
  const globalConfigErrors = hasGlobalRuntimeConfigErrors({
    diagnostics: baseDiagnostics,
    knownPluginIds: pluginIds,
  });
  const enabledPluginIds: string[] = [];
  const disabledPluginIds: string[] = [];
  const snapshots: RuntimePluginActivationSnapshot[] = [];
  const preliminaryDecisions = pluginManifests.map(manifest => {
    const configured = ownJsonRecordValue(config?.plugins, manifest.id);
    const defaultEnabled =
      options.defaultEnabledPluginIds?.has(manifest.id) === true;
    const configErrors =
      !isRuntimePluginInventoryRecoveryManifest(manifest) &&
      (loadedConfigHasErrors ||
        globalConfigErrors ||
        pluginHasRuntimeConfigErrors({
          diagnostics: baseDiagnostics,
          pluginId: manifest.id,
        }));

    return Object.freeze({
      manifest,
      duplicateCandidateDecision: activationDecision({
        configuredEnabled: configured?.enabled,
        defaultEnabled,
        configErrors: false,
      }),
      decision: activationDecision({
        configuredEnabled: configured?.enabled,
        defaultEnabled,
        configErrors,
      }),
    });
  });
  const duplicateCandidateMemoryProviderDecision =
    defaultMemoryProviderDecision({
      ...(config?.project02?.defaultMemoryProvider === undefined
        ? {}
        : {
            configDefaultMemoryProvider: config.project02.defaultMemoryProvider,
          }),
      pluginManifests,
      memoryProviderManifests: pluginManifests.filter(
        manifest => manifest.kind === 'memory_provider',
      ),
      enabledPluginManifests: preliminaryDecisions
        .filter(preliminary => preliminary.duplicateCandidateDecision.enabled)
        .map(preliminary => preliminary.manifest),
    });
  const duplicateManifestDiagnostics = duplicatePluginManifestIdDiagnostics({
    pluginManifests: duplicateDiagnosticPluginManifests({
      preliminaryDecisions,
      memoryProviderDecision: duplicateCandidateMemoryProviderDecision,
    }),
    reservedPluginIds: [],
  });
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...duplicateManifestDiagnostics,
    ...baseDiagnostics,
  ];

  const memoryProviderDecision = defaultMemoryProviderDecision({
    ...(config?.project02?.defaultMemoryProvider === undefined
      ? {}
      : {
          configDefaultMemoryProvider: config.project02.defaultMemoryProvider,
        }),
    pluginManifests,
    memoryProviderManifests: pluginManifests.filter(
      manifest => manifest.kind === 'memory_provider',
    ),
    enabledPluginManifests: preliminaryDecisions
      .filter(preliminary => preliminary.decision.enabled)
      .map(preliminary => preliminary.manifest),
  });

  diagnostics.push(...memoryProviderDecision.diagnostics);
  const activationConfigErrors = diagnosticsHaveErrors(diagnostics);

  for (const preliminaryDecision of preliminaryDecisions) {
    const manifest = preliminaryDecision.manifest;
    const memoryDecision = finalizeMemoryProviderActivation({
      manifest,
      decision: preliminaryDecision.decision,
      memoryProviderDecision,
    });
    const decision = blockActivationAfterRuntimeConfigErrors({
      decision: memoryDecision,
      configErrors:
        activationConfigErrors &&
        !isRuntimePluginInventoryRecoveryManifest(manifest),
    });
    const access = runtimePluginAccessSnapshot({
      requestedAccess: manifest.requestedAccess,
      enabled: decision.enabled,
      fieldPrefix: manifest.id,
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
          ...decision.reasons,
        ]),
        diagnostics: Object.freeze(
          diagnostics.filter(diagnostic =>
            runtimeConfigDiagnosticMatchesPlugin({
              diagnostic,
              pluginId: manifest.id,
            }),
          ),
        ),
      } satisfies RuntimePluginActivationSnapshot),
    );
  }

  return Object.freeze({
    enabledPluginIds: Object.freeze(enabledPluginIds),
    disabledPluginIds: Object.freeze(disabledPluginIds),
    plugins: Object.freeze(snapshots),
    diagnostics: Object.freeze(diagnostics),
    ...(memoryProviderDecision.defaultMemoryProvider === undefined
      ? {}
      : {defaultMemoryProvider: memoryProviderDecision.defaultMemoryProvider}),
  } satisfies RuntimePluginActivationResult);
}

function hasGlobalRuntimeConfigErrors(options: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly knownPluginIds: ReadonlySet<string>;
}): boolean {
  return options.diagnostics.some(
    diagnostic =>
      diagnostic.severity === 'error' &&
      !isKnownPluginRuntimeConfigDiagnostic({
        diagnostic,
        knownPluginIds: options.knownPluginIds,
      }),
  );
}

function pluginHasRuntimeConfigErrors(options: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly pluginId: string;
}): boolean {
  return options.diagnostics.some(
    diagnostic =>
      diagnostic.severity === 'error' &&
      runtimeConfigDiagnosticMatchesPlugin({
        diagnostic,
        pluginId: options.pluginId,
      }),
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
        pluginId,
      })
    ) {
      return true;
    }
  }

  return false;
}

async function instantiateRuntimePluginPackages(options: {
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly enabledPluginIds: readonly string[];
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions | undefined;
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
        storeRoot: options.runtimeLocation.characterScope.dataRoot,
        resolvedConfig:
          ownJsonRecordValue(
            options.resolvedConfig.pluginConfigs,
            entry.manifest.id,
          ) ?? {},
        redactedConfig:
          ownJsonRecordValue(
            options.resolvedConfig.redactedPluginConfigs,
            entry.manifest.id,
          ) ?? {},
      });
      plugins.push(plugin);

      if (plugin.manifest.id !== entry.manifest.id) {
        throw new TypeError(
          `Plugin package loader "${pluginId}" returned plugin "${plugin.manifest.id}" after declaring manifest "${entry.manifest.id}".`,
        );
      }

      if (!runtimePluginManifestsMatch(plugin.manifest, entry.manifest)) {
        throw new TypeError(
          `Plugin package loader "${pluginId}" returned a manifest that differs from its declared manifest "${entry.manifest.id}".`,
        );
      }
    }
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      plugins,
      runtimeLocation: options.runtimeLocation,
      resolvedConfig: options.resolvedConfig,
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      constructionCleanup: options.constructionCleanup,
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
  const {diagnostic} = options;
  const diagnosticPluginIds = [
    diagnostic.pluginId,
    diagnostic.claimedPluginId,
  ].filter((pluginId): pluginId is string => pluginId !== undefined);
  const configuredPluginId = diagnosticPluginIds.find(
    pluginId =>
      ownJsonRecordValue(options.loadedConfig.config?.plugins, pluginId)
        ?.enabled === true,
  );
  const pluginId =
    configuredPluginId ?? diagnostic.pluginId ?? diagnostic.claimedPluginId;
  const hasDiscoveredWinner = diagnosticPluginIds.some(candidateId =>
    options.discoveredPluginIds.has(candidateId),
  );
  const severity =
    diagnostic.provenance === 'bundled' ||
    pluginId === undefined ||
    (configuredPluginId !== undefined && !hasDiscoveredWinner)
      ? 'error'
      : 'warning';
  const base = {
    severity,
    code: `runtime_plugin_package_${diagnostic.code}`,
    message: diagnostic.message,
    path: diagnostic.path,
  } as const;

  return pluginId === undefined
    ? Object.freeze({...base, scope: 'global'})
    : Object.freeze({
        ...base,
        scope: 'plugin',
        pluginId,
      });
}

async function cleanupPartiallyInstantiatedPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions | undefined;
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
    character: configuredPluginConstructionCleanupCharacter,
  });
  try {
    await runRuntimePluginSessionEndHooks({
      plugins: options.plugins,
      context,
      storeRoot: options.runtimeLocation.characterScope.dataRoot,
      createFileStore: configuredRuntimePluginFileStoreProvider.createFileStore,
      sessionId,
      sessionIdentity: options.sessionIdentity,
      hookOptions: {
        ...options.constructionCleanup,
        ...configuredPluginConstructionCleanupOptions,
      },
    });
  } catch {
    // Construction cleanup is best-effort and must not mask the factory or host error.
  }

  try {
    await runRuntimePluginShutdownHooks({
      plugins: options.plugins,
      context,
      storeRoot: options.runtimeLocation.characterScope.dataRoot,
      createFileStore: configuredRuntimePluginFileStoreProvider.createFileStore,
      sessionId,
      sessionIdentity: options.sessionIdentity,
    });
  } catch {
    // Shutdown is best-effort and must not mask the factory or host error.
  }
}

function runtimePluginManifestsMatch(
  actual: RuntimePluginManifest,
  expected: RuntimePluginManifest,
): boolean {
  return canonicalJsonValuesEqual(actual, expected);
}

function activationPluginManifests(
  catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>,
): readonly RuntimePluginManifest[] {
  return Object.freeze(
    Object.values(catalogEntries).map(entry => entry.manifest),
  );
}

function isRuntimePluginInventoryRecoveryManifest(
  manifest: RuntimePluginManifest,
): boolean {
  return (
    defaultRuntimePluginHostServiceEntries[runtimePluginId]?.manifest ===
    manifest
  );
}

// Invalid-config hosts get inventory only: the config-control capability
// deliberately does not survive into this state, so config tools stay off.
function runtimePluginInventoryStateForInvalidConfig(
  state: RuntimePluginConfigControlHostState,
): RuntimePluginInventoryHostState {
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
      : {activationByPluginId: state.activationByPluginId}),
    ...(state.defaultEnabledPluginIds === undefined
      ? {}
      : {defaultEnabledPluginIds: state.defaultEnabledPluginIds}),
    runtimeLocation: state.runtimeLocation,
    ...(state.env === undefined ? {} : {env: state.env}),
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
      reasons: ['disabled_by_config'],
    };
  }

  if (options.configErrors) {
    return {
      enabled: false,
      status: 'blocked',
      reasons: ['blocked_by_config_errors'],
    };
  }

  if (options.configuredEnabled === true) {
    return {
      enabled: true,
      status: 'active',
      reasons: ['enabled_by_config'],
    };
  }

  if (options.defaultEnabled) {
    return {
      enabled: true,
      status: 'active',
      reasons: ['enabled_by_default'],
    };
  }

  return {
    enabled: false,
    status: 'disabled',
    reasons: ['not_enabled'],
  };
}

function duplicateDiagnosticPluginManifests(options: {
  readonly preliminaryDecisions: readonly {
    readonly manifest: RuntimePluginManifest;
    readonly duplicateCandidateDecision: ReturnType<typeof activationDecision>;
  }[];
  readonly memoryProviderDecision: ReturnType<
    typeof defaultMemoryProviderDecision
  >;
}): readonly RuntimePluginManifest[] {
  const activePluginIds = new Set<string>();

  for (const preliminary of options.preliminaryDecisions) {
    const decision = options.memoryProviderDecision.ambiguous
      ? preliminary.duplicateCandidateDecision
      : finalizeMemoryProviderActivation({
          manifest: preliminary.manifest,
          decision: preliminary.duplicateCandidateDecision,
          memoryProviderDecision: options.memoryProviderDecision,
        });

    if (decision.enabled) {
      activePluginIds.add(preliminary.manifest.id);
    }
  }

  return Object.freeze(
    options.preliminaryDecisions
      .filter(preliminary => activePluginIds.has(preliminary.manifest.id))
      .map(preliminary => preliminary.manifest),
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
      'blocked_by_config_errors',
    ]),
  };
}

function unknownPluginDiagnostics(options: {
  readonly knownPluginIds: ReadonlySet<string>;
  readonly loadedPlugins: NonNullable<
    LoadedProject02RuntimeConfig['config']
  >['plugins'];
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
    options.loadedPlugins ?? {},
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
    addUnknown(
      options.defaultMemoryProviderId,
      'project02.defaultMemoryProvider',
    );
  }

  return Object.freeze(
    [...unknown].map(([pluginId, path]) =>
      createRuntimeConfigDiagnostic(
        options.strict ? 'error' : 'warning',
        'runtime_config_unknown_plugin',
        `Runtime config references unknown plugin "${pluginId}".`,
        path,
        {pluginId},
      ),
    ),
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
    [...duplicateIds].map(pluginId =>
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_duplicate_plugin_manifest_id',
        `Runtime plugin manifest id "${pluginId}" is declared more than once.`,
        `plugins.${pluginId}`,
        {pluginId},
      ),
    ),
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
    manifest => manifest.kind === 'memory_provider',
  );

  if (options.configDefaultMemoryProvider !== undefined) {
    const knownPlugin = options.pluginManifests.find(
      manifest => manifest.id === options.configDefaultMemoryProvider,
    );
    const knownMemoryProvider = options.memoryProviderManifests.find(
      manifest => manifest.id === options.configDefaultMemoryProvider,
    );
    const selected = enabledMemoryProviders.find(
      manifest => manifest.id === options.configDefaultMemoryProvider,
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
              {pluginId: knownPlugin.id},
            ),
          ],
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
              : {pluginId: knownMemoryProvider.id},
          ),
        ],
      };
    }

    return {
      activeMemoryProviderIds: [selected.id],
      ambiguous: false,
      defaultMemoryProvider: selected.id,
      diagnostics: [],
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
          'project02.defaultMemoryProvider',
        ),
      ],
    };
  }

  return {
    activeMemoryProviderIds:
      enabledMemoryProviders[0] === undefined
        ? []
        : [enabledMemoryProviders[0].id],
    ambiguous: false,
    diagnostics: [],
  };
}

function finalizeMemoryProviderActivation(options: {
  readonly manifest: RuntimePluginManifest;
  readonly decision: ReturnType<typeof activationDecision>;
  readonly memoryProviderDecision: ReturnType<
    typeof defaultMemoryProviderDecision
  >;
}): ReturnType<typeof activationDecision> {
  if (
    !options.decision.enabled ||
    options.manifest.kind !== 'memory_provider'
  ) {
    return options.decision;
  }

  if (
    options.memoryProviderDecision.activeMemoryProviderIds.includes(
      options.manifest.id,
    )
  ) {
    return {
      ...options.decision,
      reasons: Object.freeze([
        ...options.decision.reasons,
        ...(options.memoryProviderDecision.defaultMemoryProvider ===
          options.manifest.id &&
        !options.decision.reasons.includes(
          selectedAsDefaultMemoryProviderReason,
        )
          ? [selectedAsDefaultMemoryProviderReason]
          : []),
      ]),
    };
  }

  return {
    enabled: false,
    status: options.memoryProviderDecision.ambiguous ? 'blocked' : 'disabled',
    reasons: Object.freeze([
      ...options.decision.reasons,
      options.memoryProviderDecision.ambiguous
        ? 'ambiguous_memory_provider_selection'
        : 'not_selected_as_default_memory_provider',
    ]),
  };
}
