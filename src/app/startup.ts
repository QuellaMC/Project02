import {
  classifyRuntimePluginCatalogDiscovery,
  discoverRuntimePluginCatalog,
  prepareConfiguredProject02PluginActivation,
  runtimeConfigDiagnosticConcernsCharacter,
  type PreparedProject02PluginActivationPlan,
  type RuntimePluginCatalogSnapshot,
  type RuntimePluginFactoryDefinition,
} from './activation.ts';
import {
  prepareProject02CharacterActivation,
  selectSoleEnabledCharacterId,
  type Project02CharacterActivation,
} from './character.ts';
import {
  enforceCharacterPluginExpectations,
  planCharacterPackagePluginMaterialization,
} from './character-plugins.ts';
import type {CharacterPluginExpectations} from '../characters/index.ts';
import type {RuntimePluginManifest} from '../plugins/api/index.ts';
import {loadProject02Home, type Project02Home} from './home.ts';
import {
  applyRuntimeConfigControlOperation,
  assertResolvedProject02HomeAdoptable,
  bindProject02CharacterRuntimeLocation,
  blockingRuntimeConfigLayerDiagnostic,
  createLayeredProject02RuntimeConfigSnapshot,
  createRuntimeConfigDiagnostic,
  createRuntimeConfigSections,
  diagnosticsHaveErrors,
  readCharacterOverlayForScope,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigDiagnosticIsReadinessFailure,
  runtimeConfigSectionPath,
  simulateCharacterOverlayCandidate,
  withRuntimeConfigDiagnosticOrigin,
  type LoadedProject02CharacterOverlayConfig,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type ResolvedProject02ConfigLocation,
  type ResolvedProject02RuntimeLocation,
  type RuntimeLocationCliState,
} from '../runtime/config/index.ts';
import {
  ensureCharacterDataDir,
  LocalRuntimeStorageContractError,
  recordMaterializedCharacterPackageVersion,
  requireCharacterDataMarker,
  type LocalRuntimeCharacterDataStorageSchemaMarker,
} from '../runtime/storage/index.ts';

