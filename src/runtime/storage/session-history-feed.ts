import type {
  RuntimePluginSessionHistoryFeed,
  RuntimePluginSessionHistoryListing,
  RuntimePluginSessionHistoryMessage,
  SessionHistoryMessageBatch,
} from '../../plugins/api/index.ts';
import {
  closeFileSync,
  openFileSync,
  readBytesFromFileSync,
  statFileSync,
} from '../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {conversationMessageForRawEvent} from '../evidence/cache.ts';
import type {ConversationLogRecord} from '../evidence/records.ts';
import {
  assertCharacterDataDirReadable,
  requireCharacterDataMarker,
} from './character-data.ts';
import {readUndamagedJsonLines} from './json-lines.ts';
import {
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeCharacterId,
  parseSegmentSessionId,
  type LocalRuntimeSessionMetadata,
  type LocalRuntimeStorageLayout,
} from './layout-contract.ts';

export type ConversationSegmentListing = {
  /** This conversation's segments in order; the last is the current one. */
  readonly segments: readonly {
    readonly sessionId: string;
    readonly segment: number;
  }[];
  /** Catalog rows that would not decode; they are nobody's segment. */
  readonly damagedEntryCount: number;
};

/**
 * One character's segments of one conversation, read leniently: a damaged
 * or stray catalog row is skipped, and a character without a data directory
 * has no segments yet. The catalog's own order is by creation, so the
 * segment number decides.
 */
export function listConversationSegments(options: {
  readonly storeRoot: string;
  readonly characterId: string;
  readonly conversationId: string;
}): ConversationSegmentListing {
  const characterId = normalizeLocalRuntimeCharacterId(options.characterId);
  const storageOptions = {storeRoot: options.storeRoot};

  if (
    assertCharacterDataDirReadable({storageOptions, characterId}) === undefined
  ) {
    return Object.freeze({segments: Object.freeze([]), damagedEntryCount: 0});
  }

  const catalog = readLenientSessionCatalog(
    createLocalRuntimeStorageLayout(storageOptions),
  );
  const segments: {readonly sessionId: string; readonly segment: number}[] = [];

  for (const metadata of catalog.sessions) {
    let parsed;

    try {
      parsed = parseSegmentSessionId(metadata.sessionId);
    } catch {
      continue;
    }

    if (parsed.conversationId === options.conversationId) {
      segments.push(
        Object.freeze({sessionId: metadata.sessionId, segment: parsed.segment}),
      );
    }
  }

  segments.sort((left, right) => left.segment - right.segment);

  return Object.freeze({
    segments: Object.freeze(segments),
    damagedEntryCount: catalog.damagedEntryCount,
  });
}

export type CommittedConversationMessages = {
  readonly messages: readonly ConversationLogRecord[];
  /** Lines that would not decode; the tolerant read skips them. */
  readonly damagedRecordCount: number;
};

/**
 * One segment's committed visible messages, whole, through the same
 * tolerant read the plugin feed uses: torn tails invisible, damaged records
 * counted and skipped. A segment the catalog names has its directory —
 * the directory is made before the row and removed after it — so a
 * missing one is damage, never an empty segment. The gateway's history is
 * built on this.
 */
export function readCommittedConversationMessages(options: {
  readonly storeRoot: string;
  readonly characterId: string;
  readonly sessionId: string;
}): CommittedConversationMessages {
  const characterId = normalizeLocalRuntimeCharacterId(options.characterId);

  requireCharacterDataMarker({
    storageOptions: {storeRoot: options.storeRoot},
    characterId,
  });

  const layout = createLocalRuntimeStorageLayout({
    storeRoot: options.storeRoot,
  });

  assertSessionDirectoryReadable(layout, options.sessionId);

  return committedMessagesFromTail(
    readCommittedTranscriptTail(
      createLocalRuntimeSessionPaths({
        storeRoot: layout.storeRoot,
        sessionId: options.sessionId,
      }).rawEventsPath,
      0,
    ),
  );
}
import {decodeRawEventLogRecord} from './raw-event-codec.ts';
import {
  assertSessionDirectoryReadable,
  decodeSessionMetadata,
} from './session-store.ts';
import {readOptionalStoreText} from './store-file.ts';

