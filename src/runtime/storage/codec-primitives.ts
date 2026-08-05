import {
  createRuntimeEventIdentitySnapshot,
  normalizeVisibleMessageText,
  type RuntimeEventIdentity,
  type VisibleMessage,
  type VisibleMessageRole,
  visibleMessageRoleValues,
  VisibleMessageTextValidationError,
} from '../../core/index.ts';
import {
  isRecord,
  LocalRuntimeStorageContractError,
  requiredRecordCanonicalTimestamp,
  requiredRecordString,
} from './layout-contract.ts';

export function requiredRuntimeEventIdentity(
  record: Record<string, unknown>,
): RuntimeEventIdentity {
  try {
    return createRuntimeEventIdentitySnapshot({
      eventId: requiredRecordString(record, 'eventId', 'malformed_record'),
      traceId: requiredRecordString(record, 'traceId', 'malformed_record'),
      createdAt: requiredRecordCanonicalTimestamp(
        record,
        'createdAt',
        'malformed_record',
      ),
    });
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      throw error;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Stored local runtime event identity is malformed.',
      {cause: error},
    );
  }
}

export function requiredNormalizedVisibleMessageText(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = requiredRecordString(record, key, 'malformed_record');
  let normalizedValue: string;

  try {
    normalizedValue = normalizeVisibleMessageText(value);
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      throwMalformedRecord(key);
    }

    throw error;
  }

  if (normalizedValue !== value) {
    throwMalformedRecord(key);
  }

  return value;
}

/** The one decoder for a stored visible message, wherever it appears. */
export function requiredVisibleMessage(
  value: unknown,
  field: string,
): VisibleMessage {
  if (!isRecord(value)) {
    throwMalformedRecord(field);
  }

  return Object.freeze({
    id: requiredRecordString(value, 'id', 'malformed_record'),
    role: requiredVisibleMessageRole(value['role']),
    speakerId: requiredRecordString(value, 'speakerId', 'malformed_record'),
    speakerName: requiredRecordString(value, 'speakerName', 'malformed_record'),
    text: requiredNormalizedVisibleMessageText(value, 'text'),
  } satisfies VisibleMessage);
}

/**
 * A commit event's message, its turn's commit time, and the sampling
 * round that asked for it. They are one fact, so they are decoded
 * together and none appears without the kind that carries them.
 *
 * `committedAt` names the turn, not the instant: every message a turn
 * commits carries the same stamp, so it orders turns and never messages
 * within one. The round is absent on a user message, which no round
 * asked for.
 */
export function optionalCommittedMessage(record: Record<string, unknown>): {
  readonly visibleMessage?: VisibleMessage;
  readonly committedAt?: string;
  readonly decisionRound?: number;
} {
  const value = record['visibleMessage'];
  const commitsAMessage = record['kind'] === 'visible_message_committed';

  if (value === undefined) {
    // A commit event with no message is the silent-loss shape the merged
    // log exists to remove: it decodes, then drops its row on the way to
    // the transcript. Name it here instead.
    if (commitsAMessage || record['committedAt'] !== undefined) {
      throwMalformedRecord('visibleMessage');
    }

    return {};
  }

  if (!commitsAMessage) {
    throwMalformedRecord('visibleMessage');
  }

  const decisionRound = record['decisionRound'];

  return Object.freeze({
    committedAt: requiredRecordCanonicalTimestamp(
      record,
      'committedAt',
      'malformed_record',
    ),
    visibleMessage: requiredVisibleMessage(value, 'visibleMessage'),
    ...(decisionRound === undefined
      ? {}
      : {decisionRound: requiredCommittedDecisionRound(decisionRound)}),
  });
}

function requiredCommittedDecisionRound(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throwMalformedRecord('decisionRound');
  }

  return value;
}

export function requiredVisibleMessageRole(value: unknown): VisibleMessageRole {
  if (isOneOf(value, visibleMessageRoleValues)) {
    return value;
  }

  throwMalformedRecord('role');
}

export function isOneOf<const T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

export function throwMalformedRecord(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    `Stored local runtime field "${field}" is malformed.`,
  );
}
