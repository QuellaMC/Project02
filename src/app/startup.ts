import {
  createRuntimePluginCatalogSnapshot,
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
  characterOverlaySeedDocument,
  enforceCharacterPluginExpectations,
} from './character-plugins.ts';
import {
  defaultDotEnvForRuntimeLocation,
  defaultProject02CharacterId,
  deriveRuntimeConfigCharacterScope,
  diagnosticsHaveErrors,
  ensureCharacterDataDir,
  loadCharacterOverlayForScope,
  loadProject02RuntimeConfig,
  loadRuntimeConfigEnvFile,
  readDefaultDotEnvFile,
  resolveProject02RuntimeStoreRoot,
  shouldReadDefaultDotEnvForRuntimeLocation,
  type LoadedProject02CharacterOverlayConfig,
  type LoadedProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeLocationCliState,
} from '../runtime/config/index.ts';
import {LocalRuntimeStorageContractError} from '../runtime/storage/index.ts';

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
   * 'materialize' (writers: chat, relay) initializes the character-data
   * directory — home guard, binding stamp, first-selection overlay seed
   * — before the overlay is read. 'readonly' (default: inspect, config
   * verbs) never creates or writes anything.
   */
  readonly dataDir?: 'materialize' | 'readonly';
};

type RuntimeCliConfigStartupOptions = RuntimeCliStartupCommonOptions & {
  readonly stage: 'config';
};

type RuntimeCliStartupOptions =
  RuntimeCliActivationStartupOptions | RuntimeCliConfigStartupOptions;

type RuntimeCliStartupBase = {
  readonly location: RuntimeLocationCliState;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
};

type RuntimeCliConfigStartupResult = RuntimeCliStartupBase;

