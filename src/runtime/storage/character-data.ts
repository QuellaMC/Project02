import {lstatSync, readdirSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {isLiveAtomicReplacementForAnyTarget} from './atomic-file.ts';
import {
  characterDataDirPath,
  characterDataDirectoryName,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
  type LocalRuntimeCharacterDataStorageSchemaMarker,
  type LocalRuntimeStorageLayout,
  type LocalRuntimeStorageLayoutOptions,
  type LocalRuntimeStorageSchemaMarker,
} from './layout-contract.ts';
import {ensureInitializedProject02Home} from './home.ts';
import {
  ensureStorageSchemaMarker,
  readStorageSchemaMarker,
  updateStorageSchemaMarker,
} from './schema-marker.ts';

export type EnsureCharacterDataMarkerResult = {
  readonly marker: LocalRuntimeCharacterDataStorageSchemaMarker;
  readonly created: boolean;
};

/**
 * The one writer-side initializer for character data. It preflights
 * ownership before the home can be marked, initializes the home, then
 * persists the character identity at the data-directory boundary.
 */
export async function ensureCharacterDataDir(options: {
  readonly homeRoot?: string;
  readonly characterId: string;
  readonly now?: () => string;
}): Promise<string> {
  const homeOptions =
    options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot};
  const selectedHome = createProject02HomeLayout(homeOptions);
  const selectedDataRoot = characterDataDirPath(
    selectedHome.homeRoot,
    options.characterId,
  );

  // A rejected character directory must not leave a new home marker.
  assertCharacterDataDirAdoptable({storeRoot: selectedDataRoot});

  const home = await ensureInitializedProject02Home(homeOptions);
  const dataRoot = characterDataDirPath(home.homeRoot, options.characterId);
  await ensureCharacterDataMarker({
    storageOptions: {storeRoot: dataRoot},
    characterId: options.characterId,
    ...(options.now === undefined ? {} : {now: options.now}),
  });

  return dataRoot;
}

/**
 * Read-only ownership guard for a character data directory. Missing
 * directories and marker-less control-only directories are adoptable;
 * foreign content, symlinks, wrong control-entry types, and marker/path
 * identity mismatches are not.
 */
export function assertCharacterDataDirAdoptable(
  options: LocalRuntimeStorageLayoutOptions,
): void {
  readAdoptableCharacterDataMarker(options);
}

function readAdoptableCharacterDataMarker(
  options: LocalRuntimeStorageLayoutOptions,
): LocalRuntimeCharacterDataStorageSchemaMarker | undefined {
  const layout = createLocalRuntimeStorageLayout(options);
  assertRealCharacterDataParent(layout);

  let rootStats;

  try {
    rootStats = lstatSync(layout.storeRoot);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect character data directory: ${layout.storeRoot}.`,
    );
  }

  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${layout.storeRoot}" must be a real directory inside the Project02 home.`,
    );
  }

  assertRealDataControlRoot(layout.locksRoot, 'Lock root');
  assertRealDataControlRoot(layout.sessionsRoot, 'Sessions root');
  assertRealDataControlFile(layout.sessionCatalogPath, 'Session catalog');
  assertRealDataControlFile(layout.configPath, 'Character overlay');

  const marker = readStorageSchemaMarker(layout);

  if (marker !== undefined) {
    return requireCharacterDataMarkerScope(layout, marker);
  }

  const foreignEntry = readdirSync(layout.storeRoot).find(entry => {
    const entryPath = join(layout.storeRoot, entry);

    if (
      entryPath === layout.configPath ||
      entryPath === layout.locksRoot ||
      (entryPath === layout.sessionsRoot &&
        readdirSync(layout.sessionsRoot).length === 0)
    ) {
      return false;
    }

    return !isLiveAtomicReplacementForAnyTarget(entry, [
      layout.schemaPath,
      layout.configPath,
    ]);
  });

  if (foreignEntry !== undefined) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${layout.storeRoot}" holds ` +
        `"${foreignEntry}" without a data marker; refusing to adopt it.`,
    );
  }

  return undefined;
}

/**
 * Read-only guard for consumers. The selected runtime character is checked
 * against the one identity persisted in the directory marker.
 */
export function assertCharacterDataDirReadable(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
}): LocalRuntimeCharacterDataStorageSchemaMarker | undefined {
  const layout = createLocalRuntimeStorageLayout(options.storageOptions);
  const marker = readAdoptableCharacterDataMarker(options.storageOptions);

  return marker === undefined
    ? undefined
    : assertExpectedCharacterDataMarker(layout, marker, options.characterId);
}

