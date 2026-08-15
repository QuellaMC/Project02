import {
  runtimeEventIdentityKey,
  type RuntimeEventIdentity,
  type VisibleMessage,
} from '../../core/index.ts';
import type {
  ConversationToolCall,
  ConversationToolRound,
  ConversationTurn,
} from '../../role-model/index.ts';
import type {RuntimePluginToolCallResult} from '../../plugins/api/index.ts';
import type {RawEventLogRecord} from './records.ts';

type MutableTurn = {
  readonly identity: RuntimeEventIdentity;
  userMessage: VisibleMessage | undefined;
  readonly characterMessages: {
    readonly message: VisibleMessage;
    readonly round: number | undefined;
  }[];
  readonly startedCalls: {
    readonly toolCallId: string;
    readonly round: number;
    readonly pluginId: string;
    readonly toolName: string;
    readonly input: ConversationToolCall['input'];
  }[];
  readonly resultsByCallId: Map<string, RuntimePluginToolCallResult>;
};

/**
 * The one projection of the session log into the turns a model replays. Live
 * turns and reopened sessions both run it over the same decoded records, so
 * what the model sees never depends on how the session was reached.
 *
 * A group of records is a conversation turn only once it committed the
 * person's message; a tool round only exists once at least one call it
 * started also finished, so an unanswered call is unrepresentable rather
 * than guarded against on the wire.
 */
export function conversationTurnsFromRawEvents(
  rawEvents: readonly RawEventLogRecord[],
): readonly ConversationTurn[] {
  const turns = new Map<string, MutableTurn>();

  for (const record of rawEvents) {
    const key = runtimeEventIdentityKey(record);
    let turn = turns.get(key);

    if (turn === undefined) {
      turn = {
        identity: Object.freeze({
          eventId: record.eventId,
          traceId: record.traceId,
          createdAt: record.createdAt,
        }),
        userMessage: undefined,
        characterMessages: [],
        startedCalls: [],
        resultsByCallId: new Map(),
      };
      turns.set(key, turn);
    }

    if (record.kind === 'visible_message_committed') {
      if (record.visibleMessage?.role === 'user') {
        turn.userMessage ??= record.visibleMessage;
      } else if (record.visibleMessage !== undefined) {
        turn.characterMessages.push({
          message: record.visibleMessage,
          round: record.decisionRound,
        });
      }
    } else if (
      record.kind === 'tool_call_started' &&
      record.toolCallId !== undefined &&
      record.toolRound !== undefined &&
      record.toolPluginId !== undefined &&
      record.toolName !== undefined &&
      record.toolInput !== undefined
    ) {
      turn.startedCalls.push({
        toolCallId: record.toolCallId,
        round: record.toolRound,
        pluginId: record.toolPluginId,
        toolName: record.toolName,
        input: record.toolInput,
      });
    } else if (
      record.kind === 'tool_call_finished' &&
      record.toolCallId !== undefined &&
      record.toolResult !== undefined
    ) {
      turn.resultsByCallId.set(record.toolCallId, record.toolResult);
    }
  }

  return Object.freeze(
    [...turns.values()].flatMap(turn => {
      const completed = completeConversationTurn(turn);

      return completed === undefined ? [] : [completed];
    }),
  );
}

function completeConversationTurn(
  turn: MutableTurn,
): ConversationTurn | undefined {
  if (turn.userMessage === undefined) {
    return undefined;
  }

  const rounds = new Map<number, ConversationToolCall[]>();

  for (const call of turn.startedCalls) {
    const result = turn.resultsByCallId.get(call.toolCallId);

    if (result === undefined) {
      continue;
    }

    const calls = rounds.get(call.round) ?? [];

    calls.push(
      Object.freeze({
        toolCallId: call.toolCallId,
        pluginId: call.pluginId,
        toolName: call.toolName,
        input: call.input,
        result:
          result.status === 'accepted'
            ? Object.freeze({status: 'accepted', output: result.output})
            : Object.freeze({
                status: 'rejected',
                reason: result.reason,
                message: result.message,
              }),
      } satisfies ConversationToolCall),
    );
    rounds.set(call.round, calls);
  }

  const toolRounds: ConversationToolRound[] = [...rounds.entries()]
    .sort(([left], [right]) => left - right)
    .map(([round, toolCalls]) =>
      Object.freeze({
        round,
        interimReplies: Object.freeze(
          turn.characterMessages
            .filter(entry => entry.round === round)
            .map(entry => entry.message),
        ),
        toolCalls: Object.freeze(toolCalls),
      } satisfies ConversationToolRound),
    );

  return Object.freeze({
    ...turn.identity,
    userMessage: turn.userMessage,
    toolRounds: Object.freeze(toolRounds),
    finalReplies: Object.freeze(
      turn.characterMessages
        .filter(entry => entry.round === undefined || !rounds.has(entry.round))
        .map(entry => entry.message),
    ),
  } satisfies ConversationTurn);
}
