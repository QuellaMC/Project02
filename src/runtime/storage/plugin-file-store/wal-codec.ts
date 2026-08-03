import {dirname} from 'node:path';

import {readTextFileSync} from '../../../shared/file-system.ts';

import type {RuntimePluginJsonValue} from '../../../plugins/index.ts';
import {
  assertRegularFile,
  assertSafeDurableTransactionJournalDirectory,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  writeTextAtomic,
} from './durable-primitives.ts';
import {
  freezeRuntimePluginFileStoreJsonValue,
  isPlainObject,
  normalizeRuntimePluginFileStorePath,
} from './shared.ts';

export const durableTransactionJournalVersion =
  'project02.plugin_transaction.v1';

/**
 * One durable write, described completely enough to finish or verify it
 * after a crash.
 *
 * A tool call's writes are durable when the call returns, so a journal
 * describes exactly one operation. There is no batch and nothing to roll
 * back: recovery either completes this write or confirms it already landed.
 */
export type DurablePluginFileStoreJournalOperation = {
  readonly pluginId: string;
  readonly path: string;
  readonly value: RuntimePluginJsonValue;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
} & (
  | {readonly kind: 'write_json'; readonly afterContent: string}
  | {
      readonly kind: 'append_jsonl';
      readonly beforeLength: number;
      readonly appendedLine: string;
      readonly afterLength: number;
    }
);

export type DurablePluginFileStoreJournal = {
  readonly version: typeof durableTransactionJournalVersion;
  readonly ownerHostname: string;
  readonly ownerNonce: string;
  readonly ownerPid: number;
  readonly sessionId: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
};

export function writeDurablePluginFileStoreJournal(
  journalPath: string,
  journal: DurablePluginFileStoreJournal,
): void {
  assertSafeDurableTransactionJournalDirectory(dirname(journalPath));
  writeTextAtomic(journalPath, `${JSON.stringify(journal)}\n`);
}

export function readDurablePluginFileStoreJournal(
  journalPath: string,
): DurablePluginFileStoreJournal {
  assertRegularFile(journalPath, 'Plugin fileStore transaction journal');

  let value: unknown;

  try {
    value = JSON.parse(readTextFileSync(journalPath)) as unknown;
  } catch (error: unknown) {
    throw new TypeError('Plugin fileStore transaction journal is malformed.', {
      cause: error,
    });
  }

  if (!isPlainObject(value)) {
    throw new TypeError('Plugin fileStore transaction journal is malformed.');
  }

  const version = value['version'];
  const ownerHostname = value['ownerHostname'];
  const ownerNonce = value['ownerNonce'];
  const ownerPid = value['ownerPid'];
  const sessionId = value['sessionId'];

  if (
    version !== durableTransactionJournalVersion ||
    !isNonEmptyString(ownerHostname) ||
    !isOwnerNonce(ownerNonce) ||
    !isPositiveSafeInteger(ownerPid) ||
    !isNonEmptyString(sessionId)
  ) {
    throw new TypeError('Plugin fileStore transaction journal is malformed.');
  }

  return Object.freeze({
    version,
    ownerHostname,
    ownerNonce,
    ownerPid,
    sessionId,
    operation: decodeDurablePluginFileStoreJournalOperation(value['operation']),
  } satisfies DurablePluginFileStoreJournal);
}

function isOwnerNonce(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function decodeDurablePluginFileStoreJournalOperation(
  value: unknown,
): DurablePluginFileStoreJournalOperation {
  if (!isPlainObject(value)) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  const pluginId = value['pluginId'];
  const path = value['path'];
  const kind = value['kind'];
  const beforeHash = value['beforeHash'];
  const afterHash = value['afterHash'];
  const beforeRevision = value['beforeRevision'];
  const afterRevision = value['afterRevision'];

  if (
    !isNonEmptyString(pluginId) ||
    !isNonEmptyString(path) ||
    (kind !== 'append_jsonl' && kind !== 'write_json') ||
    typeof beforeHash !== 'string' ||
    typeof afterHash !== 'string' ||
    !isNonNegativeSafeInteger(beforeRevision) ||
    !isNonNegativeSafeInteger(afterRevision) ||
    afterRevision !== beforeRevision + 1
  ) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  normalizeRuntimePluginFileStorePath(path);
  const common = {
    pluginId,
    path,
    value: freezeRuntimePluginFileStoreJsonValue(value['value']),
    beforeHash,
    afterHash,
    beforeRevision,
    afterRevision,
  };

  return Object.freeze(
    kind === 'write_json'
      ? {...common, kind, ...decodeWriteJsonFields(value)}
      : {...common, kind, ...decodeAppendJsonlFields(value, common.value)},
  );
}

function decodeWriteJsonFields(value: Readonly<Record<string, unknown>>): {
  readonly afterContent: string;
} {
  const afterContent = value['afterContent'];

  if (
    typeof afterContent !== 'string' ||
    value['beforeLength'] !== undefined ||
    value['appendedLine'] !== undefined ||
    value['afterLength'] !== undefined
  ) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  return {afterContent};
}

function decodeAppendJsonlFields(
  value: Readonly<Record<string, unknown>>,
  appendedValue: RuntimePluginJsonValue,
): {
  readonly beforeLength: number;
  readonly appendedLine: string;
  readonly afterLength: number;
} {
  const beforeLength = value['beforeLength'];
  const appendedLine = value['appendedLine'];
  const afterLength = value['afterLength'];

  if (
    value['afterContent'] !== undefined ||
    !isNonNegativeSafeInteger(beforeLength) ||
    typeof appendedLine !== 'string' ||
    !isNonNegativeSafeInteger(afterLength) ||
    afterLength !== beforeLength + Buffer.byteLength(appendedLine) ||
    appendedLine !== `${JSON.stringify(appendedValue)}\n`
  ) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  return {beforeLength, appendedLine, afterLength};
}
