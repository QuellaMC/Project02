import {writeFileSync} from 'node:fs';

import {
  loadProject02RuntimeConfigWithLocation,
  resolveProject02RuntimeLocation,
  runtimeConfigVersion,
  sameRuntimeConfigCharacterScope,
  type LoadedProject02RuntimeConfig,
  type ResolvedProject02RuntimeLocation,
  type RuntimeConfigCharacterScope,
} from '../../src/runtime/config/index.ts';
import {homeRootForCharacterDataDir} from '../../src/runtime/storage/index.ts';
import {type RuntimePluginConfigControlHostState} from '../../src/plugins/index.ts';

type TestRuntimeLocationOptions = {
  readonly loadedConfig?: LoadedProject02RuntimeConfig;
  readonly configPath?: string;
  readonly storeRoot?: string;
  readonly character?: string;
  readonly characterId?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly env?: NodeJS.ProcessEnv;
};

export function runtimeLocationForTest(
  options: TestRuntimeLocationOptions = {},
): ResolvedProject02RuntimeLocation {
  const character =
    options.character ??
    options.characterId ??
    options.characterScope?.characterId;
  const storeRoot =
    options.storeRoot ??
    (options.characterScope === undefined
      ? undefined
      : homeRootForCharacterDataDir(options.characterScope.dataRoot));
  const selection = {
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(storeRoot === undefined ? {} : {storeRoot}),
    ...(character === undefined ? {} : {character}),
  };
  if (options.loadedConfig === undefined) {
    return loadProject02RuntimeConfigWithLocation({
      selection,
      ...(options.env === undefined ? {} : {env: options.env}),
    }).runtimeLocation;
  }

  const loadedConfig = options.loadedConfig;
  const runtimeLocation = resolveProject02RuntimeLocation({
    loadedConfig,
    selection,
  });

  if (
    options.characterScope !== undefined &&
    !sameRuntimeConfigCharacterScope(
      runtimeLocation.characterScope,
      options.characterScope,
    )
  ) {
    throw new TypeError(
      'Test character scope does not match its resolved runtime location.',
    );
  }

  return runtimeLocation;
}

export function runtimeConfigSnapshotForTest(
  options: TestRuntimeLocationOptions & {
    readonly loadedConfig: LoadedProject02RuntimeConfig;
  },
): Readonly<{
  loadedConfig: LoadedProject02RuntimeConfig;
  runtimeLocation: ResolvedProject02RuntimeLocation;
}> {
  return Object.freeze({
    loadedConfig: options.loadedConfig,
    runtimeLocation: runtimeLocationForTest(options),
  });
}

export type RuntimePluginConfigControlStateForTestOptions = Omit<
  RuntimePluginConfigControlHostState,
  'runtimeLocation' | 'configScope'
> &
  Partial<
    Pick<RuntimePluginConfigControlHostState, 'runtimeLocation' | 'configScope'>
  >;

export function runtimePluginConfigControlStateForTest(
  options: RuntimePluginConfigControlStateForTestOptions,
): RuntimePluginConfigControlHostState {
  const {
    runtimeLocation = runtimeLocationForTest({
      ...(options.env === undefined ? {} : {env: options.env}),
    }),
    configScope = 'global',
    ...state
  } = options;

  return Object.freeze({
    ...state,
    configScope,
    runtimeLocation,
  });
}

export function writeRuntimeConfig(
  path: string,
  config: Readonly<Record<string, unknown>>,
): string {
  const {
    storeRoot,
    defaultMemoryProvider,
    roleModelProvider,
    project02,
    ...rest
  } = config;
  const project02Config =
    project02 ??
    (storeRoot === undefined &&
    defaultMemoryProvider === undefined &&
    roleModelProvider === undefined
      ? undefined
      : {
          ...(storeRoot === undefined ? {} : {storeRoot}),
          ...(defaultMemoryProvider === undefined
            ? {}
            : {defaultMemoryProvider}),
          ...(roleModelProvider === undefined ? {} : {roleModelProvider}),
        });

  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: runtimeConfigVersion,
        ...(project02Config === undefined ? {} : {project02: project02Config}),
        ...rest,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return path;
}
