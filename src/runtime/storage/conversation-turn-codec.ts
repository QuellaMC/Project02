import {
  createConversationToolRound,
  type ConversationToolCall,
  type ConversationToolRound,
  type ConversationTurn,
} from '../../role-model/index.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
} from '../../shared/json-boundary.ts';
import {
  optionalRecordString,
  requiredArray,
  requiredRuntimeEventIdentity,
  requiredVisibleMessage,
  throwMalformedRecord,
} from './codec-primitives.ts';
import {isRecord, requiredRecordString} from './layout-contract.ts';

/** Stored turns and this turn's stored rounds decode through the one round freezer. */
export function requiredConversationTurn(value: unknown): ConversationTurn {
  if (!isRecord(value)) {
    throwMalformedRecord('carriedTurns');
  }

  return Object.freeze({
    ...requiredRuntimeEventIdentity(value),
    userMessage: requiredVisibleMessage(value['userMessage'], 'userMessage'),
    toolRounds: requiredConversationToolRounds(value['toolRounds']),
    finalReplies: Object.freeze(
      requiredArray(value['finalReplies'], 'finalReplies').map(reply =>
        requiredVisibleMessage(reply, 'finalReplies'),
      ),
    ),
  } satisfies ConversationTurn);
}

export function requiredConversationToolRounds(
  value: unknown,
): readonly ConversationToolRound[] {
  return Object.freeze(
    requiredArray(value, 'toolRounds').map(requiredConversationToolRound),
  );
}

function requiredConversationToolRound(value: unknown): ConversationToolRound {
  if (!isRecord(value) || typeof value['round'] !== 'number') {
    throwMalformedRecord('toolRounds');
  }

  const text = optionalRecordString(value, 'text', 'malformed_record');

  try {
    return createConversationToolRound({
      round: value['round'],
      ...(text === undefined ? {} : {text}),
      interimReplies: requiredArray(
        value['interimReplies'],
        'interimReplies',
      ).map(reply => requiredVisibleMessage(reply, 'interimReplies')),
      toolCalls: requiredArray(value['toolCalls'], 'toolCalls').map(
        requiredConversationToolCall,
      ),
    });
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('toolRounds');
    }

    throw error;
  }
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
      field: 'Conversation tool call input',
    }),
    result:
      status === 'accepted'
        ? Object.freeze({
            status,
            output: createJsonBoundarySnapshot(result['output'], {
              field: 'Conversation tool call output',
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
