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
  type Project02CharacterActivation,
} from './character.ts';
import {
  enforceCharacterPluginExpectations,
  planCharacterPackagePluginMaterialization,
} from './character-plugins.ts';
import type {CharacterPluginExpectations} from '../characters/index.ts';
import {
  applyRuntimeConfigControlOperation,
  assertResolvedProject02HomeAdoptable,
  assertScopedMutationOperationAllowed,
  bindProject02CharacterRuntimeLocation,
  createLayeredProject02RuntimeConfigSnapshot,
  createRuntimeConfigDiagnostic,
  configuredProject02CharacterId,
  defaultDotEnvForRuntimeLocation,
  diagnosticsHaveErrors,
  readCharacterOverlayForScope,
  loadProject02RuntimeConfigWithLocation,
  loadRuntimeConfigEnvFile,
  readDefaultDotEnvFile,
  resolveRuntimeConfigScopeTarget,
  RuntimeConfigMutationError,
  runtimeConfigDiagnosticIsReadinessFailure,
  shouldReadDefaultDotEnvForRuntimeLocation,
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
  /**
   * Optional first scoped edit. The initializer composes it with
   * package materialization and commits one locked overlay candidate.
   */
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

type RuntimeCliStartupOptions =
  RuntimeCliActivationStartupOptions | RuntimeCliConfigStartupOptions;

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
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  readonly characterConfigMutation?: RuntimeConfigControlApplyResult;
};

type RuntimeCliStartupResult =
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

/**
 * The one character-runtime initializer for embedded consumers: runs
 * the exact CLI startup sequence — character activation, guarded
 * character-data materialization with package-config defaults, layered
 * activation planning — and throws on any non-resolved outcome instead
 * of returning CLI statuses. Host construction is downstream of this:
 * createConfiguredProject02PluginHostFromPlan refuses uninitialized
 * character state instead of creating it.
 */
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
  options?: RuntimeCliActivationStartupOptions,
): Promise<RuntimeCliStartupResult>;
export function resolveRuntimeCliStartup(
  options: RuntimeCliStartupOptions = {},
): RuntimeCliConfigStartupResult | Promise<RuntimeCliStartupResult> {
  const location = Object.freeze({...(options.location ?? {})});
  const suppliedEnv = options.env ?? process.env;
  const cwdDotEnv = resolveCwdDotEnv({
    location,
    suppliedEnv,
    mode: options.cwdDotEnv ?? 'auto',
    mayReadProcessCwd: options.env === undefined || options.env === process.env,
  });
  const configEnv = Object.freeze({...cwdDotEnv, ...suppliedEnv});
  const {loadedConfig, configLocation} = loadProject02RuntimeConfigWithLocation(
    {
      selection: location,
      env: configEnv,
    },
  );
  const startupBase = {
    runtimeLocation: configLocation,
    cwdDotEnv,
    configEnv,
    loadedConfig,
  };

  if (options.stage === 'config') {
    return Object.freeze(startupBase);
  }

  return resolveRuntimeCliActivationStartup({
    options,
    configLocation,
    ...(location.character === undefined
      ? {}
      : {characterOverride: location.character}),
    suppliedEnv,
    cwdDotEnv,
    configEnv,
    startupBase,
    loadedConfig,
  });
}

/**
 * The one activation-stage sequence every CLI shares: character
 * activation first (a bad selection is a character_invalid, and no
 * plugin resources exist yet), then character-data initialization for
 * every selected-character surface, then the overlay read and activation over both
 * config layers, and the character's plugin expectations merged into
 * the activation diagnostics.
 */
