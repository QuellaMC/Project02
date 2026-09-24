/**
 * The daemon's record on its home: `<home>/daemon.json`, written whole at
 * mode 0600 by the daemon that holds the home's lease and by nothing
 * else. The token and the port belong to the home and outlive a run; the
 * `running` half names the run that last wrote it and is removed by a
 * clean stop. A reader never trusts `running` without asking the address:
 * after a crash it names a process that is gone, and the lease — not the
 * record — is what says a daemon is alive.
 */
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {atomicReplaceFileSync} from './atomic-file.ts';
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
import {readOptionalStoreText} from './store-file.ts';

export type DaemonRecord = {
  /** The protocol the daemon that wrote it speaks. */
  readonly protocolVersion: number;
  /** Minted once per home, kept across runs; one line of printable ASCII. */
  readonly token: string;
  /** The port the last run bound, for the next one to bind again. */
  readonly port: number;
  /** The run that last wrote the record; absent after a clean stop. */
  readonly running?: {
    readonly pid: number;
    readonly startedAt: string;
  };
};

export type DaemonRecordReading =
  | {readonly status: 'absent'}
  /** There, but not a record: hand-edited, truncated, or unreadable. */
  | {readonly status: 'unreadable'; readonly message: string}
  | {readonly status: 'ok'; readonly record: DaemonRecord};

const tokenPattern = /^[\x21-\x7E]+$/u;

export function readDaemonRecord(
  options: Project02HomeLayoutOptions = {},
): DaemonRecordReading {
  const path = createProject02HomeLayout(options).daemonRecordPath;
  let text: string | undefined;

  try {
    text = readOptionalStoreText(path);
  } catch (error: unknown) {
    return unreadable(path, error);
  }

  if (text === undefined) {
    return {status: 'absent'};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return unreadable(path, error);
  }

  const record = decodeDaemonRecord(parsed);

  return record === undefined
    ? unreadable(path, new Error('not a daemon record'))
    : {status: 'ok', record};
}

/** Whole, at 0600: a token is a credential, like the key beside it in config.json. */
export function writeDaemonRecord(
  options: Project02HomeLayoutOptions & {readonly record: DaemonRecord},
): void {
  const path = createProject02HomeLayout(options).daemonRecordPath;

  try {
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
 * one. A wait, when one is asked for, ends early when its signal aborts.
 */
export async function acquireLocalRuntimeDaemonLease(
  options: Project02HomeLayoutOptions & {
    readonly waitTimeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<LocalRuntimeMutationLockLease> {
  const layout = createProject02HomeLayout(options);

  assertProject02HomeAdoptableSync({homeRoot: layout.homeRoot});

  return await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: 'daemon',
    waitTimeoutMs: options.waitTimeoutMs ?? 0,
    busyCode: 'storage_busy',
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });
}

function unreadable(path: string, cause: unknown): DaemonRecordReading {
  return {
    status: 'unreadable',
    message: `The daemon record ${path} could not be read: ${
      cause instanceof Error ? cause.message : String(cause)
    }.`,
  };
}

function decodeDaemonRecord(value: unknown): DaemonRecord | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const {protocolVersion, token, port, running} = value;

  if (
    typeof protocolVersion !== 'number' ||
    !Number.isSafeInteger(protocolVersion) ||
    typeof token !== 'string' ||
    !tokenPattern.test(token) ||
    !isPort(port)
  ) {
    return undefined;
  }

  if (running === undefined) {
    return {protocolVersion, token, port};
  }

  if (
    !isJsonRecord(running) ||
    typeof running['pid'] !== 'number' ||
    !Number.isSafeInteger(running['pid']) ||
    running['pid'] <= 0 ||
    typeof running['startedAt'] !== 'string'
  ) {
    return undefined;
  }

  return {
    protocolVersion,
    token,
    port,
    running: {pid: running['pid'], startedAt: running['startedAt']},
  };
}

function isPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}
