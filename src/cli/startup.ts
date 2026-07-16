import {
  createRuntimePluginCatalogSnapshot,
  diagnosticsHaveErrors,
  loadProject02RuntimeConfig,
  prepareConfiguredProject02PluginActivation,
  type LoadedProject02RuntimeConfig,
  type PreparedProject02PluginActivationPlan,
  type RuntimePluginCatalogSnapshot,
  type RuntimePluginFactoryDefinition
} from '../runtime/config/index.ts';
import type { RuntimeLocationCliState } from './runtime-location.ts';
import {
  defaultDotEnvForRuntimeLocation,
  loadRuntimeConfigEnvFile,
  readDefaultDotEnvFile,
  shouldReadDefaultDotEnvForRuntimeLocation
} from './runtime-env.ts';

type RuntimeCliStartupCommonOptions = {
  readonly location?: RuntimeLocationCliState;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly cwdDotEnv?: 'auto' | 'always';
};

type RuntimeCliActivationStartupOptions = RuntimeCliStartupCommonOptions & {
  readonly stage?: 'activation';
  readonly continueAfterActivationErrors?: boolean;
};

type RuntimeCliConfigStartupOptions = RuntimeCliStartupCommonOptions & {
  readonly stage: 'config';
};

type RuntimeCliStartupOptions =
  | RuntimeCliActivationStartupOptions
  | RuntimeCliConfigStartupOptions;

type RuntimeCliStartupBase = {
  readonly location: RuntimeLocationCliState;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
};

type RuntimeCliConfigStartupResult = RuntimeCliStartupBase;

type RuntimeCliActivationStartupBase = RuntimeCliStartupBase & {
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
  readonly activationPlan: PreparedProject02PluginActivationPlan;
};

type RuntimeCliStartupResult =
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
  options: RuntimeCliConfigStartupOptions
): RuntimeCliConfigStartupResult;
export function resolveRuntimeCliStartup(
  options?: RuntimeCliActivationStartupOptions
): RuntimeCliStartupResult;
export function resolveRuntimeCliStartup(
  options: RuntimeCliStartupOptions = {}
):
  | RuntimeCliConfigStartupResult
  | RuntimeCliStartupResult {
  const location = Object.freeze({ ...(options.location ?? {}) });
  const suppliedEnv = options.env ?? process.env;
  const cwdDotEnv = resolveCwdDotEnv({
    location,
    suppliedEnv,
    mode: options.cwdDotEnv ?? 'auto',
    mayReadProcessCwd:
      options.env === undefined || options.env === process.env
  });
  const configEnv = Object.freeze({ ...cwdDotEnv, ...suppliedEnv });
  const loadedConfig = loadProject02RuntimeConfig({
    ...location,
    env: configEnv
  });
  const startupBase = {
    location,
    cwdDotEnv,
    configEnv,
    loadedConfig
  };

  if (options.stage === 'config') {
    return Object.freeze(startupBase);
  }

  const catalogSnapshot = options.factories === undefined
    ? createRuntimePluginCatalogSnapshot({
        loadedConfig,
        ...(location.storeRoot === undefined
          ? {}
          : { storeRoot: location.storeRoot })
      })
    : undefined;
  const activationPlanBeforeRuntimeEnv = prepareActivationPlan({
    loadedConfig,
    location,
    env: configEnv,
    ...(options.factories === undefined
      ? {}
      : { factories: options.factories }),
    ...(catalogSnapshot === undefined ? {} : { catalogSnapshot })
  });
  const base = {
    ...startupBase,
    ...(catalogSnapshot === undefined ? {} : { catalogSnapshot })
  };

  if (diagnosticsHaveErrors(loadedConfig.diagnostics)) {
    return Object.freeze({
      ...base,
      status: 'config_invalid',
      activationPlan: activationPlanBeforeRuntimeEnv
    });
  }

  if (
    options.continueAfterActivationErrors !== true &&
    activationDiagnosticsCanBypassRuntimeEnvFile(
      activationPlanBeforeRuntimeEnv.activation.diagnostics
    )
  ) {
    return Object.freeze({
      ...base,
      status: 'activation_blocked_before_runtime_env',
      activationPlan: activationPlanBeforeRuntimeEnv
    });
  }

  const runtimeEnv = loadRuntimeEnv({
    loadedConfig,
    location,
    suppliedEnv,
    cwdDotEnv
  });
  const activationPlan = prepareActivationPlan({
    loadedConfig,
    location,
    env: runtimeEnv,
    ...(options.factories === undefined
      ? {}
      : { factories: options.factories }),
    ...(catalogSnapshot === undefined ? {} : { catalogSnapshot })
  });

  return Object.freeze({
    ...base,
    status: 'resolved',
    runtimeEnv,
    activationPlan
  });
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
        env: options.suppliedEnv
      }))
  ) {
    return Object.freeze({});
  }

  return Object.freeze(
    defaultDotEnvForRuntimeLocation(
      readDefaultDotEnvFile(),
      options.location
    )
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
        : { storeRoot: options.location.storeRoot }),
      env: options.suppliedEnv,
      envDefaults: options.cwdDotEnv
    })
  );
}

function prepareActivationPlan(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly location: RuntimeLocationCliState;
  readonly env: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginCatalogSnapshot;
}): PreparedProject02PluginActivationPlan {
  return prepareConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    ...(options.location.storeRoot === undefined
      ? {}
      : { storeRoot: options.location.storeRoot }),
    env: options.env,
    ...(options.factories === undefined ? {} : { factories: options.factories }),
    ...(options.catalogSnapshot === undefined
      ? {}
      : { catalogSnapshot: options.catalogSnapshot })
  });
}

function activationDiagnosticsCanBypassRuntimeEnvFile(
  diagnostics: PreparedProject02PluginActivationPlan['activation']['diagnostics']
): boolean {
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error'
  );

  return (
    errors.length > 0 &&
    errors.every(
      (diagnostic) =>
        diagnostic.code !== 'runtime_config_required_secret_missing'
    )
  );
}
