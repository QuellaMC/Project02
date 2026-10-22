/**
 * The daemon's record on its home: `<home>/daemon.json`, written whole at
 * mode 0600 by the daemon that holds the home's lease and by nothing
 * else. The token and the port belong to the home and outlive a run; the
 * `running` half names the run that last wrote it and is removed by a
 * clean stop. A reader never trusts `running` without asking the address:
 * after a crash it names a process that is gone, and the lease — not the
 * record — is what says a daemon is alive.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {isJsonRecord} from './json-record.ts';

/**
 * The home when none is named: where the daemon serves, and where a
 * client looks for it.
 */
export const defaultProject02HomeRoot = '.project02';

export const daemonRecordFileName = 'daemon.json';

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

export function readDaemonRecord(options: {
  readonly homeRoot: string;
}): DaemonRecordReading {
  const path = join(options.homeRoot, daemonRecordFileName);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? {status: 'absent'}
      : unreadable(path, error);
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
