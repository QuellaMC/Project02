import {writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {
  bindProject02CharacterRuntimeLocation,
  createRuntimeConfigInspectShape,
  diagnosticsHaveErrors,
  inspectConfiguredPlugins,
  loadProject02RuntimeConfigWithLocation,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type InspectConfiguredPlugin,
  type LoadedProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigInspectShape,
  type ResolvedProject02ConfigLocation,
  type ResolvedProject02RuntimeLocation,
  type RuntimeConfigCharacterScope,
  type SelectedLoadedProject02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {canonicalRuntimeConfigPath} from '../../src/runtime/config/path.ts';
import type {RuntimePluginCatalogSnapshot} from '../../src/app/activation.ts';
import {resolveRuntimeCliStartup} from '../../src/app/index.ts';
import {
  composeRuntimePluginCatalog,
  type RuntimePluginFactoryDefinition,
} from '../../src/app/plugin-catalog.ts';
import {homeRootForCharacterDataDir} from '../../src/runtime/storage/index.ts';
import {
  createRuntimePluginConfigControlBinding,
  type RuntimePluginConfigControlBinding,
  type RuntimePluginConfigControlHostState,
} from '../../src/plugins/index.ts';

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
  const selectedSnapshot = loadProject02RuntimeConfigWithLocation(
    options.loadedConfig === undefined
      ? {
          selection,
          ...(options.env === undefined ? {} : {env: options.env}),
        }
      : selectedRuntimeLocationInputsForTest(
          options.loadedConfig,
          selection,
          options.env,
        ),
  );
  const runtimeLocation = bindProject02CharacterRuntimeLocation({
    configLocation: selectedSnapshot.configLocation,
    characterId: character ?? 'mira',
  });

  if (
    options.characterScope !== undefined &&
    (runtimeLocation.characterScope.characterId !==
      options.characterScope.characterId ||
      canonicalRuntimeConfigPath(runtimeLocation.characterScope.dataRoot) !==
        canonicalRuntimeConfigPath(options.characterScope.dataRoot))
  ) {
    throw new TypeError(
      'Test character scope does not match its resolved runtime location.',
    );
  }

  return runtimeLocation;
}

function selectedRuntimeLocationInputsForTest(
  loadedConfig: LoadedProject02RuntimeConfig,
  selection: Readonly<{
    configPath?: string;
    storeRoot?: string;
    character?: string;
  }>,
  env: NodeJS.ProcessEnv | undefined,
): Readonly<{
  selection: Readonly<{
    configPath?: string;
    storeRoot?: string;
    character?: string;
  }>;
  env: NodeJS.ProcessEnv;
}> {
  if (selection.configPath !== undefined || selection.storeRoot !== undefined) {
    return {selection, env: env ?? {}};
  }

  const selectedConfig = loadedConfig.selectedConfig;

  if (selectedConfig !== undefined) {
    if (selectedConfig.source === 'default') {
      return {
        selection: {
          ...selection,
          storeRoot:
            selectedConfig.owner.kind === 'home'
              ? selectedConfig.owner.homeRoot
              : dirname(selectedConfig.path),
        },
        env: env ?? {},
      };
    }

    if (selectedConfig.source === 'path') {
      return {
        selection: {
          ...selection,
          configPath: selectedConfig.path,
          ...(selectedConfig.runtimeHomeRoot === undefined
            ? {}
            : {storeRoot: selectedConfig.runtimeHomeRoot}),
        },
        env: env ?? {},
      };
    }

    return {
      selection,
      env: {
        ...(env ?? {}),
        [runtimeConfigEnvVarName]: selectedConfig.path,
      },
    };
  }

  const configuredStoreRoot = loadedConfig.config?.project02?.storeRoot;

  if (configuredStoreRoot !== undefined) {
    return {
      selection: {
        ...selection,
        storeRoot: configuredStoreRoot,
        ...(loadedConfig.path === undefined
          ? {}
          : {configPath: loadedConfig.path}),
      },
      env: env ?? {},
    };
  }

  if (loadedConfig.path === undefined) {
    return {selection, env: env ?? {}};
  }

  if (loadedConfig.source === 'env') {
    return {
      selection,
      env: {
        ...(env ?? {}),
        [runtimeConfigEnvVarName]: loadedConfig.path,
      },
    };
  }

  return loadedConfig.source === 'path'
    ? {
        selection: {...selection, configPath: loadedConfig.path},
        env: env ?? {},
      }
    : {
        selection: {...selection, storeRoot: dirname(loadedConfig.path)},
        env: env ?? {},
      };
}

/** The location half of the one production load, bound to no character. */
export function configLocationForTest(
  options: {
    readonly configPath?: string;
    readonly storeRoot?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): ResolvedProject02ConfigLocation {
  const {env, ...selection} = options;

  return loadProject02RuntimeConfigWithLocation({
    selection,
    ...(env === undefined ? {} : {env}),
  }).configLocation;
}

/** The loaded half of the one production load; the other half is the location. */
export function loadRuntimeConfigForTest(
  options: {
    readonly configPath?: string;
    readonly storeRoot?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): SelectedLoadedProject02RuntimeConfig {
  const {env, ...selection} = options;

  return loadProject02RuntimeConfigWithLocation({
    selection,
    ...(env === undefined ? {} : {env}),
  }).loadedConfig;
}

export function runtimeConfigSnapshotForTest(
  options: TestRuntimeLocationOptions & {
    readonly loadedConfig: LoadedProject02RuntimeConfig;
    /** Supplied factories stand in for the whole installed catalog. */
    readonly factories?: Readonly<
      Record<string, RuntimePluginFactoryDefinition>
    >;
  },
): Readonly<{
  loadedConfig: LoadedProject02RuntimeConfig;
  runtimeLocation: ResolvedProject02RuntimeLocation;
  catalogSnapshot?: RuntimePluginCatalogSnapshot;
}> {
  const runtimeLocation = runtimeLocationForTest(options);

  return Object.freeze({
    loadedConfig: options.loadedConfig,
    runtimeLocation,
    ...(options.factories === undefined
      ? {}
      : {
          catalogSnapshot: Object.freeze({
            storeRoot: runtimeLocation.homeRoot,
            ...composeRuntimePluginCatalog({factories: options.factories}),
            packageProvenanceByPluginId: Object.freeze({}),
            diagnostics: Object.freeze([]),
          } satisfies RuntimePluginCatalogSnapshot),
        }),
  });
}

export type RuntimePluginConfigControlStateForTestOptions = Omit<
  RuntimePluginConfigControlHostState,
  'configControl'
> &
  Pick<RuntimePluginConfigControlBinding, 'control'> &
  Readonly<{
    runtimeLocation?: ResolvedProject02RuntimeLocation;
    configScope?: 'global' | 'character';
    env?: NodeJS.ProcessEnv;
  }>;

export function runtimePluginConfigControlStateForTest(
  options: RuntimePluginConfigControlStateForTestOptions,
): RuntimePluginConfigControlHostState {
  const {
    runtimeLocation = runtimeLocationForTest({
      ...(options.env === undefined ? {} : {env: options.env}),
    }),
    configScope = 'global',
    control,
    env,
    ...state
  } = options;

  return Object.freeze({
    ...state,
    configControl: createRuntimePluginConfigControlBinding({
      control,
      target: resolveRuntimeConfigScopeTarget({
        runtimeLocation,
        scope: configScope,
        ...(env === undefined ? {} : {env}),
      }),
    }),
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

export type RuntimeConfigCheck = {
  /** No error in the activation plan. */
  readonly ok: boolean;
  readonly runtimeConfig: RuntimeConfigInspectShape;
  readonly activationDiagnostics: readonly RuntimeConfigDiagnostic[];
  readonly plugins: readonly InspectConfiguredPlugin[];
};

/**
 * The character's activation plan, resolved the way a startup resolves it
 * and never constructing a plugin: what a config check reports.
 */
export async function checkRuntimeConfigForTest(options: {
  readonly storeRoot?: string;
  readonly configPath?: string;
  readonly character?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
}): Promise<RuntimeConfigCheck> {
  const {env, factories, ...location} = options;
  const startup = await resolveRuntimeCliStartup({
    location,
    ...(env === undefined ? {} : {env}),
    ...(factories === undefined ? {} : {factories}),
  });

  if (startup.status === 'character_invalid') {
    throw new TypeError(
      startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages.join(' ')
        : 'Character activation failed.',
    );
  }

  const plan = startup.activationPlan;

  return Object.freeze({
    ok: !diagnosticsHaveErrors(plan.activation.diagnostics),
    runtimeConfig: createRuntimeConfigInspectShape(plan.resolvedConfig),
    activationDiagnostics: plan.activation.diagnostics,
    plugins: inspectConfiguredPlugins(plan),
  });
}
