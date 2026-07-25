import {lstatSync} from 'node:fs';
import {dirname} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
  normalizeLocalRuntimeCharacterId,
} from '../storage/layout-contract.ts';
import {
  assertProject02HomeAdoptableSync,
  assertRealHomeEnvFileSync,
} from '../storage/home.ts';
import {
  canonicalRuntimeConfigHomeRoot,
  loadSelectedProject02RuntimeConfig,
  requireSelectedLoadedProject02RuntimeConfigSnapshot,
  RuntimeConfigLocationError,
  selectProject02RuntimeConfigLocation,
} from './load.ts';
import {canonicalRuntimeConfigMutationPath} from './mutate.ts';
import {
  runtimeConfigEnvVarName,
  type Project02RuntimeConfig,
  type RuntimeConfigCharacterScope,
  type SelectedLoadedProject02RuntimeConfig,
  type SelectedProject02RuntimeConfigLocation,
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
 * The selected global-config owner and effective runtime home. Character
 * storage is intentionally absent: startup binds it only after character
 * activation has validated the selected id.
 */
export type ResolvedProject02ConfigLocation = {
  readonly selectedConfig: SelectedProject02RuntimeConfigLocation;
  readonly homeRoot: string;
};

/**
 * The immutable location of one activated character runtime. Every
 * character-scoped consumer receives this value instead of re-selecting a
 * character from mutable global config.
 */
export type ResolvedProject02RuntimeLocation =
  ResolvedProject02ConfigLocation & {
    readonly characterScope: RuntimeConfigCharacterScope;
    readonly overlayPath: string;
  };

type ResolvedRuntimeConfigScopeTargetBase = {
  /** The file this target's mutations write. */
  readonly configPath: string;
  /** Immutable physical identity used for admission, locks, and writes. */
  readonly canonicalConfigPath: string;
  /** One frozen environment used by activation, inspection, and mutation. */
  readonly env: NodeJS.ProcessEnv;
};

export type ResolvedRuntimeConfigScopeTarget =
  | (ResolvedRuntimeConfigScopeTargetBase & {
      readonly scope: 'global';
      readonly runtimeLocation: ResolvedProject02ConfigLocation;
      readonly characterRuntimeLocation?: ResolvedProject02RuntimeLocation;
    })
  | (ResolvedRuntimeConfigScopeTargetBase & {
      readonly scope: 'character';
      readonly runtimeLocation: ResolvedProject02RuntimeLocation;
    });

const resolvedProject02ConfigLocations = new WeakSet<object>();
const resolvedProject02RuntimeLocations = new WeakSet<object>();
const resolvedRuntimeConfigScopeTargets = new WeakSet<object>();
const runtimeConfigCandidateHomeTargets = new WeakSet<object>();
const resolvedProject02HomeTargets = new WeakMap<
  object,
  ResolvedProject02HomeTarget
>();

type RuntimeHomeEntryIdentity = {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly kind: 'directory' | 'other';
};

type RuntimeHomeDirectoryIdentity = RuntimeHomeEntryIdentity & {
  readonly kind: 'directory';
};

type ResolvedProject02HomeTarget = {
  readonly canonicalRoot: string;
  readonly selection: ResolvedProject02HomeSelection;
  readonly existingAnchor: RuntimeHomeDirectoryIdentity;
  homeEntry: RuntimeHomeEntryIdentity | undefined;
};

type ResolvedProject02HomeSelection =
  | Readonly<{kind: 'config'; value: string}>
  | Readonly<{kind: 'runtime'; value: string}>
  | Readonly<{kind: 'owner'; value: string}>
  | Readonly<{kind: 'default'}>;

/**
 * Opaque transaction candidate. It intentionally has no selected-config
 * provenance and cannot be activated, character-bound, or turned into a
 * config-control target.
 */
export type RuntimeConfigCandidateHomeTarget = {
  readonly homeRoot: string;
};

type GlobalRuntimeConfigLocation = {
  readonly scope: 'global';
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly env?: NodeJS.ProcessEnv;
};

type CharacterRuntimeConfigLocation = {
  readonly scope: 'character';
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly env?: NodeJS.ProcessEnv;
};

type ScopedRuntimeConfigLocation =
  GlobalRuntimeConfigLocation | CharacterRuntimeConfigLocation;

export function resolveProject02ConfigLocation(options: {
  readonly loadedConfig: SelectedLoadedProject02RuntimeConfig;
}): ResolvedProject02ConfigLocation {
  const loadedConfig = requireSelectedLoadedProject02RuntimeConfigSnapshot(
    options.loadedConfig,
  );

  return createResolvedProject02ConfigLocation({
    selectedConfig: loadedConfig.selectedConfig,
    ...(loadedConfig.config === undefined ? {} : {config: loadedConfig.config}),
  });
}

/**
 * Validates the operator-selected home independently from the effective home
 * selected by config content. An explicit config remains standalone, while an
 * accompanying --store still carries its own home-ownership obligation.
 */
export function assertSelectedProject02HomeAdoptable(
  location: ResolvedProject02ConfigLocation,
  options: {readonly requireRealEnvFile?: boolean} = {},
): void {
  location = requireResolvedProject02ConfigLocation(location);
  const selectedHomeRoot =
    location.selectedConfig.owner.kind === 'home'
      ? location.selectedConfig.owner.homeRoot
      : location.selectedConfig.runtimeHomeRoot;

  if (selectedHomeRoot === undefined) {
    return;
  }

  assertProject02HomeAdoptableSync({homeRoot: selectedHomeRoot});

  if (options.requireRealEnvFile === true) {
    assertRealHomeEnvFileSync({homeRoot: selectedHomeRoot});
  }
}

export function resolveAdoptableRuntimeConfigCandidateHomeTarget(options: {
  readonly configLocation: ResolvedProject02ConfigLocation;
  readonly config?: Project02RuntimeConfig;
}): RuntimeConfigCandidateHomeTarget {
  const configLocation = requireResolvedProject02ConfigLocation(
    options.configLocation,
  );
  const selection = resolvedProject02HomeSelection({
    selectedConfig: configLocation.selectedConfig,
    ...(options.config === undefined ? {} : {config: options.config}),
  });
  const homeRoot = canonicalRuntimeConfigHomeRoot(
    selection.kind === 'default' ? undefined : selection.value,
  );
  const candidate = Object.freeze({
    homeRoot,
  } satisfies RuntimeConfigCandidateHomeTarget);

  runtimeConfigCandidateHomeTargets.add(candidate);
  resolvedProject02HomeTargets.set(
    candidate,
    createResolvedProject02HomeTarget(homeRoot, selection),
  );
  assertRuntimeConfigCandidateHomeAdoptable(candidate);
  return candidate;
}

export function assertRuntimeConfigCandidateHomeAdoptable(
  candidate: RuntimeConfigCandidateHomeTarget,
): void {
  if (!runtimeConfigCandidateHomeTargets.has(candidate)) {
    throw new TypeError(
      'Runtime config candidate home must be created by the config transaction candidate resolver.',
    );
  }

  assertProject02HomeTargetAdoptable(
    requireResolvedProject02HomeTarget(candidate),
  );
}

/**
 * Checks a loader-owned reload against its existing effective-home authority.
 * An unchanged authored selector keeps the physical target chosen before the
 * transaction, even if an alias spelling now points elsewhere. A changed
 * selector is resolved afresh so the transaction can reject real home drift.
 */
export function assertProject02ReloadedConfigUsesBoundHome(options: {
  readonly configLocation: ResolvedProject02ConfigLocation;
  readonly loadedConfig: SelectedLoadedProject02RuntimeConfig;
}): void {
  const configLocation = requireResolvedProject02ConfigLocation(
    options.configLocation,
  );
  const loadedConfig = requireSelectedLoadedProject02RuntimeConfigSnapshot(
    options.loadedConfig,
  );

  assertReloadedSelectionMatchesConfigLocation(
    configLocation.selectedConfig,
    loadedConfig.selectedConfig,
  );
  const selection = resolvedProject02HomeSelection({
    selectedConfig: loadedConfig.selectedConfig,
    ...(loadedConfig.config === undefined ? {} : {config: loadedConfig.config}),
  });
  const boundTarget = requireResolvedProject02HomeTarget(configLocation);

  if (resolvedProject02HomeSelectionsMatch(boundTarget.selection, selection)) {
    assertResolvedProject02HomeCurrent(configLocation);
    return;
  }

  const reloadedHomeRoot = canonicalRuntimeConfigHomeRoot(
    selection.kind === 'default' ? undefined : selection.value,
  );

  if (reloadedHomeRoot !== configLocation.homeRoot) {
    throw new RuntimeConfigLocationError(
      'Reloaded runtime config selects another Project02 home.',
    );
  }

  assertResolvedProject02HomeCurrent(configLocation);
}

function createResolvedProject02ConfigLocation(options: {
  readonly selectedConfig: SelectedProject02RuntimeConfigLocation;
  readonly config?: Project02RuntimeConfig;
}): ResolvedProject02ConfigLocation {
  const selection = resolvedProject02HomeSelection(options);
  const homeRoot = canonicalRuntimeConfigHomeRoot(
    selection.kind === 'default' ? undefined : selection.value,
  );
  const location = Object.freeze({
    selectedConfig: options.selectedConfig,
    homeRoot,
  } satisfies ResolvedProject02ConfigLocation);

  resolvedProject02ConfigLocations.add(location);
  resolvedProject02HomeTargets.set(
    location,
    createResolvedProject02HomeTarget(homeRoot, selection),
  );
  return location;
}

function resolvedProject02HomeSelection(options: {
  readonly selectedConfig: SelectedProject02RuntimeConfigLocation;
  readonly config?: Project02RuntimeConfig;
}): ResolvedProject02HomeSelection {
  const configuredHome = options.config?.project02?.storeRoot;

  if (configuredHome !== undefined) {
    return Object.freeze({kind: 'config', value: configuredHome});
  }

  if (options.selectedConfig.runtimeHomeRoot !== undefined) {
    return Object.freeze({
      kind: 'runtime',
      value: options.selectedConfig.runtimeHomeRoot,
    });
  }

  if (options.selectedConfig.owner.kind === 'home') {
    return Object.freeze({
      kind: 'owner',
      value: options.selectedConfig.owner.homeRoot,
    });
  }

  return Object.freeze({kind: 'default'});
}

function resolvedProject02HomeSelectionsMatch(
  left: ResolvedProject02HomeSelection,
  right: ResolvedProject02HomeSelection,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'default' ||
      (right.kind !== 'default' && left.value === right.value))
  );
}

