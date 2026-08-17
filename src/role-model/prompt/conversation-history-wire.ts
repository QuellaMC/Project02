import type {
  ConversationToolCall,
  ConversationToolRound,
  ConversationTurn,
} from '../api/conversation-history.ts';
import type {
  RoleModelAssistantChatMessage,
  RoleModelChatMessage,
  RoleModelToolChatMessage,
  RoleModelUserChatMessage,
} from '../api/chat-wire.ts';
import type {RuntimePluginJsonValue} from '../../plugins/api/index.ts';
import {estimateTextTokens} from './token-estimate.ts';

/**
 * History may use half the window: the rest is the stable prefix, the plugin
 * blocks, this turn's tool rounds, and the reply. Compaction (a later change)
 * summarises what falls out; until then older whole turns simply leave.
 */
const conversationHistoryWindowShare = 0.5;

/**
 * A prior turn as the model replays it: the person's message, then each tool
 * round as the assistant call plus its results, then the character's replies
 * as plain assistant text. visible_reply itself is never replayed.
 */
export function conversationTurnToChatMessages(
  turn: ConversationTurn,
): readonly RoleModelChatMessage[] {
  return Object.freeze([
    Object.freeze({
      role: 'user',
      content: turn.userMessage.text,
    } satisfies RoleModelUserChatMessage),
    ...turn.toolRounds.flatMap(toolRoundToChatMessages),
    ...turn.finalReplies.map(reply =>
      Object.freeze({
        role: 'assistant',
        content: reply.text,
      } satisfies RoleModelAssistantChatMessage),
    ),
  ]);
}

/**
 * The one wire for a tool round, this turn's or a prior turn's: the
 * assistant's own text and what it said aloud as content, its executable
 * calls as tool calls, then one result per call. Call ids are the runtime's.
 */
export function toolRoundToChatMessages(
  round: ConversationToolRound,
): readonly RoleModelChatMessage[] {
  const content = [
    ...(round.text === undefined ? [] : [round.text]),
    ...round.interimReplies.map(reply => reply.text),
  ].join('\n\n');

  return Object.freeze([
    Object.freeze({
      role: 'assistant',
      content: content.length === 0 ? null : content,
      tool_calls: Object.freeze(
        round.toolCalls.map(call =>
          Object.freeze({
            id: call.toolCallId,
            type: 'function',
            function: Object.freeze({
              name: call.toolName,
              arguments: JSON.stringify(call.input),
            }),
          }),
        ),
      ),
    } satisfies RoleModelAssistantChatMessage),
    ...round.toolCalls.map(call =>
      Object.freeze({
        role: 'tool',
        tool_call_id: call.toolCallId,
        content: JSON.stringify(toolResultMessageContent(call)),
      } satisfies RoleModelToolChatMessage),
    ),
  ]);
}

function toolResultMessageContent(
  call: ConversationToolCall,
): Readonly<Record<string, RuntimePluginJsonValue>> {
  if (call.result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      pluginId: call.pluginId,
      toolName: call.toolName,
      output: call.result.output,
    });
  }

  return Object.freeze({
    status: 'rejected',
    pluginId: call.pluginId,
    toolName: call.toolName,
    reason: call.result.reason,
    message: call.result.message,
  });
}

export function estimateConversationTurnTokens(turn: ConversationTurn): number {
  return conversationTurnToChatMessages(turn).reduce(
    (total, message) => total + estimateTextTokens(JSON.stringify(message)),
    0,
  );
}

/**
 * The newest whole turns that fit the history share of the context window,
 * oldest first. Turns are never split; the first turn that does not fit ends
 * the window, so what the model sees is always contiguous and recent.
 */
export function selectConversationHistoryWindow(
  turns: readonly ConversationTurn[],
  options: {readonly contextWindowTokens: number},
): readonly ConversationTurn[] {
  if (
    !Number.isSafeInteger(options.contextWindowTokens) ||
    options.contextWindowTokens <= 0
  ) {
    throw new TypeError(
      'contextWindowTokens must be a positive whole number of tokens.',
    );
  }

  const budget = Math.floor(
    options.contextWindowTokens * conversationHistoryWindowShare,
  );
  const selected: ConversationTurn[] = [];
  let used = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];

    if (turn === undefined) {
      continue;
    }

    const cost = estimateConversationTurnTokens(turn);

    if (used + cost > budget) {
      break;
    }

    selected.unshift(turn);
    used += cost;
  }

  return Object.freeze(selected);
}
