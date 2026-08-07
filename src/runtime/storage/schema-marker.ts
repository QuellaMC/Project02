import {describeRealEntry} from '../../shared/real-path.ts';
import {atomicReplaceFileSync} from './atomic-file.ts';
import {
  decodeStorageSchemaMarker,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  type LocalRuntimeStorageSchemaMarker,
} from './layout-contract.ts';
import {acquireLocalRuntimeMutationLock} from './mutation-lock.ts';
import {readStoreText} from './store-file.ts';

const storageSchemaMarkerLockResourceKey = 'storage-schema';

type StorageSchemaMarkerLocation = {
  readonly schemaPath: string;
  readonly locksRoot: string;
};

type EnsureStorageSchemaMarkerResult = {
  readonly marker: LocalRuntimeStorageSchemaMarker;
  readonly created: boolean;
};

type UpdateStorageSchemaMarkerResult = {
  readonly marker: LocalRuntimeStorageSchemaMarker;
  readonly changed: boolean;
};

export function readStorageSchemaMarker(
  location: Pick<StorageSchemaMarkerLocation, 'schemaPath'>,
): LocalRuntimeStorageSchemaMarker | undefined {
  const marker = describeRealEntry(location.schemaPath);

  if (marker.kind === 'absent') {
    return undefined;
  }
  if (marker.kind === 'unreadable') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime storage schema marker: ${location.schemaPath}.`,
    );
  }
  if (marker.kind === 'link') {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Local runtime storage schema marker "${location.schemaPath}" is a symlink; the marker must be a regular file inside its storage directory.`,
    );
  }
  if (marker.kind !== 'file') {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Local runtime storage schema marker "${location.schemaPath}" must be a regular file inside its storage directory.`,
    );
  }

  return decodeStorageSchemaMarker(readStoreText(location.schemaPath).trim());
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

    atomicReplaceFileSync({
      targetPath: location.schemaPath,
      content: `${encodeStorageSchemaMarker(proposedMarker)}\n`,
    });

    return Object.freeze({marker: proposedMarker, created: true});
  } finally {
    await lock.release();
  }
}

/**
 * Callers provide the complete next marker, so the schema codec remains
 * the sole validation boundary.
 */
export async function updateStorageSchemaMarker(
  location: StorageSchemaMarkerLocation,
  update: (
    marker: LocalRuntimeStorageSchemaMarker,
  ) => LocalRuntimeStorageSchemaMarker,
  assertAdoptable: () => Promise<void> | void,
): Promise<UpdateStorageSchemaMarkerResult> {
  // The lock file lives inside the directory under claim: check ownership
  // before acquiring it, and again before the rename the lock cannot cover.
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

    atomicReplaceFileSync({
      targetPath: location.schemaPath,
      content: `${encodeStorageSchemaMarker(next)}\n`,
    });

    return Object.freeze({marker: next, changed: true});
  } finally {
    await lock.release();
  }
}