function assertReloadedSelectionMatchesConfigLocation(
  bound: SelectedProject02RuntimeConfigLocation,
  reloaded: SelectedProject02RuntimeConfigLocation,
): void {
  const ownersMatch =
    bound.owner.kind === reloaded.owner.kind &&
    (bound.owner.kind === 'standalone' ||
      (reloaded.owner.kind === 'home' &&
        bound.owner.homeRoot === reloaded.owner.homeRoot));

  if (
    bound.source === reloaded.source &&
    bound.path === reloaded.path &&
    bound.canonicalPath === reloaded.canonicalPath &&
    bound.runtimeHomeRoot === reloaded.runtimeHomeRoot &&
    ownersMatch
  ) {
    return;
  }

  throw new RuntimeConfigLocationError(
    'Reloaded runtime config does not match its bound selected config location.',
  );
}

export function bindProject02CharacterRuntimeLocation(options: {
  readonly configLocation: ResolvedProject02ConfigLocation;
  readonly characterId: string;
}): ResolvedProject02RuntimeLocation {
  const configLocation = requireResolvedProject02ConfigLocation(
    options.configLocation,
  );
  const characterId = normalizeLocalRuntimeCharacterId(options.characterId);
  const dataRoot = characterDataDirPath(configLocation.homeRoot, characterId);
  const characterScope = Object.freeze({
    characterId,
    dataRoot,
  } satisfies RuntimeConfigCharacterScope);
  const location = Object.freeze({
    ...configLocation,
    characterScope,
    overlayPath: createLocalRuntimeStorageLayout({storeRoot: dataRoot})
      .configPath,
  });

  resolvedProject02ConfigLocations.add(location);
  resolvedProject02RuntimeLocations.add(location);
  resolvedProject02HomeTargets.set(
    location,
    requireResolvedProject02HomeTarget(configLocation),
  );
  return location;
}

