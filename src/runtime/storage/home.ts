/**
 * Project02 home initialization: the shared root that owns the global
 * config, secrets, installed plugin/character packages, and the
 * per-character data directories. Exactly one home marker guards it; the
 * per-character data dirs carry their own 'character-data' markers via
 * the session store's initialization path.
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

export async function ensureInitializedProject02Home(
  options: EnsureInitializedProject02HomeOptions = {},
): Promise<Project02HomeLayout> {
  const layout = createProject02HomeLayout(options);

  await assertProject02HomeAdoptable(options);

  const marker = readStorageSchemaMarker(layout);

  if (marker === undefined) {
    await ensureRealCharacterDataRoot(layout);
    const result = await ensureStorageSchemaMarker(
      layout,
      createLocalRuntimeStorageSchemaMarker({
        scope: 'home',
        createdAt: (options.now ?? defaultHomeClock)(),
      }),
      async () => {
        await assertProject02HomeAdoptable(options);
      },
    );
    assertProject02HomeMarker(layout, result.marker);

    return layout;
  }

  await ensureRealCharacterDataRoot(layout);
  return layout;
}

/**
 * Read-only twin of the initializer's refusals: a marker-less home
 * holding foreign entries, or a marker naming another scope, is
 * rejected without creating anything. Global config writes use this
 * before authoring settings into a directory the runtime would refuse
 * to adopt.
 */
export function assertProject02HomeAdoptable(
  options: Project02HomeLayoutOptions = {},
): Promise<void> {
  return Promise.resolve().then(() => {
    assertProject02HomeAdoptableSync(options);
  });
}

/**
 * Synchronous ownership admission for synchronous control transactions.
 * The async public entry delegates here so every writer applies exactly the
 * same home rules before creating locks or files.
 */
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

  // An initialized home is only usable if character data can actually
  // live in it — and if its own control entries are real: a symlinked
  // lock root or config file would route writes outside the home.
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

/**
 * Character data must live inside the home: a symlinked data root
 * would put identity markers and session history outside the home this
 * guard just validated.
 */
async function ensureRealCharacterDataRoot(
  layout: Project02HomeLayout,
): Promise<void> {
  const state = assertRealCharacterDataRootIfPresent(layout);

  if (state === 'absent') {
    await makeDirectory(layout.characterDataRoot, {recursive: true});
  }
}

/**
 * The shared env file must live inside the home before a mutation
 * writes secrets through it. Kept separate from the adoptability
 * assert: startup error precedence gives env-independent activation
 * errors priority over env-file problems, so only the mutation guards
 * call this.
 */
export function assertRealHomeEnvFile(
  options: Project02HomeLayoutOptions = {},
): Promise<void> {
  return Promise.resolve().then(() => {
    assertRealHomeEnvFileSync(options);
  });
}

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

/**
 * True when something is at the path but is not the kind the home requires.
 * An absent entry is not a violation — these are control paths the runtime
 * creates on demand — and neither is one that cannot be inspected: the reader
 * that actually opens it reports that far more precisely than this guard.
 */
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

    // A concurrent initializer's half-written control file is not
    // foreign content; its rename lands before that sibling proceeds.
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

// Entries a Project02 home may contain: the global config and secrets,
// the home lock root, installed plugin and character packages, the
// per-character data root, and the home marker itself. The directory
// roots are type-checked — a regular file called character-data is
// foreign, since adopting it would only defer to a raw mkdir failure.
// The file entries stay name-based: their readers (config loader, env
// reader, marker decode) report a wrong type far more precisely than
// this guard could.
function isProject02HomeControlEntry(
  layout: Project02HomeLayout,
  entry: Dirent,
): boolean {
  const entryPath = join(layout.homeRoot, entry.name);

  if (
    entryPath === layout.characterDataRoot ||
    entryPath === layout.locksRoot
  ) {
    // Never symlinks: a linked data root would carry character state
    // outside the home, and a linked lock root would coordinate this
    // home's writes through foreign control state.
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
    // Authored global config must live inside the home: mutations
    // canonicalize through links and would rewrite the target.
    return entry.isFile();
  }

  return entryPath === layout.envPath || entryPath === layout.schemaPath;
}

function defaultHomeClock(): string {
  return new Date().toISOString();
}
