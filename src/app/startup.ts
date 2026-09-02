import {
  classifyRuntimePluginCatalogDiscovery,
  discoverRuntimePluginCatalog,
  prepareConfiguredProject02PluginActivation,
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
import {installedRuntimePluginCatalogEntry} from '../plugins/index.ts';
import type {CharacterPluginExpectations} from '../characters/index.ts';
import type {RuntimePluginManifest} from '../plugins/api/index.ts';
import {loadProject02Home, type Project02Home} from './home.ts';
import {
  applyRuntimeConfigControlOperation,
  assertResolvedProject02HomeAdoptable,
  assertScopedMutationOperationAllowed,
  bindProject02CharacterRuntimeLocation,
  blockingRuntimeConfigLayerDiagnostic,
  createLayeredProject02RuntimeConfigSnapshot,
  createRuntimeConfigDiagnostic,
  diagnosticsHaveErrors,
  loadCharacterSecretsEnv,
  readCharacterOverlayForScope,
  loadRuntimeConfigEnvFile,
  resolveRuntimeConfigScopeTarget,
  RuntimeConfigMutationError,
  runtimeConfigDiagnosticIsReadinessFailure,
  simulateCharacterOverlayCandidate,
  withRuntimeConfigDiagnosticOrigin,
  type LoadedProject02CharacterOverlayConfig,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RuntimeConfigControlApplyResult,
  type RuntimeConfigControlOperation,
  type RuntimeConfigControlRequest,
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
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly cwdDotEnv?: 'auto' | 'always';
};

type RuntimeCliActivationStartupOptions = RuntimeCliStartupCommonOptions & {
  readonly stage?: 'activation';
  readonly continueAfterActivationErrors?: boolean;
  /** Throwing here rejects the startup before anything durable is written. */
  readonly validateRuntimeEnv?: (env: NodeJS.ProcessEnv) => void;
  /** Composed with package materialization into one locked overlay commit. */
  readonly characterConfigRequest?:
    | {
        readonly kind: 'document';
        readonly operation: RuntimeConfigControlOperation;
      }
    | {
        readonly kind: 'plugin_activation';
        readonly pluginId: string;
        readonly enabled: boolean;
      };
};

type RuntimeCliConfigStartupOptions = RuntimeCliStartupCommonOptions & {
  readonly stage: 'config';
};

/** Same decisions and rejections as an activation startup, but no write. */
type RuntimeCliReportStartupOptions = Omit<
  RuntimeCliActivationStartupOptions,
  'stage' | 'characterConfigRequest'
> & {
  readonly stage: 'report';
};

type RuntimeCliStartupOptions =
  | RuntimeCliActivationStartupOptions
  | RuntimeCliConfigStartupOptions
  | RuntimeCliReportStartupOptions;

type RuntimeCliCharacterConfigRequest = NonNullable<
  RuntimeCliActivationStartupOptions['characterConfigRequest']
>;

type RuntimeCliStartupBase = {
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
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
  readonly characterConfigMutation?: RuntimeConfigControlApplyResult;
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
      readonly status: 'activation_blocked_before_runtime_env';
    })
  | (RuntimeCliActivationStartupBase & {
      readonly status: 'resolved';
      readonly runtimeEnv: NodeJS.ProcessEnv;
    });

type StartupPreEnvState = {
  readonly overlayForPlan:
    | Record<string, never>
    | {readonly overlayLoadedConfig: LoadedProject02CharacterOverlayConfig};
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot;
  readonly activationPlanBeforeRuntimeEnv: PreparedProject02PluginActivationPlan;
  // Each exit pairs its own plan with the status that describes it.
  readonly base: Omit<RuntimeCliActivationStartupBase, 'activationPlan'>;
};

