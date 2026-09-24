import {
  characterDataDirPath,
  listConversationSegments,
  LocalRuntimeStorageContractError,
  readCommittedConversationMessages,
} from '../runtime/storage/index.ts';
import type {
  HistoryMessage,
  HistoryOutcome,
  HistoryPage,
} from './api/contract.ts';
import {characterOfConversation} from './conversations.ts';

type CommittedMessage = ReturnType<
  typeof readCommittedConversationMessages
>[number];

/** A boundary inside one segment: `index` messages of it lie before it. */
type Position = {
  readonly segment: number;
  readonly index: number;
};

type ParsedPage = {
  readonly limit: number;
  readonly before?: Position;
};

type Segment = {
  readonly sessionId: string;
  readonly segment: number;
};

const defaultLimit = 100;
const maxLimit = 500;
const cursorPattern = /^v1:([0-9]{1,9}):([0-9]{1,9})$/u;
const invalidPageMessage =
  'A history page takes a limit from 1 to 500 and, to read further back, ' +
  'the cursor the previous page returned.';

/**
 * The one reading of a page request, whether it came from code or from a
 * query string: a decimal limit within bounds, and a cursor this module
 * itself handed out.
 */
export function parseHistoryPage(
  page: HistoryPage | undefined,
): ParsedPage | undefined {
  const limit =
    page?.limit === undefined ? defaultLimit : parseLimit(page.limit);

  if (limit === undefined) {
    return undefined;
  }

  if (page?.before === undefined) {
    return {limit};
  }

  const match = cursorPattern.exec(page.before);

  if (match === null) {
    return undefined;
  }

  return {
    limit,
    before: {segment: Number(match[1]), index: Number(match[2])},
  };
}

function parseLimit(value: string | number): number | undefined {
  const text = typeof value === 'number' ? String(value) : value;

  if (!/^[0-9]{1,3}$/u.test(text)) {
    return undefined;
  }

  const limit = Number(text);

  return limit >= 1 && limit <= maxLimit ? limit : undefined;
}

/**
 * One conversation as one scrollback. The character's record of it is a
 * chain of segments; a page is filled backward across them until the limit
 * or the first message, and the cursor names where the next page ends.
 */
export async function readConversationHistory(options: {
  readonly homeRoot: string;
  readonly conversationId: string;
  readonly page?: HistoryPage;
}): Promise<HistoryOutcome> {
  const page = parseHistoryPage(options.page);

  if (page === undefined) {
    return refused('invalid_page', invalidPageMessage);
  }

  const conversation = await characterOfConversation(options);

  if (conversation.status === 'unknown') {
    return refused('unknown_conversation', conversation.message);
  }

  if (conversation.status === 'failed') {
    return storageFailure(conversation.error);
  }

  try {
    return assemblePage({
      storeRoot: characterDataDirPath(
        options.homeRoot,
        conversation.characterId,
      ),
      characterId: conversation.characterId,
      conversationId: conversation.conversationId,
      page,
    });
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      return storageFailure(error);
    }

    throw error;
  }
}

function assemblePage(options: {
  readonly storeRoot: string;
  readonly characterId: string;
  readonly conversationId: string;
  readonly page: ParsedPage;
}): HistoryOutcome {
  const {segments} = listConversationSegments(options);
  const messagesOf = createSegmentReader(options, segments);
  const start = startPosition(options.page, segments, messagesOf);

  if (start === undefined) {
    return refused('invalid_page', invalidPageMessage);
  }

  const collected: CommittedMessage[] = [];
  let {index, end} = start;

  while (collected.length < options.page.limit && index >= 0) {
    const take = Math.min(options.page.limit - collected.length, end);

    if (take > 0) {
      collected.unshift(...messagesOf(index).slice(end - take, end));
      end -= take;
    }

    if (end === 0) {
      index -= 1;
      end = index >= 0 ? messagesOf(index).length : 0;
    }
  }

  // Older segments with nothing in them are not a place to point at.
  while (index >= 0 && end === 0) {
    index -= 1;
    end = index >= 0 ? messagesOf(index).length : 0;
  }

  const earlier = segments[index];

  return Object.freeze({
    status: 'ok' as const,
    conversationId: options.conversationId,
    characterId: options.characterId,
    messages: Object.freeze(collected.map(toHistoryMessage)),
    ...(earlier === undefined ? {} : {earlier: cursor(earlier.segment, end)}),
  });
}

/** Where the page ends: the newest message, or the cursor's boundary. */
function startPosition(
  page: ParsedPage,
  segments: readonly Segment[],
  messagesOf: (index: number) => readonly CommittedMessage[],
): {readonly index: number; readonly end: number} | undefined {
  if (page.before === undefined) {
    const index = segments.length - 1;

    return {index, end: index >= 0 ? messagesOf(index).length : 0};
  }

  const index = segments.findIndex(
    candidate => candidate.segment === page.before?.segment,
  );

  if (index === -1 || page.before.index > messagesOf(index).length) {
    return undefined;
  }

  return {index, end: page.before.index};
}

/** Each segment is read at most once per page; a damaged one fails the page. */
function createSegmentReader(
  options: {readonly storeRoot: string; readonly characterId: string},
  segments: readonly Segment[],
): (index: number) => readonly CommittedMessage[] {
  const read = new Map<number, readonly CommittedMessage[]>();

  return index => {
    const cached = read.get(index);

    if (cached !== undefined) {
      return cached;
    }

    const segment = segments[index];

    if (segment === undefined) {
      return [];
    }

    const messages = readCommittedConversationMessages({
      ...options,
      sessionId: segment.sessionId,
      // Only the newest segment may still be waiting for its first record.
      onMissing: index === segments.length - 1 ? 'allow' : 'reject',
    });

    read.set(index, messages);

    return messages;
  };
}

function cursor(segment: number, index: number): string {
  return `v1:${String(segment)}:${String(index)}`;
}

function toHistoryMessage(record: CommittedMessage): HistoryMessage {
  return Object.freeze({
    messageId: record.id,
    role: record.role,
    speakerId: record.speakerId,
    speakerName: record.speakerName,
    text: record.text,
    committedAt: record.committedAt,
    ...(record.source === undefined ? {} : {source: record.source}),
    ...(record.clientMessageId === undefined
      ? {}
      : {clientMessageId: record.clientMessageId}),
  });
}

function refused(
  reason: Extract<HistoryOutcome, {status: 'refused'}>['reason'],
  message: string,
): HistoryOutcome {
  return Object.freeze({status: 'refused' as const, reason, message});
}

function storageFailure(
  error: LocalRuntimeStorageContractError,
): HistoryOutcome {
  return Object.freeze({
    status: 'failed' as const,
    code: error.code,
    message: error.message,
  });
}
