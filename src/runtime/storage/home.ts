/**
 * Project02 home initialization: the shared root that owns the global
 * config, secrets, installed plugin/character packages, and the
 * per-character data directories. Exactly one home marker guards it; the
 * per-character data dirs carry their own 'character-data' markers via
 * the session store's initialization path.
 */
import type {Dirent} from 'node:fs';
import {lstat, mkdir, readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  atomicReplaceFile,
  isLiveAtomicReplacementForAnyTarget,
} from './atomic-file.ts';
import {
  createLocalRuntimeStorageSchemaMarker,
  createProject02HomeLayout,
  decodeStorageSchemaMarker,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  type Project02HomeLayout,
  type Project02HomeLayoutOptions,
} from './layout-contract.ts';

export type EnsureInitializedProject02HomeOptions =
  Project02HomeLayoutOptions & {
    readonly now?: () => string;
  };

export async function ensureInitializedProject02Home(
  options: EnsureInitializedProject02HomeOptions = {},
): Promise<Project02HomeLayout> {
  const layout = createProject02HomeLayout(options);

  await assertProject02HomeAdoptable(options);

  const marker = await readProject02HomeMarker(layout);

  if (marker === undefined) {
    await ensureRealCharacterDataRoot(layout);
    await atomicReplaceFile({
      targetPath: layout.schemaPath,
      content: `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          scope: 'home',
          createdAt: (options.now ?? defaultHomeClock)(),
        }),
      )}\n`,
    });

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
export async function assertProject02HomeAdoptable(
  options: Project02HomeLayoutOptions = {},
): Promise<void> {
  const layout = createProject02HomeLayout(options);
  const marker = await readProject02HomeMarker(layout);

  if (marker === undefined) {
    if (await project02HomeHasForeignContent(layout)) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Project02 home "${layout.homeRoot}" contains foreign entries and no home marker; choose an empty or existing Project02 home directory.`,
      );
    }

    return;
  }

  if (marker.scope !== 'home') {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Directory "${layout.homeRoot}" is a "${marker.scope}" directory, not a Project02 home; point --store at the home that contains it.`,
    );
  }

  // An initialized home is only usable if character data can actually
  // live in it — and if its own control entries are real: a symlinked
  // lock root or config file would route writes outside the home.
  await assertRealCharacterDataRootIfPresent(layout);
  await assertRealHomeControlEntries(layout);
}

/**
 * Character data must live inside the home: a symlinked data root
 * would put binding stamps and session history outside the home this
 * guard just validated.
 */
async function ensureRealCharacterDataRoot(
  layout: Project02HomeLayout,
): Promise<void> {
  const state = await assertRealCharacterDataRootIfPresent(layout);

  if (state === 'absent') {
    await mkdir(layout.characterDataRoot, {recursive: true});
  }
}

/**
 * The shared env file must live inside the home before a mutation
 * writes secrets through it. Kept separate from the adoptability
 * assert: startup error precedence gives env-independent activation
 * errors priority over env-file problems, so only the mutation guards
 * call this.
 */
export async function assertRealHomeEnvFile(
  options: Project02HomeLayoutOptions = {},
): Promise<void> {
  const layout = createProject02HomeLayout(options);
  let stats;

  try {
    stats = await lstat(layout.envPath);
  } catch {
    return;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Project02 home "${layout.homeRoot}" has an env file that is not ` +
        'a real file; home control state must live inside the home.',
    );
  }
}

async function assertRealHomeControlEntries(
  layout: Project02HomeLayout,
): Promise<void> {
  for (const entry of [
    {path: layout.locksRoot, kind: 'directory' as const, label: 'lock root'},
    {path: layout.configPath, kind: 'file' as const, label: 'config file'},
  ]) {
    let stats;

    try {
      stats = await lstat(entry.path);
    } catch {
      continue;
    }

    if (
      stats.isSymbolicLink() ||
      (entry.kind === 'directory' ? !stats.isDirectory() : !stats.isFile())
    ) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Project02 home "${layout.homeRoot}" has a ${entry.label} that ` +
          `is not a real ${entry.kind}; home control state must live ` +
          'inside the home.',
      );
    }
  }
}

async function assertRealCharacterDataRootIfPresent(
  layout: Project02HomeLayout,
): Promise<'absent' | 'present'> {
  let stats;

  try {
    stats = await lstat(layout.characterDataRoot);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return 'absent';
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect the character-data root: ${layout.characterDataRoot}.`,
    );
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Project02 home "${layout.homeRoot}" has a character-data entry ` +
        'that is not a real directory; character data must live inside ' +
        'the home.',
    );
  }

  return 'present';
}

async function readProject02HomeMarker(layout: Project02HomeLayout) {
  // The marker is the ownership guard itself: a symlinked marker would
  // let any directory borrow another home's proof of initialization.
  let markerStats;

  try {
    markerStats = await lstat(layout.schemaPath);
  } catch {
    markerStats = undefined;
  }

  if (markerStats?.isSymbolicLink() === true) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Project02 home marker "${layout.schemaPath}" is a symlink; the ` +
        'marker must be a regular file inside the home.',
    );
  }

  let source: string;

  try {
    source = await readFile(layout.schemaPath, 'utf8');
  } catch (error: unknown) {
    // ENOTDIR: the home root is not a directory; the storage layer
    // owns that diagnosis with a more precise error than this guard.
    if (
      isNodeErrorWithCode(error, 'ENOENT') ||
      isNodeErrorWithCode(error, 'ENOTDIR')
    ) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read Project02 home marker: ${layout.schemaPath}.`,
    );
  }

  return decodeStorageSchemaMarker(source.trim());
}

async function project02HomeHasForeignContent(
  layout: Project02HomeLayout,
): Promise<boolean> {
  let entries;

  try {
    entries = await readdir(layout.homeRoot, {withFileTypes: true});
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
