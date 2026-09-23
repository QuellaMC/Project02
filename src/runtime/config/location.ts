import {dirname} from 'node:path';

import {describeRealEntry} from '../../shared/real-path.ts';
import {
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
  createProject02HomeLayout,
  normalizeLocalRuntimeCharacterId,
} from '../storage/layout-contract.ts';
import {assertProject02HomeAdoptableSync} from '../storage/home.ts';
import {
  assertRuntimeConfigGlobalTargetAdmitted,
  canonicalRuntimeConfigHomeRoot,
  canonicalRuntimeConfigLocationPath,
  loadProject02RuntimeConfigDocumentAt,
  RuntimeConfigLocationError,
} from './load.ts';
import type {
  LoadedProject02RuntimeConfig,
  RuntimeConfigCharacterScope,
} from './types.ts';

/** Retained so a re-resolve keeps the operator's explicit choices. */
export type RuntimeLocationCliState = {
  readonly storeRoot?: string;
  readonly character?: string;
};

/**
 * The home a run is bound to, and its config file. No character storage:
 * that is bound only after activation validates.
 */
export type ResolvedProject02ConfigLocation = {
  /** Canonical: the physical directory, however the operator spelled it. */
  readonly homeRoot: string;
  readonly configPath: string;
  readonly canonicalConfigPath: string;
};

/** Consumers take this instead of re-reading the character from config. */
export type ResolvedProject02RuntimeLocation =
  ResolvedProject02ConfigLocation & {
    readonly characterScope: RuntimeConfigCharacterScope;
    readonly overlayPath: string;
  };

type ResolvedRuntimeConfigScopeTargetBase = {
  readonly configPath: string;
  readonly canonicalConfigPath: string;
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
  readonly existingAnchor: RuntimeHomeDirectoryIdentity;
  homeEntry: RuntimeHomeEntryIdentity | undefined;
};

type GlobalRuntimeConfigLocation = {
  readonly scope: 'global';
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
};

type CharacterRuntimeConfigLocation = {
  readonly scope: 'character';
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
};

type ScopedRuntimeConfigLocation =
  GlobalRuntimeConfigLocation | CharacterRuntimeConfigLocation;

/**
 * The one way a run picks its home: `--store`, else the default. The home
 * is bound to its physical directory here, so a link that later points
 * elsewhere cannot move a running home.
 */
export function resolveProject02ConfigLocation(
  selection: Pick<RuntimeLocationCliState, 'storeRoot'> = {},
): ResolvedProject02ConfigLocation {
  const layout = createProject02HomeLayout(
    selection.storeRoot === undefined ? {} : {homeRoot: selection.storeRoot},
  );
  const homeRoot = canonicalRuntimeConfigHomeRoot(layout.homeRoot);
  const canonicalConfigPath = canonicalRuntimeConfigLocationPath(
    layout.configPath,
  );

  assertRuntimeConfigGlobalTargetAdmitted({
    displayPath: layout.configPath,
    canonicalPath: canonicalConfigPath,
    selectedHomeRoot: homeRoot,
  });

  const location = Object.freeze({
    homeRoot,
    configPath: layout.configPath,
    canonicalConfigPath,
  } satisfies ResolvedProject02ConfigLocation);

  resolvedProject02ConfigLocations.add(location);
  resolvedProject02HomeTargets.set(
    location,
    createResolvedProject02HomeTarget(homeRoot),
  );
  return location;
}

export function loadProject02RuntimeConfigWithLocation(
  options: {readonly selection?: RuntimeLocationCliState} = {},
): Readonly<{
  loadedConfig: LoadedProject02RuntimeConfig;
  configLocation: ResolvedProject02ConfigLocation;
}> {
  const configLocation = resolveProject02ConfigLocation(options.selection);

  return Object.freeze({
    loadedConfig: loadProject02RuntimeConfigForLocation(configLocation),
    configLocation,
  });
}

export function loadProject02RuntimeConfigForLocation(
  location: ResolvedProject02ConfigLocation,
): LoadedProject02RuntimeConfig {
  location = requireResolvedProject02ConfigLocation(location);
  assertResolvedProject02ConfigLocationStillBound(location);

  return loadProject02RuntimeConfigDocumentAt({
    path: location.configPath,
    canonicalPath: location.canonicalConfigPath,
  });
}

/** The config file still names the file it named when the home was bound. */
export function assertResolvedProject02ConfigLocationStillBound(
  location: ResolvedProject02ConfigLocation,
): void {
  location = requireResolvedProject02ConfigLocation(location);

  if (
    canonicalRuntimeConfigLocationPath(location.configPath) !==
    location.canonicalConfigPath
  ) {
    throw new RuntimeConfigLocationError(
      `Runtime config path "${location.configPath}" now names another file. Resolve a fresh runtime location before retrying.`,
    );
  }

  assertRuntimeConfigGlobalTargetAdmitted({
    displayPath: location.configPath,
    canonicalPath: location.canonicalConfigPath,
    selectedHomeRoot: location.homeRoot,
  });
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

/** The only place the target brand is minted; lower seams check it. */
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
  const configLocation = requireResolvedProject02ConfigLocation(
    options.runtimeLocation,
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
      configPath: configLocation.configPath,
      canonicalConfigPath: configLocation.canonicalConfigPath,
    });
  }

  const runtimeLocation = requireResolvedProject02RuntimeLocation(
    options.runtimeLocation,
  );

  assertResolvedProject02HomeAdoptable(runtimeLocation);

  return registerResolvedRuntimeConfigScopeTarget({
    scope: 'character',
    runtimeLocation,
    configPath: runtimeLocation.overlayPath,
    canonicalConfigPath: canonicalRuntimeConfigLocationPath(
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

/** A missing home binds its nearest ancestor until the directory exists. */
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

/** The identity check brackets admission so a mid-check replacement fails. */
export function assertResolvedProject02HomeAdoptable(
  location: ResolvedProject02ConfigLocation,
): void {
  location = requireResolvedProject02ConfigLocation(location);
  const target = requireResolvedProject02HomeTarget(location);

  assertProject02HomeTargetCurrent(target);
  assertProject02HomeAdoptableSync({homeRoot: target.canonicalRoot});
  assertProject02HomeTargetCurrent(target);
}

function createResolvedProject02HomeTarget(
  canonicalRoot: string,
): ResolvedProject02HomeTarget {
  return Object.seal({
    canonicalRoot,
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
  const entry = describeRealEntry(path);

  if (entry.kind === 'absent') {
    return undefined;
  }
  if (entry.kind === 'unreadable') {
    throw new RuntimeConfigLocationError(
      `Could not inspect resolved Project02 home path "${path}".`,
    );
  }

  return Object.freeze({
    path,
    device: entry.stats.dev,
    inode: entry.stats.ino,
    kind: entry.kind === 'directory' ? 'directory' : 'other',
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

function isResolvedProject02RuntimeLocation(
  value: unknown,
): value is ResolvedProject02RuntimeLocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    resolvedProject02RuntimeLocations.has(value)
  );
}