const sessionHistoryCursorPattern = /^v1:(\d{1,15})$/u;

export type LenientSessionCatalog = {
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
  readonly damagedEntryCount: number;
};

/**
 * The privacy boundary between plugins and the canonical log: only
 * committed visible messages leave this module, and one tolerant reader
 * serves every consumer instead of each growing its own.
 */
export function createLocalRuntimeSessionHistoryFeed(options: {
  readonly storeRoot: string;
  readonly characterId: string;
}): RuntimePluginSessionHistoryFeed {
  const characterId = normalizeLocalRuntimeCharacterId(options.characterId);

  requireCharacterDataMarker({
    storageOptions: {storeRoot: options.storeRoot},
    characterId,
  });

  const layout = createLocalRuntimeStorageLayout({
    storeRoot: options.storeRoot,
  });

  return Object.freeze({
    characterId,

    listSessions(): RuntimePluginSessionHistoryListing {
      return readLenientSessionCatalog(layout);
    },

    readNewMessages(readOptions): SessionHistoryMessageBatch {
      // The same real-directory refusal as the session reader: a linked
      // session root must not route reads outside the character store. An
      // absent directory stays lenient and reads as an empty session.
      assertSessionDirectoryReadable(layout, readOptions.sessionId, 'allow');

      const rawEventsPath = createLocalRuntimeSessionPaths({
        storeRoot: layout.storeRoot,
        sessionId: readOptions.sessionId,
      }).rawEventsPath;
      const requestedOffset = decodeSessionHistoryCursor(readOptions.cursor);
      const tail =
        requestedOffset === undefined
          ? undefined
          : readCommittedTranscriptTail(
              rawEventsPath,
              requestedOffset,
              readOptions.maxBytes,
            );

      // An unreadable cursor or a transcript shrunk beneath it restarts
      // the session from the top.
      if (tail === undefined || tail.kind === 'stale_watermark') {
        const fresh = readCommittedTranscriptTail(
          rawEventsPath,
          0,
          readOptions.maxBytes,
        );

        return sessionHistoryBatch(readOptions.sessionId, 0, fresh, true);
      }

      if (tail.kind === 'absent') {
        return requestedOffset !== undefined && requestedOffset > 0
          ? emptySessionHistoryBatch(true)
          : emptySessionHistoryBatch(false);
      }

      return sessionHistoryBatch(
        readOptions.sessionId,
        requestedOffset ?? 0,
        tail,
        false,
      );
    },
  } satisfies RuntimePluginSessionHistoryFeed);
}

/**
 * Catalog rows are decoded leniently and damage is counted, mirroring the
 * per-session rule in `decodeRequestedSessionCatalogEntry`: reading history
 * must not depend on every other entry being intact.
 */
export function readLenientSessionCatalog(
  layout: LocalRuntimeStorageLayout,
): LenientSessionCatalog {
  const content = readOptionalStoreText(layout.sessionCatalogPath);

  if (content === undefined) {
    return Object.freeze({sessions: Object.freeze([]), damagedEntryCount: 0});
  }

  const parseableLines = readUndamagedJsonLines(content);
  const committedLineCount =
    content.length === 0 ? 0 : content.split('\n').length - 1;
  const bySessionId = new Map<string, LocalRuntimeSessionMetadata>();
  let decodedLineCount = 0;

  for (const line of parseableLines) {
    try {
      const metadata = decodeSessionMetadata(line);

      decodedLineCount += 1;
      bySessionId.set(metadata.sessionId, metadata);
    } catch {
      // Counted below with the unparseable lines.
    }
  }

  return Object.freeze({
    sessions: Object.freeze([...bySessionId.values()]),
    damagedEntryCount: committedLineCount - decodedLineCount,
  });
}

export type CommittedTranscriptTail =
  | {readonly kind: 'absent'}
  | {readonly kind: 'stale_watermark'}
  | {
      readonly kind: 'lines';
      readonly lines: readonly string[];
      readonly consumedBytes: number;
    };

const noNewLines: CommittedTranscriptTail = Object.freeze({
  kind: 'lines',
  lines: Object.freeze([]),
  consumedBytes: 0,
});

