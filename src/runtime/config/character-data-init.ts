/**
 * First-selection initialization of a character-data directory: home
 * guard, directory, binding stamp, and — when the character package
 * declares plugin defaults — one-time materialization of the overlay
 * config. Lives in runtime/config (not storage) because the overlay is
 * a config file: its lock key and canonical path must match the
 * mutation machinery exactly, so a CLI overlay write and this seed
 * serialize on the same lock.
 *
 * Lock order: the binding stamp's lock is taken and released first,
 * then the overlay's runtime-control-file lock — never nested the
 * other way, matching every other overlay writer.
 *
 * Materialization happens at most once per data directory: the overlay
 * file's presence is the marker. A file that already exists — seeded,
 * hand-written, or CLI-created, even empty — is never rewritten here.
 */
import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {atomicReplaceFile} from '../storage/atomic-file.ts';
import {ensureCharacterDataStamp} from '../storage/character-binding.ts';
import {ensureInitializedProject02Home} from '../storage/home.ts';
import {
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
} from '../storage/layout-contract.ts';
import {acquireLocalRuntimeMutationLock} from '../storage/mutation-lock.ts';
import {canonicalRuntimeConfigMutationPath} from './mutate.ts';
import {characterOverlayConfigPath} from './overlay.ts';
import type {Project02RuntimeConfig} from './types.ts';

export type EnsureCharacterDataDirResult = {
  readonly dataRoot: string;
  readonly overlayPath: string;
  /** True when this call wrote the first-selection overlay seed. */
  readonly overlaySeeded: boolean;
};

/**
 * A marker-less directory may hold only control entries (overlay,
 * binding stamp, lock root) before it is stamped. Anything else is
 * another character's history or a foreign tree: stamping it would
 * adopt that content under a permanent binding. A directory that has
 * a data marker is left to the storage readers, which validate it.
 */
function assertCharacterDataDirAdoptable(dataRoot: string): void {
  const layout = createLocalRuntimeStorageLayout({storeRoot: dataRoot});

  if (!existsSync(dataRoot) || existsSync(layout.schemaPath)) {
    return;
  }

  const foreignEntry = readdirSync(dataRoot).find(entry => {
    const entryPath = join(dataRoot, entry);

    return (
      entryPath !== layout.configPath &&
      entryPath !== layout.locksRoot &&
      entryPath !== layout.characterBindingPath
    );
  });

  if (foreignEntry !== undefined) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${dataRoot}" holds "${foreignEntry}" ` +
        'without a data marker; refusing to bind a character to it.',
    );
  }
}

export async function ensureCharacterDataDir(options: {
  readonly homeRoot?: string;
  readonly characterId: string;
  readonly seedDocument?: Project02RuntimeConfig;
  readonly now?: () => string;
}): Promise<EnsureCharacterDataDirResult> {
  const home = await ensureInitializedProject02Home(
    options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot},
  );
  const dataRoot = characterDataDirPath(home.homeRoot, options.characterId);

  assertCharacterDataDirAdoptable(dataRoot);

  const stamp = await ensureCharacterDataStamp({
    storageOptions: {storeRoot: dataRoot},
    characterId: options.characterId,
    ...(options.now === undefined ? {} : {now: options.now}),
  });

  if (stamp.status === 'rejected') {
    throw new LocalRuntimeStorageContractError(
      'character_binding_rejected',
      stamp.message,
    );
  }

  const overlayPath = characterOverlayConfigPath(dataRoot);

  if (options.seedDocument === undefined || existsSync(overlayPath)) {
    return Object.freeze({dataRoot, overlayPath, overlaySeeded: false});
  }

  // Same lock the mutation machinery takes for this file, so a
  // concurrent CLI overlay write and this seed serialize; whichever
  // lands first wins and the other sees the file as present.
  const canonicalOverlayPath = canonicalRuntimeConfigMutationPath(overlayPath);
  const lock = await acquireLocalRuntimeMutationLock({
    locksRoot: createProject02HomeLayout({homeRoot: dataRoot}).locksRoot,
    resourceKey: `runtime-control-file:${canonicalOverlayPath}`,
  });

  try {
    if (existsSync(overlayPath)) {
      return Object.freeze({dataRoot, overlayPath, overlaySeeded: false});
    }

    await atomicReplaceFile({
      targetPath: overlayPath,
      content: `${JSON.stringify(options.seedDocument, null, 2)}\n`,
    });
  } finally {
    await lock.release();
  }

  return Object.freeze({dataRoot, overlayPath, overlaySeeded: true});
}
