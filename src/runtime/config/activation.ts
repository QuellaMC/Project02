import {
  characterStatePluginId,
  createCharacterStatePlugin,
  createCharacterStatePluginManifest
} from '../../plugins/builtin/character-state/index.ts';
import {
  createRuntimePluginHost,
  type RuntimePluginHost
} from '../../plugins/host.ts';
import type {
  RuntimePlugin,
  RuntimePluginKind,
  RuntimePluginManifest
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

export function defaultRuntimePluginFactories(): Readonly<
  Record<string, RuntimePluginFactory>
> {
  return Object.freeze({
    [characterStatePluginId]: Object.freeze({
      manifest: createCharacterStatePluginManifest(),
      create: () => createCharacterStatePlugin()
    } satisfies RuntimePluginFactoryDefinition)
  });
}

export function resolveConfiguredProject02PluginActivation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly strictUnknownPlugins?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactory>>;
}): Project02ConfiguredPluginActivation {
  const factories = options.factories ?? defaultRuntimePluginFactories();
  const legacyFactoryIds = legacyFunctionFactoryIds(factories);
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
}): Promise<Project02ConfiguredPluginHost> {
  const factories = options.factories ?? defaultRuntimePluginFactories();
  const activationPlan = resolveConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    strictUnknownPlugins: options.strictUnknownPlugins === true,
    ...(options.env === undefined ? {} : { env: options.env }),
    factories
  });

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

  const initialStoreRoot = activationPlan.resolvedConfig.storeRoot;
  const loadedConfigHasErrors = diagnosticsHaveErrors(options.loadedConfig.diagnostics);
  const disabledLegacyFactoryIds = explicitlyDisabledLegacyFactoryIds({
    factories,
    loadedConfig: options.loadedConfig
  });
  const preparedFactories = await prepareRuntimePluginFactories({
    factories,
    storeRoot: initialStoreRoot,
    skipLegacyFactoryCreation: loadedConfigHasErrors,
    disabledLegacyFactoryIds
  });
  const resolvedConfig = resolveProject02RuntimeConfig({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    pluginManifests: preparedFactories.map((factory) => factory.manifest),
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const activation = resolveRuntimePluginActivation({
    pluginManifests: preparedFactories.map((factory) => factory.manifest),
    additionalKnownPluginIds: [...disabledLegacyFactoryIds],
    resolvedConfig,
    loadedConfig: options.loadedConfig,
    strictUnknownPlugins: options.strictUnknownPlugins === true
  });
  const plugins = await instantiatePreparedPlugins({
    preparedFactories,
    resolvedConfig,
    enabledPluginIds: activation.enabledPluginIds
  });

  return Object.freeze({
    host: createRuntimePluginHost({
      plugins,
      enabledPluginIds: activation.enabledPluginIds,
      storeRoot: resolvedConfig.storeRoot,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity })
    }),
    plugins,
    resolvedConfig,
    activation
  } satisfies Project02ConfiguredPluginHost);
}