export function readCommittedTranscriptTail(
  filePath: string,
  fromOffset: number,
  maxBytes?: number,
): CommittedTranscriptTail {
  let fileDescriptor: number;

  try {
    fileDescriptor = openFileSync(filePath, 'r');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {kind: 'absent'};
    }

    throw transcriptReadFailed(filePath, error);
  }

  try {
    const size = Number(statFileSync(fileDescriptor).size);

    if (size < fromOffset) {
      return {kind: 'stale_watermark'};
    }

    if (size === fromOffset) {
      return noNewLines;
    }

    // A capped slice can end before any newline (one record larger than
    // the cap); its bytes stay unconsumed for an uncapped pass.
    const readLength =
      maxBytes === undefined
        ? size - fromOffset
        : Math.min(size - fromOffset, maxBytes);
    const tail = Buffer.alloc(readLength);
    const bytesRead = readBytesFromFileSync(
      fileDescriptor,
      tail,
      0,
      tail.length,
      fromOffset,
    );
    // A newline byte never occurs inside a UTF-8 sequence, so a byte slice
    // ending at one is a valid string boundary; text after the final
    // newline is an unfinished append and stays unconsumed.
    const lastNewline = tail.subarray(0, bytesRead).lastIndexOf(0x0a);

    if (lastNewline === -1) {
      return noNewLines;
    }

    const consumedBytes = lastNewline + 1;
    const lines = tail
      .subarray(0, consumedBytes)
      .toString('utf8')
      .split('\n')
      .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));

    lines.pop();
    return {kind: 'lines', lines: Object.freeze(lines), consumedBytes};
  } catch (error: unknown) {
    throw transcriptReadFailed(filePath, error);
  } finally {
    closeFileSync(fileDescriptor);
  }
}

function sessionHistoryBatch(
  sessionId: string,
  fromOffset: number,
  tail: CommittedTranscriptTail,
  reset: boolean,
): SessionHistoryMessageBatch {
  if (tail.kind !== 'lines') {
    return emptySessionHistoryBatch(reset);
  }

  const committed = committedMessagesFromTail(tail);
  const messages: RuntimePluginSessionHistoryMessage[] = committed.messages.map(
    record =>
      Object.freeze({
        sessionId,
        messageId: record.id,
        role: record.role,
        speakerName: record.speakerName,
        text: record.text,
        committedAt: record.committedAt,
      }),
  );

  return Object.freeze({
    messages: Object.freeze(messages),
    nextCursor: encodeSessionHistoryCursor(fromOffset + tail.consumedBytes),
    damagedRecordCount: committed.damagedRecordCount,
    reset,
  });
}

function committedMessagesFromTail(
  tail: CommittedTranscriptTail,
): CommittedConversationMessages {
  if (tail.kind !== 'lines') {
    return Object.freeze({messages: Object.freeze([]), damagedRecordCount: 0});
  }

  const messages: ConversationLogRecord[] = [];
  let damagedRecordCount = 0;

  for (const line of tail.lines) {
    let record: ConversationLogRecord | undefined;

    try {
      record = conversationMessageForRawEvent(decodeRawEventLogRecord(line));
    } catch {
      damagedRecordCount += 1;
      continue;
    }

    if (record !== undefined) {
      messages.push(record);
    }
  }

  return Object.freeze({messages: Object.freeze(messages), damagedRecordCount});
}

function emptySessionHistoryBatch(reset: boolean): SessionHistoryMessageBatch {
  return Object.freeze({
    messages: Object.freeze([]),
    nextCursor: encodeSessionHistoryCursor(0),
    damagedRecordCount: 0,
    reset,
  });
}

function encodeSessionHistoryCursor(byteOffset: number): string {
  return `v1:${String(byteOffset)}`;
}

/** Absent means start from the top; unreadable means reset. */
function decodeSessionHistoryCursor(
  cursor: string | undefined,
): number | undefined {
  if (cursor === undefined) {
    return 0;
  }

  const match = sessionHistoryCursorPattern.exec(cursor);

  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function transcriptReadFailed(
  filePath: string,
  cause: unknown,
): LocalRuntimeStorageContractError {
  return new LocalRuntimeStorageContractError(
    'read_failed',
    `Could not read local runtime transcript: ${filePath}.`,
    {cause},
  );
}
