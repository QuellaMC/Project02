import {
  defaultDotEnvForRuntimeLocation,
  loadProject02RuntimeConfigForLocation,
  loadProject02RuntimeConfigWithLocation,
  readDefaultDotEnvFile,
  shouldReadDefaultDotEnvForRuntimeLocation,
  type LoadedProject02RuntimeConfig,
  type ResolvedProject02ConfigLocation,
  type RuntimeLocationCliState,
} from '../runtime/config/index.ts';

export type Project02HomeOptions = {
  readonly location?: RuntimeLocationCliState;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwdDotEnv?: 'auto' | 'always';
};

/**
 * The home, resolved once per process: where the store lives, the env the
 * run was given, and the loaded global config. Character activation starts
 * from this and never re-resolves it.
 */
export type Project02Home = {
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly cwdDotEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
};

export function loadProject02Home(
  options: Project02HomeOptions = {},
): Project02Home {
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

  return Object.freeze({
    runtimeLocation: configLocation,
    suppliedEnv,
    cwdDotEnv,
    configEnv,
    loadedConfig,
  });
}

/**
 * The same home, its config document re-read. Identity never re-resolves:
 * an env or store redirect made after binding cannot move a running home.
 */
export function reloadProject02Home(home: Project02Home): Project02Home {
  return Object.freeze({
    ...home,
    loadedConfig: loadProject02RuntimeConfigForLocation(home.runtimeLocation),
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
        env: options.suppliedEnv,
      }))
  ) {
    return Object.freeze({});
  }

  return Object.freeze(
    defaultDotEnvForRuntimeLocation(readDefaultDotEnvFile(), options.location),
  );
}
