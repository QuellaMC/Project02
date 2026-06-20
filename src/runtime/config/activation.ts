import {
  createCharacterStatePlugin
} from '../../plugins/builtin/character-state/index.ts';
import {
  createRuntimePluginHost,
  type RuntimePluginHost
} from '../../plugins/host.ts';
import type {
  RuntimePlugin,
  RuntimePluginKind
} from '../../plugins/types.ts';
import type {
  LoadedProject02RuntimeConfig,
  RedactedPluginRuntimeConfig,
  ResolvedPluginRuntimeConfig,
  ResolvedProject02RuntimeConfig,
  RuntimeConfigDiagnostic
} from './types.ts';
import {
  pluginHasConfigErrors,
  runtimeConfigDiagnosticPathMatchesPlugin,
  resolveProject02RuntimeConfig
} from './resolve.ts';

export type RuntimePluginFactory = (input: {
  readonly pluginId: string;
  readonly storeRoot: string;
  readonly resolvedConfig: ResolvedPluginRuntimeConfig;
  readonly redactedConfig: RedactedPluginRuntimeConfig;
}) => Promise<RuntimePlugin> | RuntimePlugin;

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

export function defaultRuntimePluginFactories(): Readonly<
  Record<string, RuntimePluginFactory>
> {
  return Object.freeze({
    'character-state': () => createCharacterStatePlugin()
  });
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
  const initialPlugins = await instantiatePlugins({
    factories,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  const resolvedConfig = resolveProject02RuntimeConfig({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    pluginManifests: initialPlugins.map((plugin) => plugin.manifest),
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const plugins = await instantiatePlugins({
    factories,
    storeRoot: resolvedConfig.storeRoot,
    resolvedConfig
  });
  const activation = resolveRuntimePluginActivation({
    plugins,
    resolvedConfig,
    loadedConfig: options.loadedConfig,
    strictUnknownPlugins: options.strictUnknownPlugins === true
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
  readonly plugins: readonly RuntimePlugin[];
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly strictUnknownPlugins?: boolean;
}): RuntimePluginActivationResult {
  const config = options.loadedConfig.config;
  const pluginIds = new Set(options.plugins.map((plugin) => plugin.manifest.id));
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...unknownPluginDiagnostics({
      knownPluginIds: pluginIds,
      loadedPluginIds: Object.keys(config?.plugins ?? {}),
      legacyEnabledPluginIds: config?.enabledPlugins ?? [],
      strict: options.strictUnknownPlugins === true
    }),
    ...options.resolvedConfig.diagnostics
  ];
  const enabledPluginIds: string[] = [];
  const disabledPluginIds: string[] = [];
  const snapshots: RuntimePluginActivationSnapshot[] = [];
  const preliminaryDecisions = new Map<
    string,
    ReturnType<typeof activationDecision>
  >();

  for (const plugin of options.plugins) {
    const configured = config?.plugins?.[plugin.manifest.id];
    const legacyEnabled =
      config?.enabledPlugins?.includes(plugin.manifest.id) === true;
    const configErrors = pluginHasConfigErrors({
      diagnostics,
      pluginId: plugin.manifest.id
    });
    const decision = activationDecision({
      configuredEnabled: configured?.enabled,
      legacyEnabled,
      defaultEnabled: plugin.manifest.activation.defaultEnabled,
      configErrors
    });

    preliminaryDecisions.set(plugin.manifest.id, decision);
  }

  const memoryProviderDecision = defaultMemoryProviderDecision({
    ...(config?.defaultMemoryProvider === undefined
      ? {}
      : { configDefaultMemoryProvider: config.defaultMemoryProvider }),
    enabledPlugins: options.plugins.filter(
      (plugin) => preliminaryDecisions.get(plugin.manifest.id)?.enabled === true
    )
  });

  diagnostics.push(...memoryProviderDecision.diagnostics);

  for (const plugin of options.plugins) {
    const preliminaryDecision = preliminaryDecisions.get(plugin.manifest.id);
    const decision = finalizeMemoryProviderActivation({
      plugin,
      decision: preliminaryDecision ?? activationDecision({
        configuredEnabled: undefined,
        legacyEnabled: false,
        defaultEnabled: false,
        configErrors: true
      }),
      memoryProviderDecision
    });

    if (decision.enabled) {
      enabledPluginIds.push(plugin.manifest.id);
    } else {
      disabledPluginIds.push(plugin.manifest.id);
    }

    snapshots.push(
      Object.freeze({
        pluginId: plugin.manifest.id,
        kind: plugin.manifest.kind,
        enabled: decision.enabled,
        activationStatus: decision.status,
        activationReasons: Object.freeze([
          ...plugin.manifest.activation.reasons,
          ...decision.reasons
        ]),
        diagnostics: Object.freeze(
          diagnostics.filter((diagnostic) =>
            runtimeConfigDiagnosticPathMatchesPlugin({
              path: diagnostic.path,
              pluginId: plugin.manifest.id
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

async function instantiatePlugins(options: {
  readonly factories: Readonly<Record<string, RuntimePluginFactory>>;
  readonly storeRoot?: string;
  readonly resolvedConfig?: ResolvedProject02RuntimeConfig;
}): Promise<readonly RuntimePlugin[]> {
  const plugins: RuntimePlugin[] = [];

  for (const [pluginId, factory] of Object.entries(options.factories)) {
    const plugin = await factory({
      pluginId,
      storeRoot: options.storeRoot ?? options.resolvedConfig?.storeRoot ?? '',
      resolvedConfig: options.resolvedConfig?.pluginConfigs[pluginId] ?? {},
      redactedConfig: options.resolvedConfig?.redactedPluginConfigs[pluginId] ?? {}
    });

    plugins.push(plugin);
  }

  return Object.freeze(plugins);
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
  readonly enabledPlugins: readonly RuntimePlugin[];
}): {
  readonly activeMemoryProviderIds: readonly string[];
  readonly ambiguous: boolean;
  readonly defaultMemoryProvider?: string;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
} {
  const enabledMemoryProviders = options.enabledPlugins.filter(
    (plugin) => plugin.manifest.kind === 'memory_provider'
  );

  if (options.configDefaultMemoryProvider !== undefined) {
    const selected = enabledMemoryProviders.find(
      (plugin) => plugin.manifest.id === options.configDefaultMemoryProvider
    );

    if (selected === undefined) {
      return {
        activeMemoryProviderIds: [],
        ambiguous: false,
        diagnostics: [
          diagnostic(
            'warning',
            'default_memory_provider_unavailable',
            `Default memory provider "${options.configDefaultMemoryProvider}" is not active.`,
            'defaultMemoryProvider'
          )
        ]
      };
    }

    return {
      activeMemoryProviderIds: [selected.manifest.id],
      ambiguous: false,
      defaultMemoryProvider: selected.manifest.id,
      diagnostics: []
    };
  }

  if (enabledMemoryProviders.length > 1) {
    return {
      activeMemoryProviderIds: [],
      ambiguous: true,
      diagnostics: [
        diagnostic(
          'warning',
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
        : [enabledMemoryProviders[0].manifest.id],
    ambiguous: false,
    diagnostics: []
  };
}

function finalizeMemoryProviderActivation(options: {
  readonly plugin: RuntimePlugin;
  readonly decision: ReturnType<typeof activationDecision>;
  readonly memoryProviderDecision: ReturnType<typeof defaultMemoryProviderDecision>;
}): ReturnType<typeof activationDecision> {
  if (!options.decision.enabled || options.plugin.manifest.kind !== 'memory_provider') {
    return options.decision;
  }

  if (
    options.memoryProviderDecision.activeMemoryProviderIds.includes(
      options.plugin.manifest.id
    )
  ) {
    return {
      ...options.decision,
      reasons: Object.freeze([
        ...options.decision.reasons,
        ...(options.memoryProviderDecision.defaultMemoryProvider ===
        options.plugin.manifest.id
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