/**
 * Constructs and brands the complete config-control target. Target
 * construction lives beside resolved-location ownership so structural
 * callers cannot mint the runtime brand that lower transaction seams check.
 */
export function resolveRuntimeConfigScopeTarget(
  options: GlobalRuntimeConfigLocation,
): Extract<ResolvedRuntimeConfigScopeTarget, {readonly scope: 'global'}>;
export function resolveRuntimeConfigScopeTarget(
  options: CharacterRuntimeConfigLocation,
): Extract<ResolvedRuntimeConfigScopeTarget, {readonly scope: 'character'}>;
export function resolveRuntimeConfigScopeTarget(
  options: ScopedRuntimeConfigLocation,
): ResolvedRuntimeConfigScopeTarget;
export function resolveRuntimeConfigScopeTarget(
  options: ScopedRuntimeConfigLocation,
): ResolvedRuntimeConfigScopeTarget {
  // Selection already consumed any environment-based config selector. Freeze
  // every other runtime value while preserving that selected path without
  // evaluating a potentially accessor-backed selector a second time.
  const configLocation = requireResolvedProject02ConfigLocation(
    options.runtimeLocation,
  );
  const env = runtimeConfigScopeEnvironmentSnapshot(
    options.env ?? process.env,
    configLocation.selectedConfig.source,
    configLocation.selectedConfig.path,
  );

  if (options.scope === 'global') {
    const characterRuntimeLocation = isResolvedProject02RuntimeLocation(
      options.runtimeLocation,
    )
      ? options.runtimeLocation
      : undefined;

    return registerResolvedRuntimeConfigScopeTarget({
      scope: 'global',
      runtimeLocation: configLocation,
      ...(characterRuntimeLocation === undefined
        ? {}
        : {characterRuntimeLocation}),
      env,
      configPath: configLocation.selectedConfig.path,
      canonicalConfigPath: configLocation.selectedConfig.canonicalPath,
    });
  }

  const runtimeLocation = requireResolvedProject02RuntimeLocation(
    options.runtimeLocation,
  );

  assertResolvedProject02HomeAdoptable(runtimeLocation);

  return registerResolvedRuntimeConfigScopeTarget({
    scope: 'character',
    runtimeLocation,
    env,
    configPath: runtimeLocation.overlayPath,
    canonicalConfigPath: canonicalRuntimeConfigMutationPath(
      runtimeLocation.overlayPath,
    ),
  });
}

