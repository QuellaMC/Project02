import type {RuntimeEventIdentity} from '../../core/index.ts';
import {
  createSessionContinuationSnapshot,
  type ContextSummarizer,
  type RawEventLogRecordKind,
  type SessionContinuationSnapshot,
} from '../evidence/records.ts';
import {
  optionalRecordString,
  requiredArray,
  requiredRuntimeEventIdentity,
  throwMalformedRecord,
} from './codec-primitives.ts';
import {requiredConversationTurn} from './conversation-turn-codec.ts';
import {isRecord, requiredRecordString} from './layout-contract.ts';

export function optionalSessionContinuationOption(value: unknown): {
  readonly sessionContinuation?: SessionContinuationSnapshot;
} {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throwMalformedRecord('sessionContinuation');
  }

  const continuedFrom = value['continuedFrom'];

  if (!isRecord(continuedFrom)) {
    throwMalformedRecord('sessionContinuation.continuedFrom');
  }

  const summarizedTurnCount = value['summarizedTurnCount'];

  if (typeof summarizedTurnCount !== 'number') {
    throwMalformedRecord('sessionContinuation.summarizedTurnCount');
  }

  try {
    return {
      sessionContinuation: createSessionContinuationSnapshot({
        ...requiredRuntimeEventIdentity(value),
        sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
        continuedFrom: {
          sessionId: requiredRecordString(
            continuedFrom,
            'sessionId',
            'malformed_record',
          ),
          lastEventId: requiredRecordString(
            continuedFrom,
            'lastEventId',
            'malformed_record',
          ),
        },
        summary: requiredRecordString(value, 'summary', 'malformed_record'),
        summarizedTurnCount,
        carriedTurns: requiredArray(value['carriedTurns'], 'carriedTurns').map(
          requiredConversationTurn,
        ),
        summarizer: requiredContextSummarizer(value['summarizer']),
      }),
    };
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('sessionContinuation');
    }

    throw error;
  }
}

/** The kind and the field name each other, and the snapshot is the record's own. */
export function assertSessionContinuationRawEventSemantics(options: {
  readonly identity: RuntimeEventIdentity;
  readonly kind: RawEventLogRecordKind;
  readonly sessionContinuation?: SessionContinuationSnapshot;
}): void {
  if (
    (options.kind === 'session_continued') !==
    (options.sessionContinuation !== undefined)
  ) {
    throwMalformedRecord('sessionContinuation');
  }

  if (
    options.sessionContinuation !== undefined &&
    (options.sessionContinuation.eventId !== options.identity.eventId ||
      options.sessionContinuation.traceId !== options.identity.traceId ||
      options.sessionContinuation.createdAt !== options.identity.createdAt)
  ) {
    throwMalformedRecord('sessionContinuation');
  }
}

function requiredContextSummarizer(value: unknown): ContextSummarizer {
  if (!isRecord(value)) {
    throwMalformedRecord('sessionContinuation.summarizer');
  }

  const status = value['status'];

  if (status === 'fallback') {
    return {
      status,
      reason: requiredRecordString(value, 'reason', 'malformed_record'),
    };
  }

  if (status !== 'model' || !isRecord(value['provider'])) {
    throwMalformedRecord('sessionContinuation.summarizer');
  }

  const provider = value['provider'];
  const model = optionalRecordString(provider, 'model', 'malformed_record');

  return {
    status,
    provider: {
      name: requiredRecordString(provider, 'name', 'malformed_record'),
      ...(model === undefined ? {} : {model}),
    },
  };
}