type RuntimeCliStartupCommonOptions = {
  readonly location?: RuntimeLocationCliState;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

type RuntimeCliActivationStartupOptions = RuntimeCliStartupCommonOptions & {
  readonly stage?: 'activation';
};

type RuntimeCliConfigStartupOptions = RuntimeCliStartupCommonOptions & {
  readonly stage: 'config';
};

/** Same decisions and rejections as an activation startup, but no write. */
type RuntimeCliReportStartupOptions = Omit<
  RuntimeCliActivationStartupOptions,
  'stage'
> & {
  readonly stage: 'report';
};

type RuntimeCliStartupOptions =
  | RuntimeCliActivationStartupOptions
  | RuntimeCliConfigStartupOptions
  | RuntimeCliReportStartupOptions;

type RuntimeCliStartupBase = {
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
};

type RuntimeCliConfigStartupResult = RuntimeCliStartupBase;

type RuntimeCliActivationStartupBase = Omit<
  RuntimeCliStartupBase,
  'runtimeLocation'
> & {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly characterActivation: Project02CharacterActivation;
  readonly overlayLoadedConfig?: LoadedProject02CharacterOverlayConfig;
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot;
  readonly activationPlan: PreparedProject02PluginActivationPlan;
};

export type RuntimeCliStartupResult =
  | (RuntimeCliStartupBase & {
      readonly status: 'character_invalid';
      readonly characterActivation: Project02CharacterActivation;
    })
  | (RuntimeCliActivationStartupBase & {
      readonly status: 'config_invalid';
    })
  | (RuntimeCliActivationStartupBase & {
      readonly status: 'resolved';
    });

type StartupPlanState = {
  readonly overlayForPlan:
    | Record<string, never>
    | {readonly overlayLoadedConfig: LoadedProject02CharacterOverlayConfig};
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot;
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  // Each exit pairs its own plan with the status that describes it.
  readonly base: Omit<RuntimeCliActivationStartupBase, 'activationPlan'>;
};

/** A startup that survived every rejection except the write itself. */
type PlannedRuntimeCliActivationStartup = {
  readonly startupBase: RuntimeCliStartupBase;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly buildPlanState: (
    overlayLoadedConfig: LoadedProject02CharacterOverlayConfig | undefined,
  ) => StartupPlanState;
  readonly document: Project02RuntimeConfig;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  /** The overlay the commit would write; a reader finishes from it. */
  readonly simulatedOverlay: LoadedProject02CharacterOverlayConfig;
};

function rejectedStartup(result: RuntimeCliStartupResult): {
  readonly outcome: 'rejected';
  readonly result: RuntimeCliStartupResult;
} {
  return Object.freeze({outcome: 'rejected', result: Object.freeze(result)});
}

/** Throws on any non-resolved startup; must run before host construction. */
export async function initializeProject02CharacterRuntime(
  options: RuntimeCliStartupCommonOptions = {},
): Promise<{
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
  readonly activationPlan: PreparedProject02PluginActivationPlan;
}> {
  const startup = await resolveRuntimeCliStartup({...options});

  if (
    startup.status === 'character_invalid' ||
    startup.characterActivation.status !== 'resolved'
  ) {
    throw new TypeError(
      'Character activation failed: ' +
        (startup.characterActivation.status === 'failed'
          ? (startup.characterActivation.messages[0] ??
            'no character resolved.')
          : 'no character resolved.'),
    );
  }

  const blocking =
    startup.activationPlan.activation.diagnostics.find(
      diagnostic => diagnostic.severity === 'error',
    ) ??
    startup.loadedConfig.diagnostics.find(
      diagnostic => diagnostic.severity === 'error',
    );

  if (startup.status !== 'resolved' || blocking !== undefined) {
    throw new TypeError(
      `Character runtime initialization failed (${startup.status}): ${
        blocking?.message ?? 'invalid runtime config.'
      }`,
    );
  }

  return Object.freeze({
    characterActivation: startup.characterActivation,
    activationPlan: startup.activationPlan,
  });
}

export function resolveRuntimeCliStartup(
  options: RuntimeCliConfigStartupOptions,
): RuntimeCliConfigStartupResult;
export function resolveRuntimeCliStartup(
  options: RuntimeCliReportStartupOptions,
): RuntimeCliStartupResult;
export function resolveRuntimeCliStartup(
  options?: RuntimeCliActivationStartupOptions,
): Promise<RuntimeCliStartupResult>;
export function resolveRuntimeCliStartup(
  options: RuntimeCliStartupOptions = {},
):
  | RuntimeCliConfigStartupResult
  | RuntimeCliStartupResult
  | Promise<RuntimeCliStartupResult> {
  const home = loadProject02Home(options);

  if (options.stage === 'config') {
    return home;
  }

  const characterId =
    options.location?.character ?? selectSoleEnabledCharacterId(home);

  if (typeof characterId !== 'string') {
    return Object.freeze({
      ...home,
      status: 'character_invalid',
      characterActivation: characterId,
    });
  }

  const shared = {
    characterId,
    ...(options.factories === undefined ? {} : {factories: options.factories}),
  };

  if (options.stage === 'report') {
    return activateProject02Character(home, {...shared, stage: 'report'});
  }

  return activateProject02Character(home, shared);
}

export type ActivateProject02CharacterOptions = {
  readonly characterId: string;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

/**
 * Activates one character against an already-loaded home: package
 * resolution, overlay, plugin activation plan. The 'report' stage makes
 * the same decisions without the durable write.
 */
export function activateProject02Character(
  home: Project02Home,
  options: ActivateProject02CharacterOptions & {readonly stage: 'report'},
): RuntimeCliStartupResult;
export function activateProject02Character(
  home: Project02Home,
  options: ActivateProject02CharacterOptions,
): Promise<RuntimeCliStartupResult>;
export function activateProject02Character(
  home: Project02Home,
  options: ActivateProject02CharacterOptions & {
    readonly stage?: 'report';
  },
): RuntimeCliStartupResult | Promise<RuntimeCliStartupResult> {
  const startupBase = {
    runtimeLocation: home.runtimeLocation,
    loadedConfig: home.loadedConfig,
  };
  const activationInput = {
    configLocation: home.runtimeLocation,
    characterId: options.characterId,
    startupBase,
    loadedConfig: home.loadedConfig,
  };
  const stagelessOptions = {
    ...(options.factories === undefined ? {} : {factories: options.factories}),
  };

  if (options.stage === 'report') {
    const planned = planRuntimeCliActivationStartup({
      ...activationInput,
      options: {...stagelessOptions, stage: 'report'},
    });

    return planned.outcome === 'rejected'
      ? planned.result
      : simulatePlannedRuntimeCliActivationStartup(planned.plan);
  }

  return resolveRuntimeCliActivationStartup({
    ...activationInput,
    options: stagelessOptions,
  });
}

/**
 * No durable effect may precede a validation that could reject the
 * startup: the planner is synchronous, so a write cannot move into it.
 */
async function resolveRuntimeCliActivationStartup(input: {
  readonly options: RuntimeCliActivationStartupOptions;
  readonly configLocation: ResolvedProject02ConfigLocation;
  readonly characterId: string;
  readonly startupBase: RuntimeCliStartupBase;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
}): Promise<RuntimeCliStartupResult> {
  const planned = planRuntimeCliActivationStartup(input);

  if (planned.outcome === 'rejected') {
    return planned.result;
  }

  return await commitPlannedRuntimeCliActivationStartup(planned.plan);
}

/** Phase one: every rejection, decided before anything durable exists. */
function planRuntimeCliActivationStartup(input: {
  // Both stages plan the same way; they part company after this returns.
  readonly options:
    RuntimeCliActivationStartupOptions | RuntimeCliReportStartupOptions;
  readonly configLocation: ResolvedProject02ConfigLocation;
  readonly characterId: string;
  readonly startupBase: RuntimeCliStartupBase;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
}):
  | {readonly outcome: 'rejected'; readonly result: RuntimeCliStartupResult}
  | {
      readonly outcome: 'committable';
      readonly plan: PlannedRuntimeCliActivationStartup;
    } {
  const {options, configLocation, loadedConfig} = input;
  const activeCharacterId = input.characterId.trim();
  const homeRoot = configLocation.homeRoot;

  // Judged first so the operator hears about the home, not a subdirectory.
  assertResolvedProject02HomeAdoptable(configLocation);

  const characterActivation = prepareProject02CharacterActivation({
    storeRoot: homeRoot,
    configuredCharacterId: activeCharacterId,
  });

  if (characterActivation.status === 'failed') {
    return rejectedStartup({
      ...input.startupBase,
      status: 'character_invalid',
      characterActivation,
    });
  }

  const runtimeLocation = bindProject02CharacterRuntimeLocation({
    configLocation,
    characterId: characterActivation.profile.id,
  });
  const activationStartupBase = {
    ...input.startupBase,
    runtimeLocation,
  };

  // One discovery per startup, so every plan judges the same manifests.
  const catalogDiscovery = discoverRuntimePluginCatalog({
    storeRoot: homeRoot,
    ...(options.factories === undefined
      ? {}
      : {factoryOverrides: options.factories}),
  });
  const catalogSections = createRuntimeConfigSections({
    plugins: Object.values(catalogDiscovery.catalogEntries).map(
      entry => entry.manifest,
    ),
  });
  const buildPlanState = (
    overlayLoadedConfig: LoadedProject02CharacterOverlayConfig | undefined,
  ): StartupPlanState => {
    const overlayForPlan =
      overlayLoadedConfig === undefined ? {} : {overlayLoadedConfig};
    const catalogSnapshot = classifyRuntimePluginCatalogDiscovery({
      discovery: catalogDiscovery,
      classificationConfig: createLayeredProject02RuntimeConfigSnapshot({
        loadedConfig,
        ...(overlayLoadedConfig === undefined
          ? {}
          : {overlayConfig: overlayLoadedConfig}),
        sections: catalogSections,
      }).effective,
    });

    return {
      overlayForPlan,
      catalogSnapshot,
      activationPlan: prepareActivationPlan({
        loadedConfig,
        characterActivation,
        ...overlayForPlan,
        runtimeLocation,
        validateInactivePluginConfigs: true,
        catalogSnapshot,
      }),
      base: {
        ...activationStartupBase,
        characterActivation,
        ...overlayForPlan,
        catalogSnapshot,
      },
    };
  };

  // An invalid global config must not create durable state.
  if (diagnosticsHaveErrors(loadedConfig.diagnostics)) {
    const invalidState = buildPlanState(
      loadCharacterOverlayForStartup(runtimeLocation),
    );

    return rejectedStartup({
      ...invalidState.base,
      status: 'config_invalid',
      activationPlan: invalidState.activationPlan,
    });
  }

  // An unparseable overlay cannot be simulated, so it is rejected here.
  const preexistingOverlay = loadCharacterOverlayForStartup(runtimeLocation);
  const unreadableOverlay =
    blockingRuntimeConfigLayerDiagnostic(preexistingOverlay);

  if (unreadableOverlay !== undefined) {
    const invalidState = buildPlanState(preexistingOverlay);

    return rejectedStartup({
      ...invalidState.base,
      status: 'config_invalid',
      activationPlan: invalidState.activationPlan,
    });
  }

  const preMaterializationState = buildPlanState(preexistingOverlay);
  const preflight = prepareCharacterMaterializationPreflight({
    expectations: characterActivation.definition.plugins,
    plan: preMaterializationState.activationPlan,
    catalogSnapshot: preMaterializationState.catalogSnapshot,
  });

  if (preflight.diagnostics.length > 0) {
    return rejectedStartup({
      ...preMaterializationState.base,
      status: 'config_invalid',
      activationPlan: withActivationDiagnostics(
        preMaterializationState.activationPlan,
        preflight.diagnostics,
      ),
    });
  }

  if (preflight.packagePlan.status !== 'ready') {
    throw new TypeError('Character package materialization planning drifted.');
  }

  const materializationManifests = Object.values(
    preMaterializationState.activationPlan.catalogEntries,
  ).map(entry => entry.manifest);
  // The overlay as it will be, so later decisions judge the committed state.
  const simulated = simulateCharacterMaterialization({
    runtimeLocation,
    characterActivation,
    document: preflight.packagePlan.document,
    pluginManifests: materializationManifests,
  });

  if (simulated.status === 'invalid') {
    return rejectedStartup({
      ...preMaterializationState.base,
      status: 'config_invalid',
      activationPlan: withActivationDiagnostics(
        preMaterializationState.activationPlan,
        [
          withRuntimeConfigDiagnosticOrigin(
            createRuntimeConfigDiagnostic(
              'error',
              'character_config_candidate_invalid',
              simulated.message,
            ),
            {
              scope: 'character',
              characterId: characterActivation.profile.id,
              path: runtimeLocation.overlayPath,
            },
          ),
        ],
      ),
    });
  }

  return Object.freeze({
    outcome: 'committable',
    plan: Object.freeze({
      startupBase: input.startupBase,
      loadedConfig,
      characterActivation,
      runtimeLocation,
      buildPlanState,
      document: preflight.packagePlan.document,
      pluginManifests: materializationManifests,
      simulatedOverlay: simulated.overlay,
    }),
  });
}

/** Phase two: the durable write; every rejection here comes from it. */
async function commitPlannedRuntimeCliActivationStartup(
  plan: PlannedRuntimeCliActivationStartup,
): Promise<RuntimeCliStartupResult> {
  const materialization = await materializeCharacterDataDir({
    characterActivation: plan.characterActivation,
    runtimeLocation: plan.runtimeLocation,
    document: plan.document,
    pluginManifests: plan.pluginManifests,
  });

  if (materialization.status === 'failed') {
    return Object.freeze({
      ...plan.startupBase,
      runtimeLocation: plan.runtimeLocation,
      status: 'character_invalid',
      characterActivation: materialization.characterActivation,
    });
  }

  // Read back from disk: the commit is what made these bytes.
  return finishRuntimeCliActivationStartup({
    plan,
    overlayLoadedConfig: loadCharacterOverlayForStartup(plan.runtimeLocation),
    diagnostics: materialization.diagnostics,
  });
}

/** Phase two without the write, finished from the simulated overlay. */
function simulatePlannedRuntimeCliActivationStartup(
  plan: PlannedRuntimeCliActivationStartup,
): RuntimeCliStartupResult {
  return finishRuntimeCliActivationStartup({
    plan,
    overlayLoadedConfig: plan.simulatedOverlay,
    diagnostics: Object.freeze([]),
  });
}

function finishRuntimeCliActivationStartup(input: {
  readonly plan: PlannedRuntimeCliActivationStartup;
  readonly overlayLoadedConfig: LoadedProject02CharacterOverlayConfig;
  readonly diagnostics: PreparedProject02PluginActivationPlan['activation']['diagnostics'];
}): RuntimeCliStartupResult {
  const {loadedConfig, buildPlanState} = input.plan;
  const {activationPlan: unadornedActivationPlan, base} = buildPlanState(
    input.overlayLoadedConfig,
  );
  const activationPlan = withActivationDiagnostics(
    unadornedActivationPlan,
    input.diagnostics,
  );

  return Object.freeze({
    ...base,
    status: startupConfigHasErrors(loadedConfig, input.overlayLoadedConfig)
      ? 'config_invalid'
      : 'resolved',
    activationPlan,
  });
}

type CharacterMaterializationInput = {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly document: Project02RuntimeConfig;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
};

/** The simulation and the commit must judge the same operation. */
function characterMaterializationOperation(
  input: CharacterMaterializationInput,
  materializedPackageVersion: string | undefined,
) {
  return {
    target: resolveRuntimeConfigScopeTarget({
      runtimeLocation: input.runtimeLocation,
      scope: 'character',
    }),
    sections: createRuntimeConfigSections({plugins: input.pluginManifests}),
    characterMaterialization: {
      document: input.document,
      fillMissingFields:
        materializedPackageVersion !==
        input.characterActivation.definition.meta.version,
    },
  };
}

/** Read-only twin of materializeCharacterDataDir: no marker required. */
function simulateCharacterMaterialization(
  input: CharacterMaterializationInput,
):
  | {
      readonly status: 'valid';
      readonly overlay: LoadedProject02CharacterOverlayConfig;
    }
  | {readonly status: 'invalid'; readonly message: string} {
  const characterId = input.characterActivation.profile.id;
  const marker = readCharacterDataMarkerForStartup(input.runtimeLocation);
  const simulated = simulateCharacterOverlayCandidate(
    characterMaterializationOperation(
      input,
      marker?.materializedCharacterPackageVersion,
    ),
  );

  // No expectation is passed here, so only a document can be refused.
  if (simulated.status !== 'valid') {
    return {status: 'invalid', message: simulated.message};
  }

  // This overlay describes a file that has not been written yet.
  return Object.freeze({
    status: 'valid',
    overlay: Object.freeze({
      scope: 'character',
      characterId,
      source: 'overlay',
      path: input.runtimeLocation.overlayPath,
      config: simulated.document,
      diagnostics: Object.freeze([]),
    } satisfies LoadedProject02CharacterOverlayConfig),
  });
}

/** The overlay commits before the marker records the package version. */
async function materializeCharacterDataDir(
  input: CharacterMaterializationInput,
): Promise<
  | {
      readonly status: 'resolved';
      readonly diagnostics: readonly RuntimeConfigDiagnostic[];
    }
  | {
      readonly status: 'failed';
      readonly characterActivation: Extract<
        Project02CharacterActivation,
        {status: 'failed'}
      >;
    }
> {
  const characterId = input.characterActivation.profile.id;

  try {
    assertResolvedProject02HomeAdoptable(input.runtimeLocation);
    const dataRoot = await ensureCharacterDataDir({
      homeRoot: input.runtimeLocation.homeRoot,
      characterId,
    });
    const marker = requireCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId,
    });
    const applied = applyRuntimeConfigControlOperation(
      characterMaterializationOperation(
        input,
        marker.materializedCharacterPackageVersion,
      ),
    );

    await recordMaterializedCharacterPackageVersion({
      storageOptions: {storeRoot: dataRoot},
      characterId,
      packageVersion: input.characterActivation.definition.meta.version,
    });

    return Object.freeze({
      status: 'resolved',
      diagnostics: Object.freeze(
        applied.materialization.autoEnabledPluginIds
          .filter(
            pluginId => applied.config.plugins?.[pluginId]?.enabled === true,
          )
          .map(pluginId =>
            createRuntimeConfigDiagnostic(
              'warning',
              'character_package_plugin_auto_enabled',
              `Character package "${characterId}" enabled plugin "${pluginId}" in the character config.`,
              `${runtimeConfigSectionPath('plugins', pluginId)}.enabled`,
              {namespace: 'plugins', id: pluginId},
            ),
          ),
      ),
    });
  } catch (error: unknown) {
    // Only an identity mismatch is character-shaped; other errors rethrow.
    if (
      error instanceof LocalRuntimeStorageContractError &&
      error.code === 'character_identity_mismatch'
    ) {
      return Object.freeze({
        status: 'failed',
        characterActivation: Object.freeze({
          status: 'failed',
          configuredCharacterId: characterId,
          messages: Object.freeze([error.message]),
        }),
      });
    }

    throw error;
  }
}

