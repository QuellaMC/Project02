import {
  loadProject02RuntimeConfigForLocation,
  loadProject02RuntimeConfigWithLocation,
  readDefaultDotEnvFile,
  type LoadedProject02RuntimeConfig,
  type ResolvedProject02ConfigLocation,
  type RuntimeLocationCliState,
} from '../runtime/config/index.ts';

export type Project02HomeOptions = {
  readonly location?: RuntimeLocationCliState;
  readonly env?: NodeJS.ProcessEnv;
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
  readonly loadedConfig: LoadedProject02RuntimeConfig;
};

export function loadProject02Home(
  options: Project02HomeOptions = {},
): Project02Home {
  const location = Object.freeze({...(options.location ?? {})});
  const suppliedEnv = options.env ?? process.env;
  // Only a run on the real process env reads the working directory's env
  // file, and only when it did not name its home.
  const cwdDotEnv = Object.freeze(
    location.storeRoot === undefined &&
      (options.env === undefined || options.env === process.env)
      ? readDefaultDotEnvFile()
      : {},
  );
  const {loadedConfig, configLocation} = loadProject02RuntimeConfigWithLocation(
    {selection: location},
  );

  return Object.freeze({
    runtimeLocation: configLocation,
    suppliedEnv,
    cwdDotEnv,
    loadedConfig,
  });
}

/**
 * The same home, its config document re-read. Identity never re-resolves:
 * a store redirect made after binding cannot move a running home.
 */
export function reloadProject02Home(home: Project02Home): Project02Home {
  return Object.freeze({
    ...home,
    loadedConfig: loadProject02RuntimeConfigForLocation(home.runtimeLocation),
  });
}