export function requireResolvedRuntimeConfigScopeTarget(
  value: unknown,
): ResolvedRuntimeConfigScopeTarget {
  if (
    typeof value === 'object' &&
    value !== null &&
    resolvedRuntimeConfigScopeTargets.has(value)
  ) {
    return value as ResolvedRuntimeConfigScopeTarget;
  }

  throw new TypeError(
    'Runtime config scope target must be created by resolveRuntimeConfigScopeTarget().',
  );
}

function registerResolvedRuntimeConfigScopeTarget<
  T extends ResolvedRuntimeConfigScopeTarget,
>(target: T): T {
  const snapshot = Object.freeze(target);

  resolvedRuntimeConfigScopeTargets.add(snapshot);
  return snapshot;
}

function runtimeConfigScopeEnvironmentSnapshot(
  env: NodeJS.ProcessEnv,
  selectedSource: ResolvedProject02ConfigLocation['selectedConfig']['source'],
  selectedPath: string,
): NodeJS.ProcessEnv {
  const snapshot: NodeJS.ProcessEnv = {};

  for (const key of Object.keys(env)) {
    if (key === runtimeConfigEnvVarName && selectedSource === 'env') {
      snapshot[key] = selectedPath;
      continue;
    }

    snapshot[key] = env[key];
  }

  return Object.freeze(snapshot);
}

