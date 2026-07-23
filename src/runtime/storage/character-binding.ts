/**
 * Character data-dir stamp: each `character-data/<id>/` directory carries
 * a binding file naming the one character whose history it holds. The
 * directory path already encodes the id; the stamp is the tamper guard
 * that survives directory renames and copies. Written atomically under
 * the data dir's mutation lock and never rewritten; display names remain
 * per-session historical facts, so the stamp carries the id only.
 */
import {lstatSync, readdirSync, readFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  atomicReplaceFile,
  isLiveAtomicReplacementForAnyTarget,
} from './atomic-file.ts';
import {
  characterBindingFileName,
  characterDataDirectoryName,
  createLocalRuntimeStorageLayout,
  decodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  type LocalRuntimeStorageLayoutOptions,
} from './layout-contract.ts';
import {acquireLocalRuntimeMutationLock} from './mutation-lock.ts';

export const characterBindingFormat = 'project02.character-binding.v1';
export {characterBindingFileName};
const characterBindingLockResourceKey = 'character-binding';

export type CharacterBinding = {
  readonly format: typeof characterBindingFormat;
  readonly characterId: string;
  readonly boundAt: string;
};

export type CharacterBindingReadResult =
  | {readonly status: 'bound'; readonly binding: CharacterBinding}
  | {readonly status: 'absent'}
  | {readonly status: 'malformed'; readonly message: string};

export function characterBindingPath(
  options: LocalRuntimeStorageLayoutOptions,
): string {
  return join(
    createLocalRuntimeStorageLayout(options).storeRoot,
    characterBindingFileName,
  );
}

export function readCharacterBinding(
  options: LocalRuntimeStorageLayoutOptions,
): CharacterBindingReadResult {
  const path = characterBindingPath(options);

  // The stamp is the permanent binding proof: a symlinked stamp would
  // let that proof live outside the store and change independently.
  let stampStats;

  try {
    stampStats = lstatSync(path);
  } catch {
    stampStats = undefined;
  }

  if (stampStats?.isSymbolicLink() === true) {
    return Object.freeze({
      status: 'malformed',
      message:
        `Character binding "${path}" is a symlink; the stamp must be a ` +
        'regular file inside the data directory.',
    });
  }

  let source: string;

  try {
    source = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    // ENOTDIR: the data root is not a directory; the storage layer owns
    // that diagnosis, so the binding reads as absent here.
    if (
      isNodeErrorWithCode(error, 'ENOENT') ||
      isNodeErrorWithCode(error, 'ENOTDIR')
    ) {
      return Object.freeze({status: 'absent'});
    }

    return malformedBinding(path);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return malformedBinding(path);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)['format'] !== characterBindingFormat ||
    typeof (parsed as Record<string, unknown>)['characterId'] !== 'string' ||
    ((parsed as Record<string, unknown>)['characterId'] as string).length ===
      0 ||
    typeof (parsed as Record<string, unknown>)['boundAt'] !== 'string'
  ) {
    return malformedBinding(path);
  }

  const record = parsed as Record<string, unknown>;

  return Object.freeze({
    status: 'bound',
    binding: Object.freeze({
      format: characterBindingFormat,
      characterId: record['characterId'] as string,
      boundAt: record['boundAt'] as string,
    } satisfies CharacterBinding),
  });
}

/**
 * A character data directory is adoptable when it is a real directory
 * (never a symlink out of the home), its data marker — if present —
 * decodes to the character-data scope, and a marker-less directory
 * holds only control entries (overlay, binding stamp, lock root).
 * Anything else is another character's history or a foreign tree:
 * stamping or authoring config there would adopt that content under a
 * permanent binding. Read-only; creates nothing.
 */
export function assertCharacterDataDirAdoptable(
  options: LocalRuntimeStorageLayoutOptions,
): void {
  const layout = createLocalRuntimeStorageLayout(options);

  // The character-data ROOT must be real, and the check runs even when
  // the per-character directory does not exist yet: a symlinked root
  // would resolve every per-character directory outside the home at
  // once, and read-only startups must refuse it exactly like writers.
  const parentRoot = dirname(layout.storeRoot);

  if (basename(parentRoot) === characterDataDirectoryName) {
    let parentStats;

    try {
      parentStats = lstatSync(parentRoot);
    } catch {
      parentStats = undefined;
    }

    if (parentStats?.isSymbolicLink() === true) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Character data root "${parentRoot}" is a symlink; character ` +
          'data must live inside the home.',
      );
    }

    if (parentStats !== undefined && !parentStats.isDirectory()) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Character data root "${parentRoot}" is not a directory.`,
      );
    }
  }

  let rootStats;

  try {
    rootStats = lstatSync(layout.storeRoot);
  } catch (error: unknown) {
    // ENOTDIR: an ancestor is not a directory; the storage layer owns
    // that diagnosis with a more precise error than this guard could.
    if (
      isNodeErrorWithCode(error, 'ENOENT') ||
      isNodeErrorWithCode(error, 'ENOTDIR')
    ) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect character data directory: ${layout.storeRoot}.`,
    );
  }

  if (rootStats.isSymbolicLink()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${layout.storeRoot}" is a symlink; ` +
        'character data must live inside the home.',
    );
  }

  if (!rootStats.isDirectory()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${layout.storeRoot}" is not a directory.`,
    );
  }

  let markerStats;

  try {
    markerStats = lstatSync(layout.schemaPath);
  } catch {
    markerStats = undefined;
  }

  // A symlinked marker cannot prove ownership: it would let a foreign
  // directory borrow another store's marker.
  if (markerStats?.isSymbolicLink() === true) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Data marker "${layout.schemaPath}" is a symlink; the marker ` +
        'must be a regular file inside the data directory.',
    );
  }

  if (markerStats !== undefined && !markerStats.isFile()) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Data marker "${layout.schemaPath}" is not a regular file.`,
    );
  }

  // Runtime control roots are part of the write boundary: a symlinked
  // lock or sessions root would coordinate or store durable state
  // outside the home.
  assertRealDataControlRoot(layout.locksRoot, 'Lock root');
  assertRealDataControlRoot(layout.sessionsRoot, 'Sessions root');

  if (markerStats !== undefined) {
    const marker = decodeStorageSchemaMarker(
      readFileSync(layout.schemaPath, 'utf8'),
    );

    if (marker.scope !== 'character-data') {
      throw new LocalRuntimeStorageContractError(
        'malformed_schema_marker',
        `Directory "${layout.storeRoot}" is a "${marker.scope}" ` +
          'directory, not a character data directory.',
      );
    }

    return;
  }

  const foreignEntry = readdirSync(layout.storeRoot).find(entry => {
    const entryPath = join(layout.storeRoot, entry);

    if (
      entryPath === layout.configPath ||
      entryPath === layout.locksRoot ||
      entryPath === layout.characterBindingPath
    ) {
      return false;
    }

    // A concurrent initializer's half-written marker — or a sibling
    // writer's overlay/stamp temp — is not foreign content; its rename
    // lands before that sibling proceeds. Abandoned temps stay foreign.
    return !isLiveAtomicReplacementForAnyTarget(entry, [
      layout.schemaPath,
      layout.configPath,
      layout.characterBindingPath,
    ]);
  });

  if (foreignEntry !== undefined) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${layout.storeRoot}" holds ` +
        `"${foreignEntry}" without a data marker; refusing to bind a ` +
        'character to it.',
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

  if (stats.isSymbolicLink()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `${label} "${rootPath}" is a symlink; it must live inside the ` +
        'data directory.',
    );
  }

  if (!stats.isDirectory()) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `${label} "${rootPath}" is not a directory.`,
    );
  }
}

