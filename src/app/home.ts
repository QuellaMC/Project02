import {
  loadProject02RuntimeConfigForLocation,
  loadProject02RuntimeConfigWithLocation,
  type LoadedProject02RuntimeConfig,
  type ResolvedProject02ConfigLocation,
  type RuntimeLocationCliState,
} from '../runtime/config/index.ts';

export type Project02HomeOptions = {
  readonly location?: RuntimeLocationCliState;
};

/**
 * The home, resolved once per process: where the store lives and the
 * loaded global config. Character activation starts from this and never
 * re-resolves it.
 */
export type Project02Home = {
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
};

export function loadProject02Home(
  options: Project02HomeOptions = {},
): Project02Home {
  const {loadedConfig, configLocation} = loadProject02RuntimeConfigWithLocation(
    options.location === undefined ? {} : {selection: options.location},
  );

  return Object.freeze({runtimeLocation: configLocation, loadedConfig});
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
