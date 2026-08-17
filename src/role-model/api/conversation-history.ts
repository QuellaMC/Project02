import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
} from '../../shared/json-boundary.ts';
import type {VisibleMessage} from '../../core/index.ts';
import type {
  ConversationHistoryWindow,
  ConversationToolCall,
  ConversationToolCallResult,
  ConversationToolRound,
  ConversationTurn,
} from './contracts.ts';
import {requiredRoleModelIdentifier} from './tool-names.ts';

export type {
  ConversationHistoryWindow,
  ConversationToolCall,
  ConversationToolCallResult,
  ConversationToolRound,
  ConversationTurn,
} from './contracts.ts';

/** The one freezer for a tool round: the loop, the envelope, and the codec all pass through it. */
export function createConversationToolRound(
  round: ConversationToolRound,
): ConversationToolRound {
  if (!Number.isSafeInteger(round.round) || round.round < 1) {
    throw new TypeError('Conversation tool round must be a positive integer.');
  }

  return Object.freeze({
    round: round.round,
    ...(round.text === undefined ? {} : {text: round.text}),
    interimReplies: Object.freeze(
      round.interimReplies.map(freezeVisibleMessage),
    ),
    toolCalls: Object.freeze(round.toolCalls.map(freezeConversationToolCall)),
  } satisfies ConversationToolRound);
}

function freezeConversationToolCall(
  call: ConversationToolCall,
): ConversationToolCall {
  if (typeof call.toolCallId !== 'string' || call.toolCallId.length === 0) {
    throw new TypeError('Conversation tool call must carry its call id.');
  }

  return Object.freeze({
    toolCallId: call.toolCallId,
    pluginId: requiredRoleModelIdentifier(call.pluginId, 'tool call pluginId'),
    toolName: requiredRoleModelIdentifier(call.toolName, 'tool call toolName'),
    input: createJsonBoundaryObjectSnapshot(call.input, {
      field: 'Conversation tool call input',
      redact: true,
    }),
    result: freezeConversationToolCallResult(call.result),
  } satisfies ConversationToolCall);
}

function freezeConversationToolCallResult(
  result: ConversationToolCallResult,
): ConversationToolCallResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: createJsonBoundarySnapshot(result.output, {
        field: 'Conversation tool call output',
        redact: true,
      }),
    } satisfies ConversationToolCallResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message,
  } satisfies ConversationToolCallResult);
}

function freezeVisibleMessage(message: VisibleMessage): VisibleMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    speakerId: message.speakerId,
    speakerName: message.speakerName,
    text: message.text,
  } satisfies VisibleMessage);
}

export function conversationTurnVisibleMessages(
  turn: ConversationTurn,
): readonly VisibleMessage[] {
  return Object.freeze([
    turn.userMessage,
    ...turn.toolRounds.flatMap(round => round.interimReplies),
    ...turn.finalReplies,
  ]);
}

export function conversationHistoryWindow(
  turns: readonly ConversationTurn[],
): ConversationHistoryWindow {
  return Object.freeze({
    turnEventIds: Object.freeze(turns.map(turn => turn.eventId)),
  });
}

/**
 * On the loop, not the renderer: the persisted window must name exactly the
 * turns the model was shown, or the record misstates the model's input.
 */
export function assertConversationHistoryMatchesWindow(
  turns: readonly ConversationTurn[],
  window: ConversationHistoryWindow,
): void {
  const replayed = turns.map(turn => turn.eventId);

  if (
    replayed.length !== window.turnEventIds.length ||
    replayed.some((eventId, index) => eventId !== window.turnEventIds[index])
  ) {
    throw new TypeError(
      'Conversation history must match the decision-context history window.',
    );
  }
}