function prepareCharacterMaterializationPreflight(options: {
  readonly expectations: CharacterPluginExpectations | undefined;
  readonly plan: PreparedProject02PluginActivationPlan;
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot | undefined;
}) {
  const packagePlan = planCharacterPackagePluginMaterialization({
    expectations: options.expectations,
    pluginManifests: Object.values(options.plan.catalogEntries).map(
      entry => entry.manifest,
    ),
  });

  return Object.freeze({
    packagePlan,
    diagnostics: Object.freeze([
      ...(packagePlan.status === 'invalid' ? packagePlan.diagnostics : []),
      ...materializationConfigPreflightDiagnostics(options.plan),
      ...declaredInvalidPackageDiagnostics({
        expectations: options.expectations,
        catalogSnapshot: options.catalogSnapshot,
      }),
    ]),
  });
}

/** Only errors no write could fix belong here. */
function materializationConfigPreflightDiagnostics(
  plan: PreparedProject02PluginActivationPlan,
): readonly RuntimeConfigDiagnostic[] {
  return Object.freeze(
    plan.resolvedConfig.diagnostics.filter(
      diagnostic =>
        diagnostic.severity === 'error' &&
        runtimeConfigDiagnosticConcernsCharacter(diagnostic) &&
        // A missing credential is one plugin's readiness failure, reported
        // by activation; it does not make the document invalid.
        !runtimeConfigDiagnosticIsReadinessFailure(diagnostic) &&
        // The simulated candidate is the authority on overlay errors.
        diagnostic.origin?.scope !== 'character',
    ),
  );
}

