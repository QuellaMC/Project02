/**
 * One home marker guards the shared root; the per-character data dirs
 * carry their own markers.
 */
import {
  listDirectoryEntriesSync,
  makeDirectory,
  type Dirent,
} from '../../shared/file-system.ts';
import {join} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {describeRealEntry, type RealEntry} from '../../shared/real-path.ts';
import {isLiveAtomicReplacementForAnyTarget} from './atomic-file.ts';
import {
  createLocalRuntimeStorageSchemaMarker,
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
  type LocalRuntimeStorageSchemaMarker,
  type Project02HomeLayout,
  type Project02HomeLayoutOptions,
} from './layout-contract.ts';
import {
  ensureStorageSchemaMarker,
  readStorageSchemaMarker,
} from './schema-marker.ts';

export type EnsureInitializedProject02HomeOptions =
  Project02HomeLayoutOptions & {
    readonly now?: () => string;
  };

/**
 * The storage half of a store; `ensureInitializedProject02Store` in
 * `runtime/config` is the whole one, and what CLIs call.
 */
export async function ensureInitializedProject02Home(
  options: EnsureInitializedProject02HomeOptions = {},
): Promise<Project02HomeLayout> {
  const layout = createProject02HomeLayout(options);

  assertProject02HomeAdoptableSync(options);

  const marker = readStorageSchemaMarker(layout);

  if (marker === undefined) {
    await ensureRealCharacterDataRoot(layout);
    const result = await ensureStorageSchemaMarker(
      layout,
      createLocalRuntimeStorageSchemaMarker({
        scope: 'home',
        createdAt: (options.now ?? defaultHomeClock)(),
      }),
      () => {
        assertProject02HomeAdoptableSync(options);
      },
    );
    assertProject02HomeMarker(layout, result.marker);

    return layout;
  }

  await ensureRealCharacterDataRoot(layout);
  return layout;
}

/**
 * Whether a run here would create a home out of nothing: the root is
 * absent, or present and empty.
 */
export function project02HomeCreationIsNew(
  options: Project02HomeLayoutOptions = {},
): boolean {
  const layout = createProject02HomeLayout(options);

  try {
    return listDirectoryEntriesSync(layout.homeRoot).length === 0;
  } catch (error: unknown) {
    return isNodeErrorWithCode(error, 'ENOENT');
  }
}

/** Applies the initializer's refusals without creating anything. */
export function assertProject02HomeAdoptableSync(
  options: Project02HomeLayoutOptions = {},
): void {
  const layout = createProject02HomeLayout(options);
  const marker = readStorageSchemaMarker(layout);

  if (marker === undefined) {
    if (project02HomeHasForeignContent(layout)) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Project02 home "${layout.homeRoot}" contains foreign entries and no home marker; choose an empty or existing Project02 home directory.`,
      );
    }

    return;
  }

  assertProject02HomeMarker(layout, marker);

  // A symlinked data root, lock root, or config file would route this
  // home's writes outside it.
  assertRealCharacterDataRootIfPresent(layout);
  assertRealHomeControlEntries(layout);
}

function assertProject02HomeMarker(
  layout: Project02HomeLayout,
  marker: LocalRuntimeStorageSchemaMarker,
): void {
  if (marker.scope !== 'home') {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Directory "${layout.homeRoot}" is a "${marker.scope}" directory, not a Project02 home; point --store at the home that contains it.`,
    );
  }
}

async function ensureRealCharacterDataRoot(
  layout: Project02HomeLayout,
): Promise<void> {
  const state = assertRealCharacterDataRootIfPresent(layout);

  if (state === 'absent') {
    await makeDirectory(layout.characterDataRoot, {recursive: true});
  }
}

/** Only mutation guards call this; activation errors outrank env-file ones. */
export function assertRealHomeEnvFileSync(
  options: Project02HomeLayoutOptions = {},
): void {
  const layout = createProject02HomeLayout(options);

  if (isPresentButNot(describeRealEntry(layout.envPath), 'file')) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Project02 home "${layout.homeRoot}" has an env file that is not ` +
        'a real file; home control state must live inside the home.',
    );
  }
}

function assertRealHomeControlEntries(layout: Project02HomeLayout): void {
  for (const entry of [
    {path: layout.locksRoot, kind: 'directory' as const, label: 'lock root'},
    {
      path: layout.conversationsRoot,
      kind: 'directory' as const,
      label: 'conversations root',
    },
    {path: layout.configPath, kind: 'file' as const, label: 'config file'},
  ]) {
    if (isPresentButNot(describeRealEntry(entry.path), entry.kind)) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Project02 home "${layout.homeRoot}" has a ${entry.label} that ` +
          `is not a real ${entry.kind}; home control state must live ` +
          'inside the home.',
      );
    }
  }
}

function isPresentButNot(
  entry: RealEntry,
  kind: 'file' | 'directory',
): boolean {
  return (
    entry.kind !== 'absent' &&
    entry.kind !== 'unreadable' &&
    entry.kind !== kind
  );
}

function assertRealCharacterDataRootIfPresent(
  layout: Project02HomeLayout,
): 'absent' | 'present' {
  const entry = describeRealEntry(layout.characterDataRoot);

  if (entry.kind === 'absent') {
    return 'absent';
  }
  if (entry.kind === 'unreadable') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect the character-data root: ${layout.characterDataRoot}.`,
    );
  }
  if (entry.kind !== 'directory') {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Project02 home "${layout.homeRoot}" has a character-data entry ` +
        'that is not a real directory; character data must live inside ' +
        'the home.',
    );
  }

  return 'present';
}

function project02HomeHasForeignContent(layout: Project02HomeLayout): boolean {
  let entries;

  try {
    entries = listDirectoryEntriesSync(layout.homeRoot);
  } catch (error: unknown) {
    if (
      isNodeErrorWithCode(error, 'ENOENT') ||
      isNodeErrorWithCode(error, 'ENOTDIR')
    ) {
      return false;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect Project02 home root: ${layout.homeRoot}.`,
    );
  }

  for (const entry of entries) {
    if (isProject02HomeControlEntry(layout, entry)) {
      continue;
    }

    // A concurrent initializer's half-written control file is not foreign.
    if (
      entry.isFile() &&
      isLiveAtomicReplacementForAnyTarget(entry.name, [
        layout.configPath,
        layout.envPath,
        layout.schemaPath,
      ])
    ) {
      continue;
    }

    return true;
  }

  return false;
}

function isProject02HomeControlEntry(
  layout: Project02HomeLayout,
  entry: Dirent,
): boolean {
  const entryPath = join(layout.homeRoot, entry.name);

  if (
    entryPath === layout.characterDataRoot ||
    entryPath === layout.conversationsRoot ||
    entryPath === layout.locksRoot
  ) {
    // A linked data, conversation, or lock root would carry this home's
    // state outside it.
    return entry.isDirectory();
  }

  if (
    entryPath === layout.pluginPackagesRoot ||
    entryPath === layout.characterPackagesRoot
  ) {
    // Installed packages may be intentionally linked in.
    return entry.isDirectory() || entry.isSymbolicLink();
  }

  if (entryPath === layout.configPath) {
    // Mutations canonicalize through links and would rewrite the target.
    return entry.isFile();
  }

  return entryPath === layout.envPath || entryPath === layout.schemaPath;
}

function defaultHomeClock(): string {
  return new Date().toISOString();
}
