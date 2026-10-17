import type {DaemonRecord} from '../../shared/daemon-record.ts';
import {
  atomicReplaceFileSync,
  cleanupAbandonedAtomicReplacementFilesSync,
} from './atomic-file.ts';
import {assertProject02HomeAdoptableSync} from './home.ts';
import {
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
  type Project02HomeLayoutOptions,
} from './layout-contract.ts';
import {
  acquireLocalRuntimeMutationLock,
  type LocalRuntimeMutationLockLease,
} from './mutation-lock.ts';

/**
 * Whole, at 0600: a token is a credential, like the key beside it in
 * config.json. A replacement a killed writer left behind is removed first;
 * the caller holds the daemon lease, so no other writer is mid-flight.
 */
export function writeDaemonRecord(
  options: Project02HomeLayoutOptions & {readonly record: DaemonRecord},
): void {
  const path = createProject02HomeLayout(options).daemonRecordPath;

  try {
    cleanupAbandonedAtomicReplacementFilesSync(path);
    atomicReplaceFileSync({
      targetPath: path,
      content: `${JSON.stringify(options.record, null, 2)}\n`,
      mode: 0o600,
      createParent: false,
    });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not write the daemon record: ${path}.`,
      {cause: error},
    );
  }
}

/**
 * One daemon per home: the lease a daemon holds for its lifetime, beside
 * the conversation-writer leases and under the same rules — refused at
 * once while held by a live process on this host, reclaimed from a dead
 * one.
 */
export async function acquireLocalRuntimeDaemonLease(
  options: Project02HomeLayoutOptions = {},
): Promise<LocalRuntimeMutationLockLease> {
  const layout = createProject02HomeLayout(options);

  assertProject02HomeAdoptableSync({homeRoot: layout.homeRoot});

  return await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: 'daemon',
    waitTimeoutMs: 0,
    busyCode: 'storage_busy',
  });
}
