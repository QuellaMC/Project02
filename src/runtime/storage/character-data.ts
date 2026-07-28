import {listDirectoryNamesSync} from '../../shared/file-system.ts';
import {basename, dirname, join} from 'node:path';

import {describeRealEntry, pathIsAtOrBelow} from '../../shared/real-path.ts';
import {isLiveAtomicReplacementForAnyTarget} from './atomic-file.ts';
import {
  characterDataDirPath,
  characterDataDirectoryName,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeCharacterId,
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
 * Answers whether one already-canonical path belongs to Project02 character
 * storage. Ownership comes from an explicitly selected home or a valid
 * storage marker, never from a coincidental directory name.
 */
export function isProject02CharacterDataOwnedPath(options: {
  readonly canonicalPath: string;
  readonly selectedHomeRoot?: string;
}): boolean {
  if (
    options.selectedHomeRoot !== undefined &&
    pathIsAtOrBelow(
      options.canonicalPath,
      createProject02HomeLayout({
        homeRoot: options.selectedHomeRoot,
      }).characterDataRoot,
    )
  ) {
    return true;
  }

  let ancestor = dirname(options.canonicalPath);

  for (;;) {
    const marker = recognizedStorageMarker(ancestor);

    if (marker?.scope === 'character-data') {
      return true;
    }

    if (
      marker?.scope === 'home' &&
      pathIsAtOrBelow(
        options.canonicalPath,
        createProject02HomeLayout({homeRoot: ancestor}).characterDataRoot,
      )
    ) {
      return true;
    }

    const parent = dirname(ancestor);

    if (parent === ancestor) {
      return false;
    }

    ancestor = parent;
  }
}

function recognizedStorageMarker(
  directory: string,
): LocalRuntimeStorageSchemaMarker | undefined {
  try {
    return readStorageSchemaMarker(
      createProject02HomeLayout({homeRoot: directory}),
    );
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      return undefined;
    }

    throw error;
  }
}

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
  const homeOptions = {
    ...(options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot}),
  };
  // Normalize once, before anything is written. The path helper and the marker
  // constructor each normalize on their own, so carrying the raw ID further
  // would verify the persisted marker against a value that never reaches
  // storage -- failing after the home marker and data directory already exist.
  const characterId = normalizeLocalRuntimeCharacterId(options.characterId);
  const selectedHome = createProject02HomeLayout(homeOptions);
  const selectedDataRoot = characterDataDirPath(
    selectedHome.homeRoot,
    characterId,
  );

  // A rejected character directory must not leave a new home marker.
  assertCharacterDataDirAdoptable({storeRoot: selectedDataRoot});

  const home = await ensureInitializedProject02Home(homeOptions);
  const dataRoot = characterDataDirPath(home.homeRoot, characterId);
  await ensureCharacterDataMarker({
    storageOptions: {storeRoot: dataRoot},
    characterId,
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

  const root = describeRealEntry(layout.storeRoot);

  if (root.kind === 'absent') {
    return undefined;
  }
  if (root.kind === 'unreadable') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect character data directory: ${layout.storeRoot}.`,
    );
  }
  if (root.kind !== 'directory') {
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

  const foreignEntry = listDirectoryNamesSync(layout.storeRoot).find(entry => {
    const entryPath = join(layout.storeRoot, entry);

    if (
      entryPath === layout.configPath ||
      entryPath === layout.locksRoot ||
      (entryPath === layout.sessionsRoot &&
        listDirectoryNamesSync(layout.sessionsRoot).length === 0)
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
  const result = await updateStorageSchemaMarker(
    layout,
    current => {
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
    },
    () => {
      assertCharacterDataDirAdoptable(options.storageOptions);
    },
  );

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

/**
 * Compares a requested character against the one the directory records.
 *
 * The requested id is normalized first because the stored one always is:
 * `createLocalRuntimeStorageSchemaMarker` canonicalizes before writing.
 * Comparing a raw request against a canonical marker made a padded id
 * like `' mira '` claim the directory, write `mira` into the marker, and
 * then fail against its own write — a mismatch reported between two
 * spellings of one character. Normalizing both sides is what makes this
 * an identity comparison rather than a string comparison.
 */
function assertExpectedCharacterDataMarker(
  layout: LocalRuntimeStorageLayout,
  marker: LocalRuntimeStorageSchemaMarker,
  characterId: string,
): LocalRuntimeCharacterDataStorageSchemaMarker {
  const characterDataMarker = requireCharacterDataMarkerScope(layout, marker);
  const requestedCharacterId = normalizeLocalRuntimeCharacterId(characterId);

  if (characterDataMarker.characterId !== requestedCharacterId) {
    throw new LocalRuntimeStorageContractError(
      'character_identity_mismatch',
      `Character data directory "${layout.storeRoot}" holds history for ` +
        `character "${characterDataMarker.characterId}" but character ` +
        `"${requestedCharacterId}" was requested. Select ` +
        `"${characterDataMarker.characterId}", or create fresh data for ` +
        `"${requestedCharacterId}".`,
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

  const parent = describeRealEntry(parentRoot);

  if (parent.kind === 'absent') {
    return;
  }
  if (parent.kind === 'unreadable') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect the character-data root: ${parentRoot}.`,
    );
  }
  if (parent.kind !== 'directory') {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data root "${parentRoot}" must be a real directory inside the Project02 home.`,
    );
  }
}

function assertRealDataControlFile(filePath: string, label: string): void {
  assertRealDataControlEntry(filePath, label, 'file');
}

function assertRealDataControlRoot(rootPath: string, label: string): void {
  assertRealDataControlEntry(rootPath, label, 'directory');
}

/**
 * Control entries the data directory owns must be real: a link would carry
 * this character's history, locks, or settings outside the directory its
 * marker vouches for. Absent is fine — the runtime creates them on demand —
 * and so is unreadable, which the reader that opens it reports precisely.
 */
function assertRealDataControlEntry(
  path: string,
  label: string,
  kind: 'file' | 'directory',
): void {
  const entry = describeRealEntry(path);

  if (
    entry.kind !== 'absent' &&
    entry.kind !== 'unreadable' &&
    entry.kind !== kind
  ) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `${label} "${path}" must be a real ${kind} inside the data directory.`,
    );
  }
}

function defaultCharacterDataClock(): string {
  return new Date().toISOString();
}