/**
 * Composite read-only guard for consumers about to READ character
 * state: the binding stamp — if present — must name this character,
 * and the directory must be adoptable (real, in-home, marker-honest).
 */
export function assertCharacterDataDirReadable(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
}): void {
  const stamp = evaluateCharacterDataStamp(options);

  if (stamp?.status === 'rejected') {
    throw new LocalRuntimeStorageContractError(
      'character_binding_rejected',
      stamp.message,
    );
  }

  assertCharacterDataDirAdoptable(options.storageOptions);
}

export type EnsureCharacterDataStampResult =
  | {
      readonly status: 'stamped';
      readonly characterId: string;
      readonly created: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly code:
        'character_binding_mismatch' | 'character_binding_malformed';
      readonly message: string;
    };

/**
 * Creates the stamp on first use and verifies it afterwards. A mismatch
 * means the directory's history belongs to another character (renamed or
 * copied data dir) and is never adopted silently.
 */
export async function ensureCharacterDataStamp(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
  readonly now?: () => string;
}): Promise<EnsureCharacterDataStampResult> {
  // Adoptability first: an existing stamp inside a symlinked or
  // wrong-scope directory must not be trusted, and the guard runs
  // before the lock so even the lock root leaves no trace in a
  // directory this refuses to adopt.
  assertCharacterDataDirAdoptable(options.storageOptions);

  const existing = evaluateCharacterDataStamp(options);

  if (existing !== undefined) {
    return existing;
  }

  const layout = createLocalRuntimeStorageLayout(options.storageOptions);

  const lock = await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: characterBindingLockResourceKey,
  });

  try {
    const reread = evaluateCharacterDataStamp(options);

    if (reread !== undefined) {
      return reread;
    }

    await atomicReplaceFile({
      targetPath: characterBindingPath(options.storageOptions),
      content: `${JSON.stringify(
        {
          format: characterBindingFormat,
          characterId: options.characterId,
          boundAt: (options.now ?? defaultBindingTimestamp)(),
        },
        null,
        2,
      )}\n`,
    });
  } finally {
    await lock.release();
  }

  return Object.freeze({
    status: 'stamped',
    characterId: options.characterId,
    created: true,
  });
}

/**
 * Read-only twin of ensureCharacterDataStamp: reports how an existing
 * stamp relates to the requested character without ever writing one.
 * Returns undefined when no stamp exists yet.
 */
export function evaluateCharacterDataStamp(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
}): EnsureCharacterDataStampResult | undefined {
  const layout = createLocalRuntimeStorageLayout(options.storageOptions);
  const read = readCharacterBinding(options.storageOptions);

  if (read.status === 'malformed') {
    return Object.freeze({
      status: 'rejected',
      code: 'character_binding_malformed',
      message: read.message,
    });
  }

  if (read.status === 'bound') {
    if (read.binding.characterId === options.characterId) {
      return Object.freeze({
        status: 'stamped',
        characterId: read.binding.characterId,
        created: false,
      });
    }

    return Object.freeze({
      status: 'rejected',
      code: 'character_binding_mismatch',
      message:
        `Character data directory "${layout.storeRoot}" holds history for ` +
        `character "${read.binding.characterId}" but character ` +
        `"${options.characterId}" was requested. Select character ` +
        `"${read.binding.characterId}", or remove the copied directory and ` +
        `let the runtime create a fresh one for "${options.characterId}".`,
    });
  }

  return undefined;
}

function malformedBinding(path: string): CharacterBindingReadResult {
  return Object.freeze({
    status: 'malformed',
    message:
      `Character binding file "${path}" is unreadable or does not match ` +
      `format "${characterBindingFormat}". Restore it from backup; a ` +
      "data directory's binding is permanent and is never rewritten by " +
      'the runtime.',
  });
}

function defaultBindingTimestamp(): string {
  return new Date().toISOString();
}