/** A startup that survived every rejection except the write itself. */
type PlannedRuntimeCliActivationStartup = {
  readonly startupBase: RuntimeCliStartupBase;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly buildPreEnvState: (
    overlayLoadedConfig: LoadedProject02CharacterOverlayConfig | undefined,
  ) => StartupPreEnvState;
  readonly readRuntimeEnvFileUnlessBlocked: (
    diagnostics: PreparedProject02PluginActivationPlan['activation']['diagnostics'],
  ) => NodeJS.ProcessEnv | undefined;
  readonly document: Project02RuntimeConfig;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly request?: RuntimeConfigControlRequest;
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
  options: RuntimeCliStartupCommonOptions & {
    readonly continueAfterActivationErrors?: boolean;
  } = {},
): Promise<{
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  readonly runtimeEnv: NodeJS.ProcessEnv;
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

  if (startup.status !== 'resolved') {
    const blocking =
      startup.activationPlan.activation.diagnostics.find(
        diagnostic => diagnostic.severity === 'error',
      ) ??
      startup.loadedConfig.diagnostics.find(
        diagnostic => diagnostic.severity === 'error',
      );

    throw new TypeError(
      `Character runtime initialization failed (${startup.status}): ${
        blocking?.message ?? 'invalid runtime config.'
      }`,
    );
  }

  return Object.freeze({
    characterActivation: startup.characterActivation,
    activationPlan: startup.activationPlan,
    runtimeEnv: startup.runtimeEnv,
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
    ...(options.continueAfterActivationErrors === undefined
      ? {}
      : {continueAfterActivationErrors: options.continueAfterActivationErrors}),
    ...(options.validateRuntimeEnv === undefined
      ? {}
      : {validateRuntimeEnv: options.validateRuntimeEnv}),
  };

  if (options.stage === 'report') {
    return activateProject02Character(home, {...shared, stage: 'report'});
  }

  return activateProject02Character(home, {
    ...shared,
    ...(options.characterConfigRequest === undefined
      ? {}
      : {characterConfigRequest: options.characterConfigRequest}),
  });
}

export type ActivateProject02CharacterOptions = {
  readonly characterId: string;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly continueAfterActivationErrors?: boolean;
  /** Throwing here rejects the startup before anything durable is written. */
  readonly validateRuntimeEnv?: (env: NodeJS.ProcessEnv) => void;
  /** Composed with package materialization into one locked overlay commit. */
  readonly characterConfigRequest?: RuntimeCliCharacterConfigRequest;
};

/**
 * Activates one character against an already-loaded home: package
 * resolution, overlay, plugin activation plan, per-character env. The
 * 'report' stage makes the same decisions without the durable write.
 */
export function activateProject02Character(
  home: Project02Home,
  options: Omit<ActivateProject02CharacterOptions, 'characterConfigRequest'> & {
    readonly stage: 'report';
  },
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
    cwdDotEnv: home.cwdDotEnv,
    configEnv: home.configEnv,
    loadedConfig: home.loadedConfig,
  };
  const activationInput = {
    configLocation: home.runtimeLocation,
    characterId: options.characterId,
    suppliedEnv: home.suppliedEnv,
    cwdDotEnv: home.cwdDotEnv,
    configEnv: home.configEnv,
    startupBase,
    loadedConfig: home.loadedConfig,
  };
  const stagelessOptions = {
    ...(options.factories === undefined ? {} : {factories: options.factories}),
    ...(options.continueAfterActivationErrors === undefined
      ? {}
      : {continueAfterActivationErrors: options.continueAfterActivationErrors}),
    ...(options.validateRuntimeEnv === undefined
      ? {}
      : {validateRuntimeEnv: options.validateRuntimeEnv}),
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
    options: {
      ...stagelessOptions,
      ...(options.characterConfigRequest === undefined
        ? {}
        : {characterConfigRequest: options.characterConfigRequest}),
    },
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
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
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
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
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
  const buildPreEnvState = (
    overlayLoadedConfig: LoadedProject02CharacterOverlayConfig | undefined,
  ): StartupPreEnvState => {
    const overlayForPlan =
      overlayLoadedConfig === undefined ? {} : {overlayLoadedConfig};
    const catalogSnapshot = classifyRuntimePluginCatalogDiscovery({
      discovery: catalogDiscovery,
      classificationConfig: createLayeredProject02RuntimeConfigSnapshot({
        loadedConfig,
        ...(overlayLoadedConfig === undefined
          ? {}
          : {overlayConfig: overlayLoadedConfig}),
      }).effective,
    });

    return {
      overlayForPlan,
      catalogSnapshot,
      activationPlanBeforeRuntimeEnv: prepareActivationPlan({
        loadedConfig,
        characterActivation,
        ...overlayForPlan,
        runtimeLocation,
        env: input.configEnv,
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
    const invalidState = buildPreEnvState(
      loadCharacterOverlayForStartup(runtimeLocation),
    );

    return rejectedStartup({
      ...invalidState.base,
      status: 'config_invalid',
      activationPlan: invalidState.activationPlanBeforeRuntimeEnv,
    });
  }

  // An unparseable overlay cannot be simulated, so it is rejected here.
  const preexistingOverlay = loadCharacterOverlayForStartup(runtimeLocation);
  const unreadableOverlay =
    blockingRuntimeConfigLayerDiagnostic(preexistingOverlay);

  if (unreadableOverlay !== undefined) {
    const invalidState = buildPreEnvState(preexistingOverlay);

    return rejectedStartup({
      ...invalidState.base,
      status: 'config_invalid',
      activationPlan: invalidState.activationPlanBeforeRuntimeEnv,
    });
  }

  const preMaterializationState = buildPreEnvState(preexistingOverlay);
  const preflight = prepareCharacterMaterializationPreflight({
    expectations: characterActivation.definition.plugins,
    plan: preMaterializationState.activationPlanBeforeRuntimeEnv,
    catalogSnapshot: preMaterializationState.catalogSnapshot,
    // A reader describes the store as a run would find it, carrying no edit.
    request:
      options.stage === 'report' ? undefined : options.characterConfigRequest,
  });

  if (preflight.diagnostics.length > 0) {
    return rejectedStartup({
      ...preMaterializationState.base,
      status: 'config_invalid',
      activationPlan: withActivationDiagnostics(
        preMaterializationState.activationPlanBeforeRuntimeEnv,
        preflight.diagnostics,
      ),
    });
  }

  if (preflight.packagePlan.status !== 'ready') {
    throw new TypeError('Character package materialization planning drifted.');
  }

  const materializationManifests = Object.values(
    preMaterializationState.activationPlanBeforeRuntimeEnv.catalogEntries,
  ).map(entry => entry.manifest);
  // The overlay as it will be, so later decisions judge the committed state.
  const simulated = simulateCharacterMaterialization({
    runtimeLocation,
    configEnv: input.configEnv,
    characterActivation,
    document: preflight.packagePlan.document,
    pluginManifests: materializationManifests,
    ...(preflight.request === undefined ? {} : {request: preflight.request}),
  });

  if (simulated.status === 'invalid') {
    return rejectedStartup({
      ...preMaterializationState.base,
      status: 'config_invalid',
      activationPlan: withActivationDiagnostics(
        preMaterializationState.activationPlanBeforeRuntimeEnv,
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

  const plannedState = buildPreEnvState(simulated.overlay);
  const readRuntimeEnvFileUnlessBlocked = createStartupRuntimeEnvFileReader({
    runtimeLocation,
    suppliedEnv: input.suppliedEnv,
    cwdDotEnv: input.cwdDotEnv,
    continueAfterActivationErrors: options.continueAfterActivationErrors,
  });

  // Still phase one: the env file is read while rejecting is still free.
  const plannedRuntimeEnv = readRuntimeEnvFileUnlessBlocked(
    plannedState.activationPlanBeforeRuntimeEnv.activation.diagnostics,
  );

  if (plannedRuntimeEnv !== undefined) {
    options.validateRuntimeEnv?.(plannedRuntimeEnv);
  }

  return Object.freeze({
    outcome: 'committable',
    plan: Object.freeze({
      startupBase: input.startupBase,
      configEnv: input.configEnv,
      loadedConfig,
      characterActivation,
      runtimeLocation,
      buildPreEnvState,
      readRuntimeEnvFileUnlessBlocked,
      document: preflight.packagePlan.document,
      pluginManifests: materializationManifests,
      simulatedOverlay: simulated.overlay,
      ...(preflight.request === undefined ? {} : {request: preflight.request}),
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
    configEnv: plan.configEnv,
    document: plan.document,
    pluginManifests: plan.pluginManifests,
    ...(plan.request === undefined ? {} : {request: plan.request}),
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
    ...(materialization.configMutation === undefined
      ? {}
      : {configMutation: materialization.configMutation}),
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
  readonly configMutation?: RuntimeConfigControlApplyResult;
}): RuntimeCliStartupResult {
  const {
    loadedConfig,
    characterActivation,
    runtimeLocation,
    buildPreEnvState,
    readRuntimeEnvFileUnlessBlocked,
  } = input.plan;
  const {
    overlayForPlan,
    catalogSnapshot,
    activationPlanBeforeRuntimeEnv: unadornedActivationPlanBeforeRuntimeEnv,
    base,
  } = buildPreEnvState(input.overlayLoadedConfig);
  const materializedBase = {
    ...base,
    ...(input.configMutation === undefined
      ? {}
      : {characterConfigMutation: input.configMutation}),
  };
  const activationPlanBeforeRuntimeEnv = withActivationDiagnostics(
    unadornedActivationPlanBeforeRuntimeEnv,
    input.diagnostics,
  );

  if (startupConfigHasErrors(loadedConfig, input.overlayLoadedConfig)) {
    return Object.freeze({
      ...materializedBase,
      status: 'config_invalid',
      activationPlan: activationPlanBeforeRuntimeEnv,
    });
  }

  // Materializing the character can add the error that blocks this startup.
  const runtimeEnv = readRuntimeEnvFileUnlessBlocked(
    activationPlanBeforeRuntimeEnv.activation.diagnostics,
  );

  if (runtimeEnv === undefined) {
    return Object.freeze({
      ...materializedBase,
      status: 'activation_blocked_before_runtime_env',
      activationPlan: activationPlanBeforeRuntimeEnv,
    });
  }

  const activationPlan = withActivationDiagnostics(
    prepareActivationPlan({
      loadedConfig,
      characterActivation,
      ...overlayForPlan,
      runtimeLocation,
      env: runtimeEnv,
      validateInactivePluginConfigs: true,
      catalogSnapshot,
    }),
    input.diagnostics,
  );

  return Object.freeze({
    ...materializedBase,
    status: 'resolved',
    runtimeEnv,
    activationPlan,
  });
}

type CharacterMaterializationInput = {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly document: Project02RuntimeConfig;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly request?: RuntimeConfigControlRequest;
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
      env: input.configEnv,
      scope: 'character',
    }),
    pluginManifests: input.pluginManifests,
    characterMaterialization: {
      document: input.document,
      fillMissingFields:
        materializedPackageVersion !==
        input.characterActivation.definition.meta.version,
    },
    ...(input.request === undefined ? {} : {request: input.request}),
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

  if (simulated.status === 'invalid') {
    return simulated;
  }

  // This overlay describes a file that has not been written yet; the
  // secrets env is the real one already on disk, broken-file diagnostics
  // included, so a reader sees what a real load would see.
  const secrets = loadCharacterSecretsEnv(
    input.runtimeLocation.characterScope.dataRoot,
  );

  return Object.freeze({
    status: 'valid',
    overlay: Object.freeze({
      scope: 'character',
      characterId,
      source: 'overlay',
      path: input.runtimeLocation.overlayPath,
      config: simulated.document,
      secretsEnv: secrets.env,
      diagnostics: Object.freeze(
        secrets.diagnostics.map(diagnostic =>
          withRuntimeConfigDiagnosticOrigin(diagnostic, {
            scope: 'character',
            characterId,
          }),
        ),
      ),
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
      readonly configMutation?: RuntimeConfigControlApplyResult;
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
              `plugins.${pluginId}.enabled`,
              {pluginId},
            ),
          ),
      ),
      ...(input.request === undefined ? {} : {configMutation: applied}),
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

function resolveCharacterConfigStartupRequest(options: {
  readonly request: RuntimeCliCharacterConfigRequest | undefined;
  readonly plan: PreparedProject02PluginActivationPlan;
}): RuntimeConfigControlRequest | undefined {
  if (options.request === undefined) {
    return undefined;
  }

  if (options.request.kind === 'document') {
    assertScopedMutationOperationAllowed(options.request.operation);
    return options.request;
  }

  const definition = installedRuntimePluginCatalogEntry(
    options.plan.catalogEntries,
    options.request.pluginId,
  );

  if (definition === undefined) {
    throw new RuntimeConfigMutationError(
      `Plugin "${options.request.pluginId}" is not installed.`,
    );
  }

  return Object.freeze({
    kind: 'plugin_activation',
    manifest: definition.manifest,
    enabled: options.request.enabled,
  });
}

function prepareCharacterMaterializationPreflight(options: {
  readonly expectations: CharacterPluginExpectations | undefined;
  readonly plan: PreparedProject02PluginActivationPlan;
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot | undefined;
  readonly request: RuntimeCliCharacterConfigRequest | undefined;
}) {
  const request = resolveCharacterConfigStartupRequest({
    request: options.request,
    plan: options.plan,
  });
  const packagePlan = planCharacterPackagePluginMaterialization({
    expectations: options.expectations,
    pluginManifests: Object.values(options.plan.catalogEntries).map(
      entry => entry.manifest,
    ),
  });

  return Object.freeze({
    request,
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
        // The runtime .env loads only after durable initialization.
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
          diagnostic.scope === 'plugin' &&
          declaredIds.has(diagnostic.pluginId),
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

function loadRuntimeEnv(options: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return Object.freeze(
    loadRuntimeConfigEnvFile({
      runtimeLocation: options.runtimeLocation,
      env: options.suppliedEnv,
      envDefaults: options.cwdDotEnv,
    }),
  );
}

function prepareActivationPlan(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
  readonly overlayLoadedConfig?: LoadedProject02CharacterOverlayConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly env: NodeJS.ProcessEnv;
  readonly validateInactivePluginConfigs?: boolean;
  readonly catalogSnapshot: RuntimePluginCatalogSnapshot;
}): PreparedProject02PluginActivationPlan {
  const plan = prepareConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    runtimeLocation: options.runtimeLocation,
    ...(options.overlayLoadedConfig === undefined
      ? {}
      : {overlayConfig: options.overlayLoadedConfig}),
    env: options.env,
    validateInactivePluginConfigs:
      options.validateInactivePluginConfigs === true,
    catalogSnapshot: options.catalogSnapshot,
  });
  const enforcement = enforceCharacterPluginExpectations({
    expectations: options.characterActivation.definition.plugins,
    characterId: options.characterActivation.profile.id,
    activation: plan.activation,
    installedPluginIds: new Set(Object.keys(plan.catalogEntries)),
    storeRoot: plan.resolvedConfig.project02.storeRoot,
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

/** Undefined says the activation is blocked, so the file is not read. */
function createStartupRuntimeEnvFileReader(options: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly continueAfterActivationErrors: boolean | undefined;
}): (
  diagnostics: PreparedProject02PluginActivationPlan['activation']['diagnostics'],
) => NodeJS.ProcessEnv | undefined {
  let cached: NodeJS.ProcessEnv | undefined;

  return diagnostics =>
    startupReadsRuntimeEnvFile({
      continueAfterActivationErrors: options.continueAfterActivationErrors,
      diagnostics,
    })
      ? (cached ??= loadRuntimeEnv({
          runtimeLocation: options.runtimeLocation,
          suppliedEnv: options.suppliedEnv,
          cwdDotEnv: options.cwdDotEnv,
        }))
      : undefined;
}

/**
 * A blocked activation skips the read, so no env-file failure displaces
 * its error. A missing secret is the exception: the env file supplies it.
 */
function startupReadsRuntimeEnvFile(options: {
  readonly continueAfterActivationErrors: boolean | undefined;
  readonly diagnostics: PreparedProject02PluginActivationPlan['activation']['diagnostics'];
}): boolean {
  if (options.continueAfterActivationErrors === true) {
    return true;
  }

  const errors = options.diagnostics.filter(
    diagnostic => diagnostic.severity === 'error',
  );

  return (
    errors.length === 0 ||
    errors.some(
      diagnostic =>
        diagnostic.code === 'runtime_config_required_secret_missing',
    )
  );
}
