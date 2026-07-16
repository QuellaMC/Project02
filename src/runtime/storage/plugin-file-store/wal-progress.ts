import { splitCompleteJsonLines } from '../json-lines.ts';
import { isPlainObject } from './shared.ts';
import type { DurablePluginFileStoreJournal } from './wal-codec.ts';

export const durableTransactionProgressVersion =
  'project02.plugin_transaction_progress.v1';

export type DurablePluginFileStoreTransactionProgress = {
  readonly version: typeof durableTransactionProgressVersion;
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly ownerNonce: string;
  readonly sessionId: string;
  readonly baseRevisions: readonly {
    readonly pluginId: string;
    readonly revision: number;
  }[];
  readonly appliedCount: number;
};

export function parseDurablePluginFileStoreTransactionProgress(
  content: string,
  journal: DurablePluginFileStoreJournal
): DurablePluginFileStoreTransactionProgress {
  const lines = requiredProgressLines(content);
  const header = requiredProgressHeader(lines[0] ?? '', journal);
  const baseRevisions = requiredProgressBaseRevisions(
    header['baseRevisions'],
    journal
  );
  const appliedCount = requiredAppliedOperationCount(lines, journal);

  return Object.freeze({
    version: durableTransactionProgressVersion,
    eventId: journal.eventId,
    traceId: journal.traceId,
    createdAt: journal.createdAt,
    ownerNonce: journal.ownerNonce,
    sessionId: journal.sessionId,
    baseRevisions,
    appliedCount
  } satisfies DurablePluginFileStoreTransactionProgress);
}

function requiredProgressLines(content: string): readonly string[] {
  let lines: readonly string[];

  try {
    lines = splitCompleteJsonLines(content);
  } catch (error: unknown) {
    throw malformedProgress(error);
  }

  if (lines.length < 1) {
    throw malformedProgress();
  }

  return lines;
}

function requiredProgressHeader(
  line: string,
  journal: DurablePluginFileStoreJournal
): Readonly<Record<string, unknown>> {
  let header: unknown;

  try {
    header = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    throw malformedProgress(error);
  }

  if (!progressHeaderMatchesJournal(header, journal)) {
    throw malformedProgress();
  }

  return header;
}

function progressHeaderMatchesJournal(
  header: unknown,
  journal: DurablePluginFileStoreJournal
): header is Readonly<Record<string, unknown>> {
  return (
    isPlainObject(header) &&
    header['version'] === durableTransactionProgressVersion &&
    header['eventId'] === journal.eventId &&
    header['traceId'] === journal.traceId &&
    header['createdAt'] === journal.createdAt &&
    header['ownerNonce'] === journal.ownerNonce &&
    header['sessionId'] === journal.sessionId &&
    header['appliedCount'] === 0 &&
    Array.isArray(header['baseRevisions']) &&
    journal.operations.every((operation) => operation.status === 'planned')
  );
}

function requiredProgressBaseRevisions(
  value: unknown,
  journal: DurablePluginFileStoreJournal
): DurablePluginFileStoreTransactionProgress['baseRevisions'] {
  if (!Array.isArray(value)) {
    throw malformedProgress();
  }

  const expectedPluginIds = [
    ...new Set(journal.operations.map((operation) => operation.pluginId))
  ].sort((left, right) => left.localeCompare(right));
  const baseRevisions = value.map((revision, index) =>
    requiredProgressBaseRevision(revision, expectedPluginIds[index])
  );

  if (baseRevisions.length !== expectedPluginIds.length) {
    throw malformedProgress();
  }

  return Object.freeze(baseRevisions);
}

function requiredProgressBaseRevision(
  value: unknown,
  expectedPluginId: string | undefined
): DurablePluginFileStoreTransactionProgress['baseRevisions'][number] {
  if (
    expectedPluginId === undefined ||
    !isPlainObject(value) ||
    value['pluginId'] !== expectedPluginId ||
    !isNonNegativeSafeInteger(value['revision'])
  ) {
    throw malformedProgress();
  }

  return Object.freeze({
    pluginId: expectedPluginId,
    revision: value['revision']
  });
}

function requiredAppliedOperationCount(
  lines: readonly string[],
  journal: DurablePluginFileStoreJournal
): number {
  let appliedCount = 0;

  for (const line of lines.slice(1, -1)) {
    const nextAppliedCount = Number(line);

    if (
      !isNonNegativeSafeInteger(nextAppliedCount) ||
      nextAppliedCount <= appliedCount ||
      line !== String(nextAppliedCount)
    ) {
      throw malformedProgress();
    }

    appliedCount = nextAppliedCount;
  }

  if (appliedCount > journal.operations.length) {
    throw malformedProgress();
  }

  return appliedCount;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function malformedProgress(cause?: unknown): TypeError {
  return cause === undefined
    ? new TypeError('Plugin fileStore transaction progress is malformed.')
    : new TypeError('Plugin fileStore transaction progress is malformed.', {
        cause
      });
}