function declaredInvalidPackageDiagnostics(options: {
  readonly expectations: CharacterPluginExpectations | undefined;
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot | undefined;
}): readonly RuntimeConfigDiagnostic[] {
  if (
    options.expectations === undefined ||
    options.catalogSnapshot === undefined
  ) {
    return Object.freeze([]);
  }

  const declaredIds = new Set([
    ...options.expectations.required,
    ...options.expectations.recommended,
    ...Object.keys(options.expectations.config),
  ]);

  return Object.freeze(
    options.catalogSnapshot.diagnostics
      .filter(
        diagnostic =>
          diagnostic.code.startsWith('runtime_plugin_package_') &&
          diagnostic.scope === 'section' &&
          declaredIds.has(diagnostic.id),
      )
      .map(diagnostic =>
        Object.freeze({
          ...diagnostic,
          severity: 'error' as const,
        }),
      ),
  );
}

function startupConfigHasErrors(
  loadedConfig: LoadedProject02RuntimeConfig,
  overlayLoadedConfig: LoadedProject02CharacterOverlayConfig | undefined,
): boolean {
  return (
    diagnosticsHaveErrors(loadedConfig.diagnostics) ||
    (overlayLoadedConfig !== undefined &&
      diagnosticsHaveErrors(overlayLoadedConfig.diagnostics))
  );
}

