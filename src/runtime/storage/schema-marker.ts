import {lstatSync, readFileSync} from 'node:fs';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {atomicReplaceFile} from './atomic-file.ts';
import {
  decodeStorageSchemaMarker,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  type LocalRuntimeStorageSchemaMarker,
} from './layout-contract.ts';
import {acquireLocalRuntimeMutationLock} from './mutation-lock.ts';

const storageSchemaMarkerLockResourceKey = 'storage-schema';

export type StorageSchemaMarkerLocation = {
  readonly schemaPath: string;
  readonly locksRoot: string;
};

export type EnsureStorageSchemaMarkerResult = {
  readonly marker: LocalRuntimeStorageSchemaMarker;
  readonly created: boolean;
};

export type UpdateStorageSchemaMarkerResult = {
  readonly marker: LocalRuntimeStorageSchemaMarker;
  readonly changed: boolean;
};

export function readStorageSchemaMarker(
  location: Pick<StorageSchemaMarkerLocation, 'schemaPath'>,
): LocalRuntimeStorageSchemaMarker | undefined {
  let markerStats;

  try {
    markerStats = lstatSync(location.schemaPath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime storage schema marker: ${location.schemaPath}.`,
    );
  }

  if (markerStats.isSymbolicLink()) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Local runtime storage schema marker "${location.schemaPath}" is a symlink; the marker must be a regular file inside its storage directory.`,
    );
  }

  if (!markerStats.isFile()) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Local runtime storage schema marker "${location.schemaPath}" must be a regular file inside its storage directory.`,
    );
  }

  let source: string;

  try {
    source = readFileSync(location.schemaPath, 'utf8');
  } catch {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime storage schema marker: ${location.schemaPath}.`,
    );
  }

  return decodeStorageSchemaMarker(source.trim());
}

export async function ensureStorageSchemaMarker(
  location: StorageSchemaMarkerLocation,
  proposedMarker: LocalRuntimeStorageSchemaMarker,
  assertAdoptable: () => Promise<void> | void,
): Promise<EnsureStorageSchemaMarkerResult> {
  const existing = readStorageSchemaMarker(location);

  if (existing !== undefined) {
    return Object.freeze({marker: existing, created: false});
  }

  const lock = await acquireLocalRuntimeMutationLock({
    locksRoot: location.locksRoot,
    resourceKey: storageSchemaMarkerLockResourceKey,
  });

  try {
    const reread = readStorageSchemaMarker(location);

    if (reread !== undefined) {
      return Object.freeze({marker: reread, created: false});
    }

    await assertAdoptable();

    await atomicReplaceFile({
      targetPath: location.schemaPath,
      content: `${encodeStorageSchemaMarker(proposedMarker)}\n`,
    });

    return Object.freeze({marker: proposedMarker, created: true});
  } finally {
    await lock.release();
  }
}

/**
 * Serialized marker update used after a separately committed durable
 * resource. Callers provide the complete next marker so the schema
 * codec remains the sole validation boundary, and the same
 * `assertAdoptable` guard the create path takes, because rewriting a
 * marker in place is no less of a claim on the directory than writing
 * the first one: the marker read here decides what gets encoded back
 * over it, so both have to come from a directory the caller still owns.
 */
export async function updateStorageSchemaMarker(
  location: StorageSchemaMarkerLocation,
  update: (
    marker: LocalRuntimeStorageSchemaMarker,
  ) => LocalRuntimeStorageSchemaMarker,
  assertAdoptable: () => Promise<void> | void,
): Promise<UpdateStorageSchemaMarkerResult> {
  // The lock file lives inside the directory under claim, so ownership is
  // checked before acquiring it and again before the rename: the first
  // check keeps the runtime from writing lock state into a directory it
  // does not own, the second closes the window the lock cannot cover
  // because the swap happens above it, in the path itself.
  await assertAdoptable();

  const lock = await acquireLocalRuntimeMutationLock({
    locksRoot: location.locksRoot,
    resourceKey: storageSchemaMarkerLockResourceKey,
  });

  try {
    const current = readStorageSchemaMarker(location);

    if (current === undefined) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Local runtime storage schema marker does not exist: ${location.schemaPath}.`,
      );
    }

    const next = update(current);

    if (
      encodeStorageSchemaMarker(next) === encodeStorageSchemaMarker(current)
    ) {
      return Object.freeze({marker: current, changed: false});
    }

    await assertAdoptable();

    await atomicReplaceFile({
      targetPath: location.schemaPath,
      content: `${encodeStorageSchemaMarker(next)}\n`,
    });

    return Object.freeze({marker: next, changed: true});
  } finally {
    await lock.release();
  }
}
