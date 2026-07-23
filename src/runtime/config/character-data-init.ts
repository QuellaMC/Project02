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
import {existsSync} from 'node:fs';

import {atomicReplaceFile} from '../storage/atomic-file.ts';
import {
  assertCharacterDataDirAdoptable,
  ensureCharacterDataStamp,
} from '../storage/character-binding.ts';
import {ensureInitializedProject02Home} from '../storage/home.ts';
import {
  characterDataDirPath,
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

export async function ensureCharacterDataDir(options: {
  readonly homeRoot?: string;
  readonly characterId: string;
  readonly seedDocument?: Project02RuntimeConfig;
  readonly now?: () => string;
}): Promise<EnsureCharacterDataDirResult> {
  // Preflight the data directory before the home initializer writes
  // the home marker: a rejected scoped write must not leave durable
  // home state behind.
  assertCharacterDataDirAdoptable({
    storeRoot: characterDataDirPath(
      createProject02HomeLayout(
        options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot},
      ).homeRoot,
      options.characterId,
    ),
  });

  const home = await ensureInitializedProject02Home(
    options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot},
  );
  const dataRoot = characterDataDirPath(home.homeRoot, options.characterId);
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