export function requireCharacterDataMarker(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId?: string;
}): LocalRuntimeCharacterDataStorageSchemaMarker {
  const layout = createLocalRuntimeStorageLayout(options.storageOptions);
  const marker = readAdoptableCharacterDataMarker(options.storageOptions);

  if (marker === undefined) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${layout.storeRoot}" has no storage schema marker.`,
    );
  }

  return options.characterId === undefined
    ? requireCharacterDataMarkerScope(layout, marker)
    : assertExpectedCharacterDataMarker(layout, marker, options.characterId);
}

export async function ensureCharacterDataMarker(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
  readonly now?: () => string;
}): Promise<EnsureCharacterDataMarkerResult> {
  assertCharacterDataDirAdoptable(options.storageOptions);

  const layout = createLocalRuntimeStorageLayout(options.storageOptions);
  const result = await ensureStorageSchemaMarker(
    layout,
    createLocalRuntimeStorageSchemaMarker({
      scope: 'character-data',
      characterId: options.characterId,
      createdAt: (options.now ?? defaultCharacterDataClock)(),
    }),
    () => {
      assertCharacterDataDirAdoptable(options.storageOptions);
    },
  );

  return Object.freeze({
    marker: assertExpectedCharacterDataMarker(
      layout,
      result.marker,
      options.characterId,
    ),
    created: result.created,
  });
}

/**
 * Records package materialization only after the overlay commit. If the
 * process stops between those writes, the old version remains and the
 * next selection safely repeats the missing-only merge.
 */
export async function recordMaterializedCharacterPackageVersion(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
  readonly packageVersion: string;
}): Promise<LocalRuntimeCharacterDataStorageSchemaMarker> {
  const layout = createLocalRuntimeStorageLayout(options.storageOptions);
  const result = await updateStorageSchemaMarker(layout, current => {
    const marker = assertExpectedCharacterDataMarker(
      layout,
      current,
      options.characterId,
    );

    return createLocalRuntimeStorageSchemaMarker({
      scope: 'character-data',
      characterId: marker.characterId,
      createdAt: marker.createdAt,
      materializedCharacterPackageVersion: options.packageVersion,
    });
  });

  return assertExpectedCharacterDataMarker(
    layout,
    result.marker,
    options.characterId,
  );
}

function requireCharacterDataMarkerScope(
  layout: LocalRuntimeStorageLayout,
  marker: LocalRuntimeStorageSchemaMarker,
): LocalRuntimeCharacterDataStorageSchemaMarker {
  if (marker.scope !== 'character-data') {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Directory "${layout.storeRoot}" is a "${marker.scope}" directory, not a character data directory.`,
    );
  }

  return marker;
}

function assertExpectedCharacterDataMarker(
  layout: LocalRuntimeStorageLayout,
  marker: LocalRuntimeStorageSchemaMarker,
  characterId: string,
): LocalRuntimeCharacterDataStorageSchemaMarker {
  const characterDataMarker = requireCharacterDataMarkerScope(layout, marker);

  if (characterDataMarker.characterId !== characterId) {
    throw new LocalRuntimeStorageContractError(
      'character_identity_mismatch',
      `Character data directory "${layout.storeRoot}" holds history for ` +
        `character "${characterDataMarker.characterId}" but character ` +
        `"${characterId}" was requested. Select ` +
        `"${characterDataMarker.characterId}", or create fresh data for ` +
        `"${characterId}".`,
    );
  }

  return characterDataMarker;
}

function assertRealCharacterDataParent(
  layout: LocalRuntimeStorageLayout,
): void {
  const parentRoot = dirname(layout.storeRoot);

  if (basename(parentRoot) !== characterDataDirectoryName) {
    return;
  }

  let parentStats;

  try {
    parentStats = lstatSync(parentRoot);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect the character-data root: ${parentRoot}.`,
    );
  }

  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data root "${parentRoot}" must be a real directory inside the Project02 home.`,
    );
  }
}

function assertRealDataControlFile(filePath: string, label: string): void {
  let stats;

  try {
    stats = lstatSync(filePath);
  } catch {
    return;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `${label} "${filePath}" must be a real file inside the data directory.`,
    );
  }
}

function assertRealDataControlRoot(rootPath: string, label: string): void {
  let stats;

  try {
    stats = lstatSync(rootPath);
  } catch {
    return;
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `${label} "${rootPath}" must be a real directory inside the data directory.`,
    );
  }
}

function defaultCharacterDataClock(): string {
  return new Date().toISOString();
}
