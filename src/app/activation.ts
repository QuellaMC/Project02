import {
  createLocalRuntimeSessionHistoryFeed,
  createProject02HomeLayout,
  createRuntimePluginDatabaseProvider,
  LocalRuntimeStorageContractError,
  requireCharacterDataMarker,
} from '../runtime/storage/index.ts';
import {
  createRuntimePluginConfigControlBinding,
  createRuntimePluginHost,
  hostFirstPartyRuntimePluginIds,
  isHostScopedFirstPartyRuntimePluginId,
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
  assertResolvedProject02HomeAdoptable,
  createLayeredProject02RuntimeConfigSnapshot,
  createRuntimeConfigDiagnostic,
  createRuntimePluginConfigControlCapability,
  diagnosticsHaveErrors,
  readCharacterOverlayForScope,
  resolveRuntimeConfigScopeTarget,
  resolveLayeredProject02RuntimeConfigWithSnapshot,
  runtimeConfigDiagnosticMatchesPlugin,
  type EffectiveProject02RuntimeConfigSnapshot,
  type LoadedProject02CharacterOverlayConfig,
  type LoadedProject02RuntimeConfig,
  type ResolvedProject02RuntimeLocation,
  type ResolvedProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimePluginActivationStatusShape,
} from '../runtime/config/index.ts';
import {createConfiguredRuntimePluginReloader} from './plugin-reload.ts';
import {
  composeRuntimePluginCatalog,
  defaultRuntimePluginHostServiceEntries,
  type RuntimePluginFactoryDefinition,
} from './plugin-catalog.ts';
import {
  cleanupPartiallyInstantiatedPlugins,
  configuredRuntimePluginFileStoreProvider,
  instantiateRuntimePluginPackages,
} from './plugin-construction.ts';

export type {RuntimePluginFactoryDefinition} from './plugin-catalog.ts';

