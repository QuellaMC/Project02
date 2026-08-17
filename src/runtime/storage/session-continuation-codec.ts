import type {RuntimeEventIdentity} from '../../core/index.ts';
import type {
  ConversationToolCall,
  ConversationToolRound,
  ConversationTurn,
} from '../../role-model/index.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
} from '../../shared/json-boundary.ts';
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
  requiredVisibleMessage,
  throwMalformedRecord,
} from './codec-primitives.ts';
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

function requiredConversationTurn(value: unknown): ConversationTurn {
  if (!isRecord(value)) {
    throwMalformedRecord('carriedTurns');
  }

  return Object.freeze({
    ...requiredRuntimeEventIdentity(value),
    userMessage: requiredVisibleMessage(value['userMessage'], 'userMessage'),
    toolRounds: Object.freeze(
      requiredArray(value['toolRounds'], 'toolRounds').map(
        requiredConversationToolRound,
      ),
    ),
    finalReplies: Object.freeze(
      requiredArray(value['finalReplies'], 'finalReplies').map(reply =>
        requiredVisibleMessage(reply, 'finalReplies'),
      ),
    ),
  } satisfies ConversationTurn);
}

function requiredConversationToolRound(value: unknown): ConversationToolRound {
  if (!isRecord(value) || typeof value['round'] !== 'number') {
    throwMalformedRecord('toolRounds');
  }

  return Object.freeze({
    round: value['round'],
    interimReplies: Object.freeze(
      requiredArray(value['interimReplies'], 'interimReplies').map(reply =>
        requiredVisibleMessage(reply, 'interimReplies'),
      ),
    ),
    toolCalls: Object.freeze(
      requiredArray(value['toolCalls'], 'toolCalls').map(
        requiredConversationToolCall,
      ),
    ),
  } satisfies ConversationToolRound);
}

function requiredConversationToolCall(value: unknown): ConversationToolCall {
  if (!isRecord(value) || !isRecord(value['result'])) {
    throwMalformedRecord('toolCalls');
  }

  const result = value['result'];
  const status = result['status'];

  return Object.freeze({
    toolCallId: requiredRecordString(value, 'toolCallId', 'malformed_record'),
    pluginId: requiredRecordString(value, 'pluginId', 'malformed_record'),
    toolName: requiredRecordString(value, 'toolName', 'malformed_record'),
    input: createJsonBoundaryObjectSnapshot(value['input'], {
      field: 'Carried tool call input',
    }),
    result:
      status === 'accepted'
        ? Object.freeze({
            status,
            output: createJsonBoundarySnapshot(result['output'], {
              field: 'Carried tool call output',
            }),
          })
        : status === 'rejected'
          ? Object.freeze({
              status,
              reason: requiredRecordString(
                result,
                'reason',
                'malformed_record',
              ),
              message: requiredRecordString(
                result,
                'message',
                'malformed_record',
              ),
            })
          : throwMalformedRecord('toolCalls.result'),
  } satisfies ConversationToolCall);
}