function loadCharacterOverlayForStartup(
  runtimeLocation: ResolvedProject02RuntimeLocation,
): LoadedProject02CharacterOverlayConfig {
  // The guarded loader applies marker and adoptability rules to reads too.
  return readCharacterOverlayForScope(runtimeLocation.characterScope).overlay;
}

function readCharacterDataMarkerForStartup(
  runtimeLocation: ResolvedProject02RuntimeLocation,
): LocalRuntimeCharacterDataStorageSchemaMarker | undefined {
  return readCharacterOverlayForScope(runtimeLocation.characterScope).marker;
}

function prepareActivationPlan(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
  readonly overlayLoadedConfig?: LoadedProject02CharacterOverlayConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly validateInactivePluginConfigs?: boolean;
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot;
}): PreparedProject02PluginActivationPlan {
  const plan = prepareConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    runtimeLocation: options.runtimeLocation,
    ...(options.overlayLoadedConfig === undefined
      ? {}
      : {overlayConfig: options.overlayLoadedConfig}),
    validateInactivePluginConfigs:
      options.validateInactivePluginConfigs === true,
    catalogSnapshot: options.catalogSnapshot,
  });
  const enforcement = enforceCharacterPluginExpectations({
    expectations: options.characterActivation.definition.plugins,
    characterId: options.characterActivation.profile.id,
    activation: plan.activation,
    installedPluginIds: new Set(Object.keys(plan.catalogEntries)),
  });

  return enforcement.length === 0
    ? plan
    : withActivationDiagnostics(plan, enforcement);
}

function withActivationDiagnostics(
  plan: PreparedProject02PluginActivationPlan,
  extraDiagnostics: readonly RuntimeConfigDiagnostic[],
): PreparedProject02PluginActivationPlan {
  return Object.freeze({
    ...plan,
    activation: Object.freeze({
      ...plan.activation,
      diagnostics: Object.freeze([
        ...plan.activation.diagnostics,
        ...extraDiagnostics,
      ]),
    }),
  });
}
