import {
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
} from '../storage/layout-contract.ts';
import {createProject02HomeLayout} from '../storage/layout-contract.ts';
import {
  defaultRuntimeConfigPath,
  loadSelectedProject02RuntimeConfig,
  selectProject02RuntimeConfigLocation,
  type SelectedProject02RuntimeConfigLocation,
} from './load.ts';
import {storeRootForSelectedDefaultConfigPath} from './mutate.ts';
import {
  configuredProject02CharacterId,
  type LoadedProject02RuntimeConfig,
  type RuntimeConfigCharacterScope,
  type RuntimeConfigSource,
} from './types.ts';

/**
 * Operator-selected runtime location inputs. These are retained with the
 * resolved value so a candidate global config can be resolved again without
 * losing explicit CLI or embedding choices.
 */
export type RuntimeLocationCliState = {
  readonly storeRoot?: string;
  readonly configPath?: string;
  readonly character?: string;
};

/**
 * The one downstream runtime-location value. A selected default config path
 * remains present even when the file itself is absent (`loadedConfig.source`
 * is then `none`), so consumers never infer a different home independently.
 */
export type ResolvedProject02RuntimeLocation = {
  readonly selection: Readonly<RuntimeLocationCliState>;
  readonly configSource: Exclude<RuntimeConfigSource, 'none'>;
  readonly globalConfigPath: string;
  readonly homeRoot: string;
  readonly characterScope: RuntimeConfigCharacterScope;
  readonly overlayPath: string;
};

type ResolvedRuntimeConfigScopeTargetBase = {
  /** The file this target's mutations write. */
  readonly configPath: string;
  /** Stable identity used by prepared-effect reconciliation. */
  readonly canonicalConfigPath: string;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly env?: NodeJS.ProcessEnv;
};

export type ResolvedRuntimeConfigScopeTarget =
  | (ResolvedRuntimeConfigScopeTargetBase & {
      readonly scope: 'global';
    })
  | (ResolvedRuntimeConfigScopeTargetBase & {
      readonly scope: 'character';
    });

export function resolveProject02RuntimeLocation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly selection?: RuntimeLocationCliState;
  readonly selectedConfig?: SelectedProject02RuntimeConfigLocation;
}): ResolvedProject02RuntimeLocation {
  const selection = Object.freeze({...options.selection});
  const selectedConfig =
    options.selectedConfig ??
    selectedConfigForLoadedRuntimeConfig(options.loadedConfig, selection);
  const globalConfigPath = selectedConfig.path;
  const selectedDefaultHome =
    storeRootForSelectedDefaultConfigPath(globalConfigPath);
  const configuredHome =
    options.loadedConfig.config?.project02?.storeRoot ??
    selection.storeRoot ??
    selectedDefaultHome;
  const homeRoot = createProject02HomeLayout(
    configuredHome === undefined ? {} : {homeRoot: configuredHome},
  ).homeRoot;
  const characterId = configuredProject02CharacterId(
    options.loadedConfig.config,
    selection.character,
  );
  const dataRoot = characterDataDirPath(homeRoot, characterId);
  const characterScope = Object.freeze({
    characterId,
    dataRoot,
  } satisfies RuntimeConfigCharacterScope);

  return Object.freeze({
    selection,
    configSource: selectedConfig.source,
    globalConfigPath,
    homeRoot,
    characterScope,
    overlayPath: createLocalRuntimeStorageLayout({storeRoot: dataRoot})
      .configPath,
  } satisfies ResolvedProject02RuntimeLocation);
}

export function loadProject02RuntimeConfigWithLocation(
  options: {
    readonly selection?: RuntimeLocationCliState;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Readonly<{
  loadedConfig: LoadedProject02RuntimeConfig;
  runtimeLocation: ResolvedProject02RuntimeLocation;
}> {
  const selection = Object.freeze({...options.selection});
  const selectedConfig = selectProject02RuntimeConfigLocation({
    selection,
    env: options.env ?? process.env,
  });
  const loadedConfig = loadSelectedProject02RuntimeConfig(selectedConfig);

  return Object.freeze({
    loadedConfig,
    runtimeLocation: resolveProject02RuntimeLocation({
      loadedConfig,
      selection,
      selectedConfig,
    }),
  });
}

export function loadProject02RuntimeConfigForLocation(
  location: ResolvedProject02RuntimeLocation,
): LoadedProject02RuntimeConfig {
  return loadSelectedProject02RuntimeConfig({
    source: location.configSource,
    path: location.globalConfigPath,
  });
}

function selectedConfigForLoadedRuntimeConfig(
  loadedConfig: LoadedProject02RuntimeConfig,
  selection: RuntimeLocationCliState,
): SelectedProject02RuntimeConfigLocation {
  if (selection.configPath !== undefined) {
    return selectProject02RuntimeConfigLocation({
      selection,
      env: {},
    });
  }

  if (selection.storeRoot !== undefined) {
    return selectProject02RuntimeConfigLocation({
      selection,
      env: {},
    });
  }

  if (loadedConfig.source !== 'none' && loadedConfig.path !== undefined) {
    return Object.freeze({
      source: loadedConfig.source,
      path: loadedConfig.path,
    });
  }

  const path = loadedConfig.path ?? defaultRuntimeConfigPath();

  return Object.freeze({
    source: path === defaultRuntimeConfigPath() ? 'default' : 'env',
    path,
  });
}

export function sameRuntimeConfigCharacterScope(
  left: RuntimeConfigCharacterScope,
  right: RuntimeConfigCharacterScope | undefined,
): boolean {
  return (
    right !== undefined &&
    left.characterId === right.characterId &&
    left.dataRoot === right.dataRoot
  );
}

export function runtimeConfigLocationUsesDefaultConfigPath(
  location: ResolvedProject02RuntimeLocation,
): boolean {
  return (
    storeRootForSelectedDefaultConfigPath(location.globalConfigPath) !==
    undefined
  );
}