export type RuntimePluginActivationSnapshot = {
  readonly pluginId: string;
  readonly kind: RuntimePluginKind;
  readonly enabled: boolean;
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly grantedAccess: RuntimePluginAccessMap;
  readonly activationStatus: RuntimePluginActivationStatusShape['status'];
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

/** Package scanning is config-free, so one scan is re-classified per layer. */
export type RuntimePluginCatalogDiscovery = {
  readonly storeRoot: string;
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly defaultEnabledPluginIds: readonly string[];
  readonly packageProvenanceByPluginId: Readonly<
    Record<string, RuntimePluginPackageProvenance>
  >;
  readonly packageDiagnostics: readonly RuntimePluginPackageDiagnostic[];
  readonly reservedIdDiagnostics: readonly RuntimeConfigDiagnostic[];
  readonly discoveredPluginIds: ReadonlySet<string>;
};

const selectedAsDefaultMemoryProviderReason =
  'selected_as_default_memory_provider';

export function createRuntimePluginCatalogSnapshot(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly overlayConfig?: LoadedProject02CharacterOverlayConfig;
}): RuntimePluginCatalogSnapshot {
  assertResolvedProject02HomeAdoptable(options.runtimeLocation);

  return classifyRuntimePluginCatalogDiscovery({
    discovery: discoverRuntimePluginCatalog({
      storeRoot: options.runtimeLocation.homeRoot,
    }),
    classificationConfig: createLayeredProject02RuntimeConfigSnapshot({
      loadedConfig: options.loadedConfig,
      ...(options.overlayConfig === undefined
        ? {}
        : {overlayConfig: options.overlayConfig}),
    }).effective,
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
      },
      {
        root: operatorPackageRoot,
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
  const overriddenPluginIds = new Set(
    Object.values(options.factoryOverrides ?? {}).map(
      definition => definition.manifest.id,
    ),
  );

  return Object.freeze({
    storeRoot: options.storeRoot,
    catalogEntries: composition.catalogEntries,
    defaultEnabledPluginIds: composition.defaultEnabledPluginIds,
    // Provenance describes the entry that won the catalog: a factory
    // override displaces the discovered package, so the displaced
    // package's origin must not travel with the override.
    packageProvenanceByPluginId: Object.freeze(
      Object.fromEntries(
        ordinaryPackages
          .filter(item => !overriddenPluginIds.has(item.manifest.id))
          .map(item => [item.manifest.id, item.provenance]),
      ),
    ),
    packageDiagnostics: discovery.diagnostics,
    reservedIdDiagnostics: Object.freeze(reservedIdDiagnostics),
    discoveredPluginIds: new Set([
      ...ordinaryPackages.map(item => item.manifest.id),
      ...Object.keys(defaultRuntimePluginHostServiceEntries),
      ...Object.values(options.factoryOverrides ?? {}).map(
        definition => definition.manifest.id,
      ),
    ]),
  } satisfies RuntimePluginCatalogDiscovery);
}

/** An overlay-enabled broken package errors like a globally enabled one. */
export function classifyRuntimePluginCatalogDiscovery(options: {
  readonly discovery: RuntimePluginCatalogDiscovery;
  readonly classificationConfig: EffectiveProject02RuntimeConfigSnapshot;
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
          effectiveConfig: options.classificationConfig,
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
  readonly validateInactivePluginConfigs?: boolean;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
}): PreparedProject02PluginActivationPlan {
  assertResolvedProject02HomeAdoptable(options.runtimeLocation);

  // The supplied overlay decides the scope: its id may be a flag override.
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
  const configControlTarget = resolveRuntimeConfigScopeTarget({
    runtimeLocation: options.runtimeLocation,
    scope: 'character',
  });
  const {layeredConfig, resolvedConfig} =
    resolveLayeredProject02RuntimeConfigWithSnapshot({
      loadedConfig: options.loadedConfig,
      runtimeLocation: options.runtimeLocation,
      overlayConfig,
      pluginManifests,
      defaultEnabledPluginIds,
      validateInactivePluginConfigs:
        options.validateInactivePluginConfigs === true,
    });
  const activation = resolveRuntimePluginActivation({
    pluginManifests,
    defaultEnabledPluginIds,
    resolvedConfig,
    // The enablement ladder judges the merged view, not just the global one.
    effectiveConfig: layeredConfig.effective,
    catalogDiagnostics: composition.diagnostics,
    trustedContextEligiblePluginIds: trustedContextEligiblePluginIds(
      composition.packageProvenanceByPluginId,
    ),
  });
  return Object.freeze({
    runtimeLocation: options.runtimeLocation,
    catalogEntries,
    packageProvenanceByPluginId: composition.packageProvenanceByPluginId,
    resolvedConfig,
    activation,
    pluginConfigControl: Object.freeze({
      pluginManifests,
      activationByPluginId: runtimePluginConfigActivationByPluginId(activation),
      defaultEnabledPluginIds: Object.freeze([
        ...composition.defaultEnabledPluginIds,
      ]),
      configControl: createRuntimePluginConfigControlBinding({
        control: createRuntimePluginConfigControlCapability(),
        target: configControlTarget,
      }),
    }),
  } satisfies PreparedProject02PluginActivationPlan);
}

function activationCatalogComposition(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly overlayConfig: LoadedProject02CharacterOverlayConfig;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
}): RuntimePluginCatalogSnapshot {
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
): Readonly<Record<string, RuntimePluginActivationStatusShape>> {
  return Object.freeze(
    Object.fromEntries(
      activation.plugins.map(plugin => [
        plugin.pluginId,
        Object.freeze({
          enabled: plugin.enabled,
          status: plugin.activationStatus,
          reasons: Object.freeze([...plugin.activationReasons]),
        } satisfies RuntimePluginActivationStatusShape),
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

  // An error host is still a host, so both guards precede that branch.
  assertResolvedProject02HomeAdoptable(activationPlan.runtimeLocation);
  assertCharacterRuntimeInitialized(activationPlan.runtimeLocation);

  // Declared-capability providers for every plugin the host may enable:
  // hooks only run for enabled plugins and both providers are file-less
  // until used, so enablement alone decides whether anything happens.
  const capabilityProviders = {
    sessionHistory: createLocalRuntimeSessionHistoryFeed({
      storeRoot: activationPlan.runtimeLocation.characterScope.dataRoot,
      characterId: activationPlan.runtimeLocation.characterScope.characterId,
    }),
    pluginDatabase: createRuntimePluginDatabaseProvider({
      storeRoot: activationPlan.runtimeLocation.characterScope.dataRoot,
    }),
  };

  if (diagnosticsHaveErrors(activationPlan.activation.diagnostics)) {
    const plugins: readonly RuntimePlugin[] = Object.freeze([]);

    return Object.freeze({
      host: createRuntimePluginHost({
        plugins,
        enabledPluginIds: activationPlan.activation.enabledPluginIds,
        trustedContextEligiblePluginIds: [
          ...trustedContextEligiblePluginIds(
            activationPlan.packageProvenanceByPluginId,
          ),
        ],
        storeRoot: activationPlan.runtimeLocation.characterScope.dataRoot,
        fileStore: configuredRuntimePluginFileStoreProvider,
        pluginInventoryState: runtimePluginInventoryStateForInvalidConfig(
          activationPlan.pluginConfigControl,
        ),
        ...capabilityProviders,
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

  const instantiated = await instantiateRuntimePluginPackages({
    catalogEntries,
    runtimeLocation: activationPlan.runtimeLocation,
    resolvedConfig: activationPlan.resolvedConfig,
    enabledPluginIds: activationPlan.activation.enabledPluginIds,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    constructionCleanup: options.constructionCleanup,
  });
  const {plugins} = instantiated;
  let host: RuntimePluginHost;

  try {
    host = createRuntimePluginHost({
      plugins,
      lifecycleTargets: instantiated.lifecycleTargets,
      enabledPluginIds: activationPlan.activation.enabledPluginIds,
      trustedContextEligiblePluginIds: [
        ...trustedContextEligiblePluginIds(
          activationPlan.packageProvenanceByPluginId,
        ),
      ],
      storeRoot: activationPlan.runtimeLocation.characterScope.dataRoot,
      fileStore: configuredRuntimePluginFileStoreProvider,
      pluginConfigControl: activationPlan.pluginConfigControl,
      ...capabilityProviders,
      toolConfirmationHandler: options.toolConfirmationHandler,
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      pluginReloader: createConfiguredRuntimePluginReloader({activationPlan}),
    });
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      targets: instantiated.lifecycleTargets,
      accessByPluginId: instantiated.accessByPluginId,
      runtimeLocation: activationPlan.runtimeLocation,
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

/** Provenance is the gate: only bundled packages may hold trusted_context. */
function trustedContextEligiblePluginIds(
  packageProvenanceByPluginId: Readonly<
    Record<string, RuntimePluginPackageProvenance>
  >,
): ReadonlySet<string> {
  return new Set(
    Object.entries(packageProvenanceByPluginId)
      .filter(([, provenance]) => provenance === 'bundled')
      .map(([pluginId]) => pluginId),
  );
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
          'initialized in this home. Run a project02 CLI command against ' +
          'this store first (adding --init if the store itself is new), ' +
          'or call initializeProject02CharacterRuntime, before ' +
          'constructing the plugin host.',
        {cause: error},
      );
    }

    throw error;
  }
}

export function resolveRuntimePluginActivation(options: {
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly defaultEnabledPluginIds?: ReadonlySet<string>;
  readonly catalogDiagnostics?: readonly RuntimeConfigDiagnostic[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly effectiveConfig: EffectiveProject02RuntimeConfigSnapshot;
  readonly trustedContextEligiblePluginIds?: ReadonlySet<string>;
}): RuntimePluginActivationResult {
  const {pluginManifests} = options;
  const config = options.effectiveConfig.config;
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
    }),
    ...options.resolvedConfig.diagnostics,
    ...(options.catalogDiagnostics ?? []),
  ]);
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
      (globalConfigErrors ||
        pluginHasRuntimeConfigErrors({
          diagnostics: baseDiagnostics,
          pluginId: manifest.id,
        }));

    return Object.freeze({
      manifest,
      decision: activationDecision({
        configuredEnabled: configured?.enabled,
        defaultEnabled,
        configErrors,
      }),
    });
  });
  const diagnostics: RuntimeConfigDiagnostic[] = [...baseDiagnostics];

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
    const trustedContextEligible =
      options.trustedContextEligiblePluginIds?.has(manifest.id) === true;
    const access = runtimePluginAccessSnapshot({
      requestedAccess: manifest.requestedAccess,
      enabled: decision.enabled,
      fieldPrefix: manifest.id,
      trustedContextEligible,
    });

    if (
      !trustedContextEligible &&
      Object.hasOwn(access.requestedAccess, 'trusted_context')
    ) {
      diagnostics.push(
        createRuntimeConfigDiagnostic(
          'warning',
          'trusted_context_not_first_party',
          `Plugin "${manifest.id}" requests trusted_context access, which only bundled first-party packages can hold.`,
          `plugins.${manifest.id}`,
          {pluginId: manifest.id},
        ),
      );
    }

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

function runtimePluginPackageDiagnostic(options: {
  readonly diagnostic: RuntimePluginPackageDiagnostic;
  readonly effectiveConfig: EffectiveProject02RuntimeConfigSnapshot;
  readonly discoveredPluginIds: ReadonlySet<string>;
}): RuntimeConfigDiagnostic {
  const {diagnostic} = options;
  const diagnosticPluginIds = [
    diagnostic.pluginId,
    diagnostic.claimedPluginId,
  ].filter((pluginId): pluginId is string => pluginId !== undefined);
  const configuredPluginId = diagnosticPluginIds.find(
    pluginId =>
      ownJsonRecordValue(options.effectiveConfig.config?.plugins, pluginId)
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

// The config-control capability deliberately does not survive here.
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
  });
}

function activationDecision(options: {
  readonly configuredEnabled: boolean | undefined;
  readonly defaultEnabled: boolean;
  readonly configErrors: boolean;
}): {
  readonly enabled: boolean;
  readonly status: RuntimePluginActivationStatusShape['status'];
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
        'warning',
        'runtime_config_unknown_plugin',
        `Runtime config references unknown plugin "${pluginId}".`,
        path,
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