async function resolveRuntimeCliActivationStartup(input: {
  readonly options: RuntimeCliActivationStartupOptions;
  readonly configLocation: ResolvedProject02ConfigLocation;
  readonly characterOverride?: string;
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly startupBase: RuntimeCliStartupBase;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
}): Promise<RuntimeCliStartupResult> {
  const {options, configLocation, loadedConfig} = input;
  const activeCharacterId = configuredProject02CharacterId(
    loadedConfig.config,
    input.characterOverride,
  );
  const homeRoot = configLocation.homeRoot;
  const characterActivation = prepareProject02CharacterActivation({
    storeRoot: homeRoot,
    configuredCharacterId: activeCharacterId,
  });

  if (characterActivation.status === 'failed') {
    return Object.freeze({
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

  assertResolvedProject02HomeAdoptable(runtimeLocation);

  // One filesystem discovery for the whole startup: every activation
  // plan — pre-materialization, post-materialization, and the final
  // runtime-env one — judges the same manifest snapshot, and only the
  // diagnostic classification re-runs as the overlay state changes.
  const catalogDiscovery = discoverRuntimePluginCatalog({
    storeRoot: homeRoot,
    ...(options.factories === undefined
      ? {}
      : {factoryOverrides: options.factories}),
  });
  const buildPreEnvState = (
    overlayLoadedConfig: LoadedProject02CharacterOverlayConfig | undefined,
  ) => {
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

  // An invalid global config must not create durable state: report it
  // (with the overlay read-only for attribution) before the home,
  // or identity marker would be written.
  if (diagnosticsHaveErrors(loadedConfig.diagnostics)) {
    const invalidState = buildPreEnvState(
      loadCharacterOverlayForStartup(runtimeLocation),
    );

    return Object.freeze({
      ...invalidState.base,
      status: 'config_invalid',
      activationPlan: invalidState.activationPlanBeforeRuntimeEnv,
    });
  }

  // An invalid pre-existing overlay must not create durable state
  // either: read it before the home or character marker would be written.
  const preexistingOverlay = loadCharacterOverlayForStartup(runtimeLocation);

  if (diagnosticsHaveErrors(preexistingOverlay.diagnostics)) {
    const invalidState = buildPreEnvState(preexistingOverlay);

    return Object.freeze({
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
    request: options.characterConfigRequest,
  });

  if (preflight.diagnostics.length > 0) {
    return Object.freeze({
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

  const materialization = await materializeCharacterDataDir({
    characterActivation,
    runtimeLocation,
    configEnv: input.configEnv,
    document: preflight.packagePlan.document,
    ...(preflight.request === undefined ? {} : {request: preflight.request}),
  });

  if (materialization.status === 'failed') {
    return Object.freeze({
      ...input.startupBase,
      runtimeLocation,
      status: 'character_invalid',
      characterActivation: materialization.characterActivation,
    });
  }

  const overlayLoadedConfig = loadCharacterOverlayForStartup(runtimeLocation);
  const {
    overlayForPlan,
    catalogSnapshot,
    activationPlanBeforeRuntimeEnv: unadornedActivationPlanBeforeRuntimeEnv,
    base,
  } = buildPreEnvState(overlayLoadedConfig);
  const materializedBase = {
    ...base,
    ...(materialization.configMutation === undefined
      ? {}
      : {characterConfigMutation: materialization.configMutation}),
  };
  const activationPlanBeforeRuntimeEnv = withActivationDiagnostics(
    unadornedActivationPlanBeforeRuntimeEnv,
    materialization.diagnostics,
  );

  if (startupConfigHasErrors(loadedConfig, overlayLoadedConfig)) {
    return Object.freeze({
      ...materializedBase,
      status: 'config_invalid',
      activationPlan: activationPlanBeforeRuntimeEnv,
    });
  }

  if (
    options.continueAfterActivationErrors !== true &&
    activationDiagnosticsCanBypassRuntimeEnvFile(
      activationPlanBeforeRuntimeEnv.activation.diagnostics,
    )
  ) {
    return Object.freeze({
      ...materializedBase,
      status: 'activation_blocked_before_runtime_env',
      activationPlan: activationPlanBeforeRuntimeEnv,
    });
  }

  const runtimeEnv = loadRuntimeEnv({
    runtimeLocation,
    suppliedEnv: input.suppliedEnv,
    cwdDotEnv: input.cwdDotEnv,
  });
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
    materialization.diagnostics,
  );

  return Object.freeze({
    ...materializedBase,
    status: 'resolved',
    runtimeEnv,
    activationPlan,
  });
}

/**
 * Character selection initialization. The package plan and any
 * existing config were validated before this function runs. It commits
 * the overlay first through the target-aware config seam, then records
 * the package version in the data marker.
 */
async function materializeCharacterDataDir(input: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly document: Project02RuntimeConfig;
  readonly request?: RuntimeConfigControlRequest;
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
}): Promise<
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
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: input.runtimeLocation,
      env: input.configEnv,
      scope: 'character',
    });
    const applied = applyRuntimeConfigControlOperation({
      target,
      characterMaterialization: {
        document: input.document,
        fillMissingFields:
          marker.materializedCharacterPackageVersion !==
          input.characterActivation.definition.meta.version,
      },
      ...(input.request === undefined ? {} : {request: input.request}),
    });

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
    // Only an identity mismatch is character-shaped (wrong character for
    // this data directory); every other storage error keeps its own
    // formatted identity through the caller's terminal-error path.
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

  const definition = options.plan.catalogEntries[options.request.pluginId];

  if (
    definition === undefined ||
    definition.manifest.id !== options.request.pluginId
  ) {
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

function materializationConfigPreflightDiagnostics(
  plan: PreparedProject02PluginActivationPlan,
): readonly RuntimeConfigDiagnostic[] {
  return Object.freeze(
    plan.resolvedConfig.diagnostics.filter(
      diagnostic =>
        diagnostic.severity === 'error' &&
        // Readiness failures are not proof that an authored document is
        // malformed (runtime .env also loads only after durable
        // initialization); every other error describes an invalid
        // authored global or overlay value and must fail before
        // materialization writes anything.
        !runtimeConfigDiagnosticIsReadinessFailure(diagnostic),
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

/**
 * The overlay location derives from the loaded global config alone: the
 * home root plus the configured character id. A store root or character
 * id the storage layer rejects fails startup later with its own
 * diagnostic; the overlay simply does not exist for it.
 */
function loadCharacterOverlayForStartup(
  runtimeLocation: ResolvedProject02RuntimeLocation,
): LoadedProject02CharacterOverlayConfig {
  // The guarded loader holds the marker and adoptability rules for
  // read-only startups too: a data directory marked for another
  // character, holding foreign content, or reached through a symlink
  // fails check and inspect exactly as durable materialization does.
  return readCharacterOverlayForScope(runtimeLocation.characterScope).overlay;
}

function resolveCwdDotEnv(options: {
  readonly location: RuntimeLocationCliState;
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly mayReadProcessCwd: boolean;
  readonly mode: 'auto' | 'always';
}): NodeJS.ProcessEnv {
  if (
    !options.mayReadProcessCwd ||
    (options.mode === 'auto' &&
      !shouldReadDefaultDotEnvForRuntimeLocation({
        location: options.location,
        env: options.suppliedEnv,
      }))
  ) {
    return Object.freeze({});
  }

  return Object.freeze(
    defaultDotEnvForRuntimeLocation(readDefaultDotEnvFile(), options.location),
  );
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
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
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
    ...(options.factories === undefined ? {} : {factories: options.factories}),
    ...(options.catalogSnapshot === undefined
      ? {}
      : {catalogSnapshot: options.catalogSnapshot}),
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

function activationDiagnosticsCanBypassRuntimeEnvFile(
  diagnostics: PreparedProject02PluginActivationPlan['activation']['diagnostics'],
): boolean {
  const errors = diagnostics.filter(
    diagnostic => diagnostic.severity === 'error',
  );

  return (
    errors.length > 0 &&
    errors.every(
      diagnostic =>
        diagnostic.code !== 'runtime_config_required_secret_missing',
    )
  );
}
