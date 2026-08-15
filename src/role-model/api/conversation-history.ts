import type {RuntimeEventIdentity, VisibleMessage} from '../../core/index.ts';
import type {RuntimePluginJsonObject} from '../../plugins/api/index.ts';
import type {RoleModelToolObservationResult} from './contracts.ts';

/** One completed tool call of a prior turn: what the model asked and what came back. */
export type ConversationToolCall = {
  readonly toolCallId: string;
  readonly pluginId: string;
  readonly toolName: string;
  readonly input: RuntimePluginJsonObject;
  readonly result: RoleModelToolObservationResult;
};

/** One executable decision round of a prior turn. */
export type ConversationToolRound = {
  readonly round: number;
  /** visible_reply texts the model committed in this round, commit order. */
  readonly interimReplies: readonly VisibleMessage[];
  readonly toolCalls: readonly ConversationToolCall[];
};

/**
 * A completed turn as the model replays it: the person's message, every tool
 * round with its results, then the character's final replies. Turn identity
 * is the runtime event that opened it.
 */
export type ConversationTurn = RuntimeEventIdentity & {
  readonly userMessage: VisibleMessage;
  readonly toolRounds: readonly ConversationToolRound[];
  readonly finalReplies: readonly VisibleMessage[];
};

/**
 * What a model turn persists about its history: which turns were replayed,
 * oldest first. The turns themselves are already durable in the session log.
 */
export type ConversationHistoryWindow = {
  readonly turnEventIds: readonly string[];
};

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