type RuntimeCliActivationStartupBase = RuntimeCliStartupBase & {
  readonly characterActivation: Project02CharacterActivation;
  readonly overlayLoadedConfig?: LoadedProject02CharacterOverlayConfig;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
  readonly activationPlan: PreparedProject02PluginActivationPlan;
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
  const loadedConfig = loadProject02RuntimeConfig({
    ...location,
    env: configEnv,
  });
  const startupBase = {
    location,
    cwdDotEnv,
    configEnv,
    loadedConfig,
  };

  if (options.stage === 'config') {
    return Object.freeze(startupBase);
  }

  return resolveRuntimeCliActivationStartup({
    options,
    location,
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
 * plugin resources exist yet), then — for writers — the character-data
 * initialization with the package's first-selection overlay seed, then
 * the overlay read, plugin activation over both config layers, and the
 * character's plugin expectations merged into the activation
 * diagnostics.
 */
async function resolveRuntimeCliActivationStartup(input: {
  readonly options: RuntimeCliActivationStartupOptions;
  readonly location: RuntimeLocationCliState;
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly startupBase: RuntimeCliStartupBase;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
}): Promise<RuntimeCliStartupResult> {
  const {options, location, loadedConfig} = input;
  const activeCharacterId =
    loadedConfig.config?.project02?.character ?? defaultProject02CharacterId;
  const homeRoot = resolveProject02RuntimeStoreRoot({
    loadedConfig,
    ...(location.storeRoot === undefined
      ? {}
      : {storeRoot: location.storeRoot}),
  });
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

  if (options.dataDir === 'materialize') {
    const failure = await materializeCharacterDataDir({
      homeRoot,
      characterActivation,
    });

    if (failure !== undefined) {
      return Object.freeze({
        ...input.startupBase,
        status: 'character_invalid',
        characterActivation: failure,
      });
    }
  }

  const overlayLoadedConfig = loadCharacterOverlayForStartup({
    loadedConfig,
    location,
  });
  const overlayForPlan =
    overlayLoadedConfig === undefined ? {} : {overlayLoadedConfig};
  const catalogSnapshot =
    options.factories === undefined
      ? createRuntimePluginCatalogSnapshot({
          loadedConfig,
          ...(location.storeRoot === undefined
            ? {}
            : {storeRoot: location.storeRoot}),
        })
      : undefined;
  const activationPlanBeforeRuntimeEnv = prepareActivationPlan({
    loadedConfig,
    characterActivation,
    ...overlayForPlan,
    location,
    env: input.configEnv,
    ...(options.factories === undefined ? {} : {factories: options.factories}),
    ...(catalogSnapshot === undefined ? {} : {catalogSnapshot}),
  });
  const base = {
    ...input.startupBase,
    characterActivation,
    ...overlayForPlan,
    ...(catalogSnapshot === undefined ? {} : {catalogSnapshot}),
  };

  if (startupConfigHasErrors(loadedConfig, overlayLoadedConfig)) {
    return Object.freeze({
      ...base,
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
      ...base,
      status: 'activation_blocked_before_runtime_env',
      activationPlan: activationPlanBeforeRuntimeEnv,
    });
  }

  const runtimeEnv = loadRuntimeEnv({
    loadedConfig,
    location,
    suppliedEnv: input.suppliedEnv,
    cwdDotEnv: input.cwdDotEnv,
  });
  const activationPlan = prepareActivationPlan({
    loadedConfig,
    characterActivation,
    ...overlayForPlan,
    location,
    env: runtimeEnv,
    ...(options.factories === undefined ? {} : {factories: options.factories}),
    ...(catalogSnapshot === undefined ? {} : {catalogSnapshot}),
  });

  return Object.freeze({
    ...base,
    status: 'resolved',
    runtimeEnv,
    activationPlan,
  });
}

/**
 * Writer-side character-data initialization. Returns a failed
 * character activation instead of throwing so every character-shaped
 * problem exits through the same character_invalid status.
 */
async function materializeCharacterDataDir(input: {
  readonly homeRoot: string;
  readonly characterActivation: Extract<
    Project02CharacterActivation,
    {status: 'resolved'}
  >;
}): Promise<
  Extract<Project02CharacterActivation, {status: 'failed'}> | undefined
> {
  const characterId = input.characterActivation.profile.id;
  const seed = characterOverlaySeedDocument(
    input.characterActivation.definition.plugins,
  );

  if (seed.status === 'invalid') {
    return Object.freeze({
      status: 'failed',
      configuredCharacterId: characterId,
      messages: seed.messages,
    });
  }

  try {
    await ensureCharacterDataDir({
      homeRoot: input.homeRoot,
      characterId,
      ...(seed.status === 'seed' ? {seedDocument: seed.document} : {}),
    });
  } catch (error: unknown) {
    // Only a binding rejection is character-shaped (wrong character for
    // this data directory); every other storage error keeps its own
    // formatted identity through the caller's terminal-error path.
    if (
      error instanceof LocalRuntimeStorageContractError &&
      error.code === 'character_binding_rejected'
    ) {
      return Object.freeze({
        status: 'failed',
        configuredCharacterId: characterId,
        messages: Object.freeze([error.message]),
      });
    }

    throw error;
  }

  return undefined;
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
function loadCharacterOverlayForStartup(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly location: RuntimeLocationCliState;
}): LoadedProject02CharacterOverlayConfig | undefined {
  const characterScope = deriveRuntimeConfigCharacterScope({
    loadedConfig: options.loadedConfig,
    ...(options.location.storeRoot === undefined
      ? {}
      : {storeRoot: options.location.storeRoot}),
  });

  return characterScope === undefined
    ? undefined
    : loadCharacterOverlayForScope(characterScope);
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
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly location: RuntimeLocationCliState;
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return Object.freeze(
    loadRuntimeConfigEnvFile({
      loadedConfig: options.loadedConfig,
      ...(options.location.storeRoot === undefined
        ? {}
        : {storeRoot: options.location.storeRoot}),
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
  readonly location: RuntimeLocationCliState;
  readonly env: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
}): PreparedProject02PluginActivationPlan {
  const plan = prepareConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    ...(options.overlayLoadedConfig === undefined
      ? {}
      : {overlayConfig: options.overlayLoadedConfig}),
    ...(options.location.storeRoot === undefined
      ? {}
      : {storeRoot: options.location.storeRoot}),
    env: options.env,
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
