import {writeFileSync} from 'node:fs';
import {basename, dirname} from 'node:path';

import {
  bindProject02CharacterRuntimeLocation,
  createRuntimeConfigInspectShape,
  diagnosticsHaveErrors,
  inspectConfiguredPlugins,
  loadProject02RuntimeConfigWithLocation,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigVersion,
  type InspectConfiguredPlugin,
  type LoadedProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigInspectShape,
  type ResolvedProject02ConfigLocation,
  type ResolvedProject02RuntimeLocation,
  type RuntimeConfigCharacterScope,
} from '../../src/runtime/config/index.ts';
import {canonicalRuntimeConfigPath} from '../../src/runtime/config/path.ts';
import type {RuntimePluginCatalogSnapshot} from '../../src/app/activation.ts';
import {resolveRuntimeCliStartup} from '../../src/app/index.ts';
import {
  composeRuntimePluginCatalog,
  type RuntimePluginFactoryDefinition,
} from '../../src/app/plugin-catalog.ts';
import {homeRootForCharacterDataDir} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from './temp-root.ts';
import {
  createRuntimePluginConfigControlBinding,
  type RuntimePluginConfigControlBinding,
  type RuntimePluginConfigControlHostState,
} from '../../src/plugins/index.ts';

type TestRuntimeLocationOptions = TestHomeSelection & {
  readonly loadedConfig?: LoadedProject02RuntimeConfig;
  readonly character?: string;
  readonly characterId?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
};

/** The home, named directly or through the config file that sits in it. */
type TestHomeSelection = {
  readonly storeRoot?: string;
  readonly configPath?: string;
};

function storeRootForTest(
  options: TestHomeSelection & {
    readonly loadedConfig?: LoadedProject02RuntimeConfig;
    readonly characterScope?: RuntimeConfigCharacterScope;
  },
): string {
  if (options.configPath !== undefined) {
    if (basename(options.configPath) !== 'config.json') {
      throw new TypeError(
        `Test config path "${options.configPath}" is not a home's config.json.`,
      );
    }

    const homeRoot = dirname(options.configPath);

    if (options.storeRoot !== undefined && options.storeRoot !== homeRoot) {
      throw new TypeError(
        `Test config path "${options.configPath}" is not inside the store root "${options.storeRoot}".`,
      );
    }

    return homeRoot;
  }

  if (options.storeRoot !== undefined) {
    return options.storeRoot;
  }

  if (options.characterScope !== undefined) {
    return homeRootForCharacterDataDir(options.characterScope.dataRoot);
  }

  // Never the working directory's default home: a test must not read the
  // developer's own store.
  return options.loadedConfig?.path === undefined
    ? createTestTempRoot('project02-test-home-')
    : dirname(options.loadedConfig.path);
}

export function runtimeLocationForTest(
  options: TestRuntimeLocationOptions = {},
): ResolvedProject02RuntimeLocation {
  const character =
    options.character ??
    options.characterId ??
    options.characterScope?.characterId;
  const storeRoot = storeRootForTest(options);
  const runtimeLocation = bindProject02CharacterRuntimeLocation({
    configLocation: loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot},
    }).configLocation,
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

/** The location half of the one production load, bound to no character. */
export function configLocationForTest(
  options: TestHomeSelection = {},
): ResolvedProject02ConfigLocation {
  const storeRoot = storeRootForTest(options);

  return loadProject02RuntimeConfigWithLocation({selection: {storeRoot}})
    .configLocation;
}

/** The loaded half of the one production load; the other half is the location. */
export function loadRuntimeConfigForTest(
  options: TestHomeSelection = {},
): LoadedProject02RuntimeConfig {
  const storeRoot = storeRootForTest(options);

  return loadProject02RuntimeConfigWithLocation({selection: {storeRoot}})
    .loadedConfig;
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
  }>;

export function runtimePluginConfigControlStateForTest(
  options: RuntimePluginConfigControlStateForTestOptions,
): RuntimePluginConfigControlHostState {
  const {
    runtimeLocation = runtimeLocationForTest(),
    configScope = 'global',
    control,
    ...state
  } = options;

  return Object.freeze({
    ...state,
    configControl: createRuntimePluginConfigControlBinding({
      control,
      target: resolveRuntimeConfigScopeTarget({
        runtimeLocation,
        scope: configScope,
      }),
    }),
  });
}

export function writeRuntimeConfig(
  path: string,
  config: Readonly<Record<string, unknown>>,
): string {
  const {defaultMemoryProvider, roleModelProvider, project02, ...rest} = config;
  const project02Config =
    project02 ??
    (defaultMemoryProvider === undefined && roleModelProvider === undefined
      ? undefined
      : {
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
export async function checkRuntimeConfigForTest(
  options: TestHomeSelection & {
    readonly character?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly factories?: Readonly<
      Record<string, RuntimePluginFactoryDefinition>
    >;
  },
): Promise<RuntimeConfigCheck> {
  const {env, factories, character, ...selection} = options;
  const storeRoot = storeRootForTest(selection);
  const startup = await resolveRuntimeCliStartup({
    location: {
      storeRoot,
      ...(character === undefined ? {} : {character}),
    },
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
