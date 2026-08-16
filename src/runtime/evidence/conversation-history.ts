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
import type {
  RawEventLogRecord,
  SessionContinuationSnapshot,
} from './records.ts';

export type ConversationHistory = {
  /** Carried turns from the session this one continues, then its own. */
  readonly turns: readonly ConversationTurn[];
  /** The condensed earlier conversation, when this session continues another. */
  readonly summary?: string;
  readonly continuation?: SessionContinuationSnapshot;
};

/**
 * A session that continues another opens with the earlier conversation's
 * summary and the turns carried over verbatim; the model's history starts
 * there and grows with the session's own turns.
 */
export function conversationHistoryFromRawEvents(
  rawEvents: readonly RawEventLogRecord[],
): ConversationHistory {
  const continuation = rawEvents[0]?.sessionContinuation;
  const ownTurns = conversationTurnsFromRawEvents(rawEvents);

  return continuation === undefined
    ? Object.freeze({turns: ownTurns})
    : Object.freeze({
        turns: Object.freeze([...continuation.carriedTurns, ...ownTurns]),
        summary: continuation.summary,
        continuation,
      });
}

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
  /** What the model wrote beside its calls, per round. */
  readonly textByRound: Map<number, string>;
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
        textByRound: new Map(),
      };
      turns.set(key, turn);
    }

    if (record.kind === 'visible_message_committed') {
      if (record.visibleMessage?.role === 'user') {
        turn.userMessage ??= record.visibleMessage;
      } else if (record.visibleMessage !== undefined) {
        turn.characterMessages.push({
          message: record.visibleMessage,
          round: record.round,
        });
      }
    } else if (record.kind === 'role_model_round') {
      const text = roundTextFromRecord(record);

      if (record.round !== undefined && text !== undefined) {
        turn.textByRound.set(record.round, text);
      }
    } else if (
      record.kind === 'tool_call_started' &&
      record.toolCallId !== undefined &&
      record.round !== undefined &&
      record.toolPluginId !== undefined &&
      record.toolName !== undefined &&
      record.toolInput !== undefined
    ) {
      turn.startedCalls.push({
        toolCallId: record.toolCallId,
        round: record.round,
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
    .map(([round, toolCalls]) => {
      const text = turn.textByRound.get(round);

      return Object.freeze({
        round,
        ...(text === undefined ? {} : {text}),
        interimReplies: Object.freeze(
          turn.characterMessages
            .filter(entry => entry.round === round)
            .map(entry => entry.message),
        ),
        toolCalls: Object.freeze(toolCalls),
      } satisfies ConversationToolRound);
    });

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

function roundTextFromRecord(record: RawEventLogRecord): string | undefined {
  const result = record.parsedRoleModelDecisionSnapshot?.result;

  return result?.status === 'accepted' ? result.decision.text : undefined;
}