export function resolveRuntimePluginActivation(options: {
  readonly plugins?: readonly RuntimePlugin[];
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly additionalKnownPluginIds?: readonly string[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly strictUnknownPlugins?: boolean;
}): RuntimePluginActivationResult {
  const pluginManifests =
    options.pluginManifests ?? options.plugins?.map((plugin) => plugin.manifest) ?? [];
  const config = options.loadedConfig.config;
  const pluginIds = new Set([
    ...pluginManifests.map((manifest) => manifest.id),
    ...(options.additionalKnownPluginIds ?? [])
  ]);
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...unknownPluginDiagnostics({
      knownPluginIds: pluginIds,
      loadedPluginIds: Object.keys(config?.plugins ?? {}),
      legacyEnabledPluginIds: config?.enabledPlugins ?? [],
      strict: options.strictUnknownPlugins === true
    }),
    ...options.resolvedConfig.diagnostics
  ];
  const loadedConfigHasErrors = diagnosticsHaveErrors(options.loadedConfig.diagnostics);
  const globalConfigErrors = hasGlobalRuntimeConfigErrors({
    diagnostics,
    knownPluginIds: pluginIds
  });
  const enabledPluginIds: string[] = [];
  const disabledPluginIds: string[] = [];
  const snapshots: RuntimePluginActivationSnapshot[] = [];
  const preliminaryDecisions = new Map<
    string,
    ReturnType<typeof activationDecision>
  >();

  for (const manifest of pluginManifests) {
    const configured = config?.plugins?.[manifest.id];
    const legacyEnabled =
      config?.enabledPlugins?.includes(manifest.id) === true;
    const configErrors =
      loadedConfigHasErrors ||
      globalConfigErrors ||
      pluginHasRuntimeConfigErrors({
        diagnostics,
        pluginId: manifest.id
      });
    const decision = activationDecision({
      configuredEnabled: configured?.enabled,
      legacyEnabled,
      defaultEnabled: manifest.activation.defaultEnabled,
      configErrors
    });

    preliminaryDecisions.set(manifest.id, decision);
  }

  const memoryProviderDecision = defaultMemoryProviderDecision({
    ...(config?.defaultMemoryProvider === undefined
      ? {}
      : { configDefaultMemoryProvider: config.defaultMemoryProvider }),
    enabledPluginManifests: pluginManifests.filter(
      (manifest) => preliminaryDecisions.get(manifest.id)?.enabled === true
    )
  });

  diagnostics.push(...memoryProviderDecision.diagnostics);
  const activationConfigErrors = diagnosticsHaveErrors(diagnostics);

  for (const manifest of pluginManifests) {
    const preliminaryDecision = preliminaryDecisions.get(manifest.id);
    const memoryDecision = finalizeMemoryProviderActivation({
      manifest,
      decision: preliminaryDecision ?? activationDecision({
        configuredEnabled: undefined,
        legacyEnabled: false,
        defaultEnabled: false,
        configErrors: true
      }),
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
}): Promise<readonly PreparedRuntimePluginFactory[]> {
  const preparedFactories: PreparedRuntimePluginFactory[] = [];

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

  return Object.freeze(preparedFactories);
}

async function instantiatePreparedPlugins(options: {
  readonly preparedFactories: readonly PreparedRuntimePluginFactory[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly enabledPluginIds: readonly string[];
}): Promise<readonly RuntimePlugin[]> {
  const plugins: RuntimePlugin[] = [];
  const enabledPluginIds = new Set(options.enabledPluginIds);

  for (const preparedFactory of options.preparedFactories) {
    if (!enabledPluginIds.has(preparedFactory.manifest.id)) {
      continue;
    }

    if (preparedFactory.kind === 'legacy_prepared_plugin') {
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

    if (plugin.manifest.id !== preparedFactory.manifest.id) {
      throw new TypeError(
        `Plugin factory "${preparedFactory.pluginId}" returned plugin "${plugin.manifest.id}" after declaring manifest "${preparedFactory.manifest.id}".`
      );
    }

    plugins.push(plugin);
  }

  return Object.freeze(plugins);
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

function explicitlyDisabledLegacyFactoryIds(options: {
  readonly factories: Readonly<Record<string, RuntimePluginFactory>>;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
}): ReadonlySet<string> {
  const disabledPluginIds = new Set<string>();
  const configuredPlugins = options.loadedConfig.config?.plugins;

  if (configuredPlugins === undefined) {
    return disabledPluginIds;
  }

  for (const [pluginId, factory] of Object.entries(options.factories)) {
    if (
      !isRuntimePluginFactoryDefinition(factory) &&
      configuredPlugins[pluginId]?.enabled === false
    ) {
      disabledPluginIds.add(pluginId);
    }
  }

  return disabledPluginIds;
}

function activationDecision(options: {
  readonly configuredEnabled: boolean | undefined;
  readonly legacyEnabled: boolean;
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
  readonly loadedPluginIds: readonly string[];
  readonly legacyEnabledPluginIds: readonly string[];
  readonly strict: boolean;
}): readonly RuntimeConfigDiagnostic[] {
  const unknown = new Set<string>();

  for (const pluginId of options.loadedPluginIds) {
    if (!options.knownPluginIds.has(pluginId)) {
      unknown.add(pluginId);
    }
  }

  for (const pluginId of options.legacyEnabledPluginIds) {
    if (!options.knownPluginIds.has(pluginId)) {
      unknown.add(pluginId);
    }
  }

  return Object.freeze(
    [...unknown].map((pluginId) =>
      diagnostic(
        options.strict ? 'error' : 'warning',
        'runtime_config_unknown_plugin',
        `Runtime config references unknown plugin "${pluginId}".`,
        `plugins.${pluginId}`
      )
    )
  );
}

function defaultMemoryProviderDecision(options: {
  readonly configDefaultMemoryProvider?: string;
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
    const selected = enabledMemoryProviders.find(
      (manifest) => manifest.id === options.configDefaultMemoryProvider
    );

    if (selected === undefined) {
      return {
        activeMemoryProviderIds: [],
        ambiguous: false,
        diagnostics: [
          diagnostic(
            enabledMemoryProviders.length > 0 ? 'error' : 'warning',
            'default_memory_provider_unavailable',
            `Default memory provider "${options.configDefaultMemoryProvider}" is not active.`,
            'defaultMemoryProvider'
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
        options.manifest.id
          ? ['selected_as_default_memory_provider']
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
  path: string
): RuntimeConfigDiagnostic {
  return Object.freeze({
    severity,
    code,
    message,
    path
  } satisfies RuntimeConfigDiagnostic);
}
