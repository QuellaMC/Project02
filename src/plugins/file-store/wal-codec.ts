import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { RuntimeEventIdentity } from '../../runtime/event.ts';
import { createLocalRuntimeSessionPaths } from '../../runtime/storage/layout.ts';
import type { RuntimePluginJsonValue } from '../types.ts';
import {
  assertRegularFile,
  assertSafeDurableTransactionJournalDirectory,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  writeTextAtomic
} from './durable-primitives.ts';
import {
  freezeRuntimePluginFileStoreJsonValue,
  isMissingFileError,
  isPlainObject,
  normalizeRuntimePluginFileStorePath
} from './shared.ts';

export const durableTransactionJournalVersion =
  'project02.plugin_transaction.v1';

export type DurablePluginFileStoreJournalOperation = {
  readonly index: number;
  readonly pluginId: string;
  readonly path: string;
  readonly kind: 'append_jsonl' | 'write_json';
  readonly value: RuntimePluginJsonValue;
  readonly status: 'pending' | 'planned' | 'applied';
  readonly expectedBeforeHash?: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly afterContent?: string;
  readonly beforeLength?: number;
  readonly appendedLine?: string;
  readonly afterLength?: number;
  readonly beforeRevision?: number;
  readonly afterRevision?: number;
};

export type DurablePluginFileStoreJournal = {
  readonly version: typeof durableTransactionJournalVersion;
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly ownerPid: number;
  readonly sessionId: string;
  readonly operations: readonly DurablePluginFileStoreJournalOperation[];
};

export function durablePluginFileStoreTransactionJournalPath(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly identity: Pick<RuntimeEventIdentity, 'eventId' | 'traceId'>;
}): string {
  const sessionPaths = createLocalRuntimeSessionPaths(options);
  const key = createHash('sha256')
    .update(options.identity.eventId)
    .update('\u0000')
    .update(options.identity.traceId)
    .digest('hex');

  return join(
    sessionPaths.sessionRoot,
    '.plugin-transactions',
    `${key}.json`
  );
}

export function assertDurableTransactionJournalDoesNotExist(
  journalPath: string
): void {
  try {
    lstatSync(journalPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  throw new Error('Plugin fileStore transaction journal already exists.');
}

export function writeDurablePluginFileStoreJournal(
  journalPath: string,
  journal: DurablePluginFileStoreJournal
): void {
  assertSafeDurableTransactionJournalDirectory(dirname(journalPath));
  writeTextAtomic(journalPath, `${JSON.stringify(journal)}\n`);
}

export function readDurablePluginFileStoreJournal(
  journalPath: string
): DurablePluginFileStoreJournal {
  assertRegularFile(journalPath, 'Plugin fileStore transaction journal');

  let value: unknown;

  try {
    value = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    throw new TypeError('Plugin fileStore transaction journal is malformed.', {
      cause: error
    });
  }

  if (!isPlainObject(value)) {
    throw new TypeError('Plugin fileStore transaction journal is malformed.');
  }

  const version = value['version'];
  const eventId = value['eventId'];
  const traceId = value['traceId'];
  const createdAt = value['createdAt'];
  const ownerPid = value['ownerPid'];
  const sessionId = value['sessionId'];
  const rawOperations = value['operations'];

  if (
    version !== durableTransactionJournalVersion ||
    !isNonEmptyString(eventId) ||
    !isNonEmptyString(traceId) ||
    !isNonEmptyString(createdAt) ||
    !isPositiveSafeInteger(ownerPid) ||
    !isNonEmptyString(sessionId) ||
    !Array.isArray(rawOperations)
  ) {
    throw new TypeError('Plugin fileStore transaction journal is malformed.');
  }

  const operations = rawOperations.map((rawOperation, index) =>
    decodeDurablePluginFileStoreJournalOperation(rawOperation, index)
  );

  return Object.freeze({
    version,
    eventId,
    traceId,
    createdAt,
    ownerPid,
    sessionId,
    operations: Object.freeze(operations)
  } satisfies DurablePluginFileStoreJournal);
}

function decodeDurablePluginFileStoreJournalOperation(
  value: unknown,
  expectedIndex: number
): DurablePluginFileStoreJournalOperation {
  if (!isPlainObject(value)) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  const index = value['index'];
  const pluginId = value['pluginId'];
  const path = value['path'];
  const kind = value['kind'];
  const status = value['status'];

  if (
    index !== expectedIndex ||
    !isNonEmptyString(pluginId) ||
    !isNonEmptyString(path) ||
    (kind !== 'append_jsonl' && kind !== 'write_json') ||
    (status !== 'pending' && status !== 'planned' && status !== 'applied')
  ) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  normalizeRuntimePluginFileStorePath(path);
  const operation = {
    index,
    pluginId,
    path,
    kind,
    value: freezeRuntimePluginFileStoreJsonValue(value['value']),
    status,
    ...decodePlannedJournalOperationFields(value, kind, status)
  } satisfies DurablePluginFileStoreJournalOperation;

  if (
    kind === 'append_jsonl' &&
    status !== 'pending' &&
    operation.appendedLine !== `${JSON.stringify(operation.value)}\n`
  ) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  return Object.freeze(operation);
}

function decodePlannedJournalOperationFields(
  value: Readonly<Record<string, unknown>>,
  kind: DurablePluginFileStoreJournalOperation['kind'],
  status: DurablePluginFileStoreJournalOperation['status']
): Partial<
  Pick<
    DurablePluginFileStoreJournalOperation,
    | 'afterContent'
    | 'afterHash'
    | 'afterLength'
    | 'afterRevision'
    | 'appendedLine'
    | 'beforeHash'
    | 'beforeLength'
    | 'beforeRevision'
  >
> {
  const beforeHash = value['beforeHash'];
  const afterHash = value['afterHash'];
  const afterContent = value['afterContent'];
  const beforeLength = value['beforeLength'];
  const appendedLine = value['appendedLine'];
  const afterLength = value['afterLength'];
  const beforeRevision = value['beforeRevision'];
  const afterRevision = value['afterRevision'];
  const fields = [
    beforeHash,
    afterHash,
    afterContent,
    beforeLength,
    appendedLine,
    afterLength,
    beforeRevision,
    afterRevision
  ];

  if (status === 'pending' && fields.every((field) => field === undefined)) {
    return {};
  }

  if (
    typeof beforeHash !== 'string' ||
    typeof afterHash !== 'string' ||
    !isNonNegativeSafeInteger(beforeRevision) ||
    !isNonNegativeSafeInteger(afterRevision) ||
    afterRevision !== beforeRevision + 1
  ) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  const common = {
    beforeHash,
    afterHash,
    beforeRevision,
    afterRevision
  };

  if (kind === 'write_json') {
    if (
      typeof afterContent !== 'string' ||
      beforeLength !== undefined ||
      appendedLine !== undefined ||
      afterLength !== undefined
    ) {
      throw new TypeError('Plugin fileStore transaction operation is malformed.');
    }

    return { ...common, afterContent };
  }

  if (
    afterContent !== undefined ||
    !isNonNegativeSafeInteger(beforeLength) ||
    typeof appendedLine !== 'string' ||
    !isNonNegativeSafeInteger(afterLength) ||
    afterLength !== beforeLength + Buffer.byteLength(appendedLine)
  ) {
    throw new TypeError('Plugin fileStore transaction operation is malformed.');
  }

  return {
    ...common,
    beforeLength,
    appendedLine,
    afterLength
  };
}
