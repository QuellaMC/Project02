/**
 * Project02 home initialization: the shared root that owns the global
 * config, secrets, installed plugin/character packages, and the
 * per-character data directories. Exactly one home marker guards it; the
 * per-character data dirs carry their own 'character-data' markers via
 * the session store's initialization path.
 */
import type {Dirent} from 'node:fs';
import {mkdir, readdir, readFile} from 'node:fs/promises';
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
  const marker = await readProject02HomeMarker(layout);

  if (marker === undefined) {
    if (await project02HomeHasForeignContent(layout)) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Project02 home "${layout.homeRoot}" contains foreign entries and no home marker; choose an empty or existing Project02 home directory.`,
      );
    }

    await mkdir(layout.characterDataRoot, {recursive: true});
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

  if (marker.scope !== 'home') {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Directory "${layout.homeRoot}" is a "${marker.scope}" directory, not a Project02 home; point --store at the home that contains it.`,
    );
  }

  await mkdir(layout.characterDataRoot, {recursive: true});
  return layout;
}

async function readProject02HomeMarker(layout: Project02HomeLayout) {
  let source: string;

  try {
    source = await readFile(layout.schemaPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
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
    if (isNodeErrorWithCode(error, 'ENOENT')) {
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
    entryPath === layout.locksRoot ||
    entryPath === layout.pluginPackagesRoot ||
    entryPath === layout.characterPackagesRoot ||
    entryPath === layout.characterDataRoot
  ) {
    return entry.isDirectory() || entry.isSymbolicLink();
  }

  return (
    entryPath === layout.configPath ||
    entryPath === layout.envPath ||
    entryPath === layout.schemaPath
  );
}

function defaultHomeClock(): string {
  return new Date().toISOString();
}