export function loadProject02RuntimeConfigWithLocation(
  options: {
    readonly selection?: RuntimeLocationCliState;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Readonly<{
  loadedConfig: SelectedLoadedProject02RuntimeConfig;
  configLocation: ResolvedProject02ConfigLocation;
}> {
  const selection = Object.freeze({...options.selection});
  const selectedConfig = selectProject02RuntimeConfigLocation({
    selection,
    env: options.env ?? process.env,
  });
  const loadedConfig = loadSelectedProject02RuntimeConfig(selectedConfig);

  return Object.freeze({
    loadedConfig,
    configLocation: resolveProject02ConfigLocation({
      loadedConfig,
    }),
  });
}

export function loadProject02RuntimeConfigForLocation(
  location: ResolvedProject02ConfigLocation,
): SelectedLoadedProject02RuntimeConfig {
  return loadSelectedProject02RuntimeConfig(
    requireResolvedProject02ConfigLocation(location).selectedConfig,
  );
}

/**
 * Verifies that the effective home still names the physical directory target
 * captured with this location. Missing homes bind their nearest existing
 * ancestor, then adopt the new directory identity once it materializes.
 */
export function assertResolvedProject02HomeCurrent(
  location: ResolvedProject02ConfigLocation,
): void {
  location = requireResolvedProject02ConfigLocation(location);
  assertProject02HomeTargetCurrent(
    requireResolvedProject02HomeTarget(location),
  );
}

function assertProject02HomeTargetCurrent(
  target: ResolvedProject02HomeTarget,
): void {
  const currentCanonicalRoot = canonicalRuntimeConfigHomeRoot(
    target.canonicalRoot,
  );

  if (currentCanonicalRoot !== target.canonicalRoot) {
    throw new RuntimeConfigLocationError(
      `Resolved Project02 home "${target.canonicalRoot}" now names another physical location.`,
    );
  }

  assertRuntimeHomeDirectoryIdentityCurrent(
    target.existingAnchor,
    'existing ancestor',
  );
  const currentHome = runtimeHomeEntryIdentityAt(target.canonicalRoot);

  if (target.homeEntry === undefined) {
    if (currentHome !== undefined) {
      if (currentHome.kind !== 'directory') {
        throw new RuntimeConfigLocationError(
          `Resolved Project02 home path "${target.canonicalRoot}" became a non-directory after the runtime location was bound.`,
        );
      }

      target.homeEntry = currentHome;
    }

    return;
  }

  if (
    currentHome === undefined ||
    !runtimeHomeEntryIdentitiesMatch(target.homeEntry, currentHome)
  ) {
    throw new RuntimeConfigLocationError(
      `Resolved Project02 home "${target.canonicalRoot}" was replaced after the runtime location was bound.`,
    );
  }
}

/**
 * One admission seam for every operation that interprets the effective home
 * as Project02-owned storage. The identity checks bracket the storage
 * contract so a replacement during admission cannot silently become current.
 */
export function assertResolvedProject02HomeAdoptable(
  location: ResolvedProject02ConfigLocation,
  options: {readonly requireRealEnvFile?: boolean} = {},
): void {
  location = requireResolvedProject02ConfigLocation(location);
  assertProject02HomeTargetAdoptable(
    requireResolvedProject02HomeTarget(location),
    options,
  );
}

function assertProject02HomeTargetAdoptable(
  target: ResolvedProject02HomeTarget,
  options: {readonly requireRealEnvFile?: boolean} = {},
): void {
  assertProject02HomeTargetCurrent(target);
  assertProject02HomeAdoptableSync({homeRoot: target.canonicalRoot});

  if (options.requireRealEnvFile === true) {
    assertRealHomeEnvFileSync({homeRoot: target.canonicalRoot});
  }

  assertProject02HomeTargetCurrent(target);
}

function createResolvedProject02HomeTarget(
  canonicalRoot: string,
  selection: ResolvedProject02HomeSelection,
): ResolvedProject02HomeTarget {
  return Object.seal({
    canonicalRoot,
    selection,
    existingAnchor: nearestExistingRuntimeHomeAncestor(canonicalRoot),
    homeEntry: runtimeHomeEntryIdentityAt(canonicalRoot),
  } satisfies ResolvedProject02HomeTarget);
}

function nearestExistingRuntimeHomeAncestor(
  canonicalRoot: string,
): RuntimeHomeDirectoryIdentity {
  let candidate = dirname(canonicalRoot);

  for (;;) {
    const identity = runtimeHomeDirectoryIdentityAt(candidate);

    if (identity !== undefined) {
      return identity;
    }

    const parent = dirname(candidate);

    if (parent === candidate) {
      throw new RuntimeConfigLocationError(
        `Could not bind an existing directory ancestor for Project02 home "${canonicalRoot}".`,
      );
    }

    candidate = parent;
  }
}

function runtimeHomeDirectoryIdentityAt(
  path: string,
): RuntimeHomeDirectoryIdentity | undefined {
  const identity = runtimeHomeEntryIdentityAt(path);

  if (identity === undefined) {
    return undefined;
  }

  if (identity.kind !== 'directory') {
    throw new RuntimeConfigLocationError(
      `Resolved Project02 home path "${path}" is not a real directory.`,
    );
  }

  return Object.freeze({...identity, kind: 'directory'});
}

function runtimeHomeEntryIdentityAt(
  path: string,
): RuntimeHomeEntryIdentity | undefined {
  let stats;

  try {
    stats = lstatSync(path, {bigint: true});
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw new RuntimeConfigLocationError(
      `Could not inspect resolved Project02 home path "${path}".`,
    );
  }

  return Object.freeze({
    path,
    device: stats.dev,
    inode: stats.ino,
    kind:
      !stats.isSymbolicLink() && stats.isDirectory() ? 'directory' : 'other',
  });
}

function assertRuntimeHomeDirectoryIdentityCurrent(
  identity: RuntimeHomeDirectoryIdentity,
  label: string,
): void {
  const current = runtimeHomeDirectoryIdentityAt(identity.path);

  if (
    current === undefined ||
    !runtimeHomeEntryIdentitiesMatch(identity, current)
  ) {
    throw new RuntimeConfigLocationError(
      `Resolved Project02 home ${label} "${identity.path}" was replaced after the runtime location was bound.`,
    );
  }
}

function runtimeHomeEntryIdentitiesMatch(
  left: RuntimeHomeEntryIdentity,
  right: RuntimeHomeEntryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.kind === right.kind
  );
}

function requireResolvedProject02HomeTarget(
  location: object,
): ResolvedProject02HomeTarget {
  const target = resolvedProject02HomeTargets.get(location);

  if (target !== undefined) {
    return target;
  }

  throw new TypeError(
    'Runtime config location is missing its resolved Project02 home target.',
  );
}

export function requireResolvedProject02ConfigLocation(
  value: unknown,
): ResolvedProject02ConfigLocation {
  if (
    typeof value === 'object' &&
    value !== null &&
    resolvedProject02ConfigLocations.has(value)
  ) {
    return value as ResolvedProject02ConfigLocation;
  }

  throw new TypeError(
    'Runtime config location must be created by resolveProject02ConfigLocation().',
  );
}

export function requireResolvedProject02RuntimeLocation(
  value: unknown,
): ResolvedProject02RuntimeLocation {
  if (isResolvedProject02RuntimeLocation(value)) {
    return value;
  }

  throw new TypeError(
    'Character runtime location must be created by bindProject02CharacterRuntimeLocation().',
  );
}

export function isResolvedProject02RuntimeLocation(
  value: unknown,
): value is ResolvedProject02RuntimeLocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    resolvedProject02RuntimeLocations.has(value)
  );
}

export function runtimeConfigLocationUsesDefaultConfigPath(
  location: ResolvedProject02ConfigLocation,
): boolean {
  return location.selectedConfig.source === 'default';
}
