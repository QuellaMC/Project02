import {
  CharacterInputError,
  CharacterReplyValidationError,
  createDeterministicCharacterAgent,
  runCharacterTurn,
  type CharacterAgent,
  type CharacterTurnOptions,
  type CharacterTurnResult,
  type ConversationSession
} from './conversation.ts';
import type { RuntimeEventIdentity, UserMessageRuntimeEvent } from './runtime-event.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RuntimeLogStore,
  RuntimeTraceEntry,
  RuntimeTraceStepName
} from './runtime-log.ts';

export type LocalRuntimeUserMessageRejectionReason =
  | 'input_validation_rejected'
  | 'character_reply_rejected';

export type RunLocalUserMessageEventOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly agent?: CharacterAgent;
  readonly characterTurnOptions?: CharacterTurnOptions;
  readonly committedAt?: string;
};

export type LocalRuntimeUserMessageCompletedResult = {
  readonly status: 'completed';
  readonly event: UserMessageRuntimeEvent;
  readonly turn: CharacterTurnResult;
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvent: RawEventLogRecord;
  readonly traceEntries: readonly RuntimeTraceEntry[];
};

export type LocalRuntimeUserMessageRejectedResult = {
  readonly status: 'rejected';
  readonly event: UserMessageRuntimeEvent;
  readonly reason: LocalRuntimeUserMessageRejectionReason;
  readonly message: string;
  readonly rawEvent: RawEventLogRecord;
  readonly traceEntries: readonly RuntimeTraceEntry[];
};

export type LocalRuntimeUserMessageInputRejectedResult = {
  readonly status: 'rejected';
  readonly identity: RuntimeEventIdentity;
  readonly eventType: 'USER_MESSAGE';
  readonly reason: 'input_validation_rejected';
  readonly message: string;
  readonly rawEvent: RawEventLogRecord;
  readonly traceEntries: readonly RuntimeTraceEntry[];
};

export type LocalRuntimeUserMessageResult =
  | LocalRuntimeUserMessageCompletedResult
  | LocalRuntimeUserMessageRejectedResult;

export type RecordLocalUserMessageInputRejectionOptions = {
  readonly identity: RuntimeEventIdentity;
  readonly logStore: RuntimeLogStore;
  readonly message: string;
};

export function recordLocalUserMessageInputRejection(
  options: RecordLocalUserMessageInputRejectionOptions
): LocalRuntimeUserMessageInputRejectedResult {
  const traceEntries: RuntimeTraceEntry[] = [];

  function appendTrace(step: RuntimeTraceStepName): RuntimeTraceEntry {
    const traceEntry = options.logStore.appendTrace({
      ...options.identity,
      step
    });

    traceEntries.push(traceEntry);
    return traceEntry;
  }

  appendTrace('runtime_event_received');
  options.logStore.appendRawEvent({
    ...options.identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE'
  });
  appendTrace('input_validation_rejected');
  options.logStore.appendRawEvent({
    ...options.identity,
    kind: 'input_validation_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message
  });

  const rawEvent = options.logStore.appendRawEvent({
    ...options.identity,
    kind: 'runtime_turn_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message
  });

  appendTrace('raw_event_log_appended');
  appendTrace('runtime_turn_rejected');

  return Object.freeze({
    status: 'rejected',
    identity: options.identity,
    eventType: 'USER_MESSAGE',
    reason: 'input_validation_rejected',
    message: options.message,
    rawEvent,
    traceEntries: Object.freeze([...traceEntries])
  } satisfies LocalRuntimeUserMessageInputRejectedResult);
}

export async function runLocalUserMessageEvent(
  options: RunLocalUserMessageEventOptions
): Promise<LocalRuntimeUserMessageResult> {
  const traceEntries: RuntimeTraceEntry[] = [];
  const identity = {
    eventId: options.event.eventId,
    traceId: options.event.traceId,
    createdAt: options.event.createdAt
  };

  function appendTrace(step: RuntimeTraceStepName): RuntimeTraceEntry {
    const traceEntry = options.logStore.appendTrace({
      ...identity,
      step
    });

    traceEntries.push(traceEntry);
    return traceEntry;
  }

  function appendRejectedResult(
    reason: LocalRuntimeUserMessageRejectionReason,
    message: string
  ): LocalRuntimeUserMessageRejectedResult {
    appendTrace(reason);
    options.logStore.appendRawEvent({
      ...identity,
      kind: reason,
      eventType: options.event.type,
      status: 'rejected',
      reason: message
    });

    const rawEvent = options.logStore.appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: options.event.type,
      status: 'rejected',
      reason: message
    });

    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_rejected');

    return Object.freeze({
      status: 'rejected',
      event: options.event,
      reason,
      message,
      rawEvent,
      traceEntries: Object.freeze([...traceEntries])
    } satisfies LocalRuntimeUserMessageRejectedResult);
  }

  appendTrace('runtime_event_received');
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: options.event.type
  });
  appendTrace('runtime_event_normalized');
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_normalized',
    eventType: options.event.type
  });
  appendTrace('runtime_turn_started');

  try {
    const turn = await runCharacterTurn(
      options.session,
      options.event.payload.currentUserMessage,
      options.agent ?? createDeterministicCharacterAgent(),
      options.characterTurnOptions
    );
    const committedAt = options.committedAt ?? options.event.createdAt;
    const conversationMessages = Object.freeze([
      options.logStore.appendConversationMessage({
        ...turn.userMessage,
        ...identity,
        committedAt
      }),
      options.logStore.appendConversationMessage({
        ...turn.characterMessage,
        ...identity,
        committedAt
      })
    ]);

    appendTrace('visible_reply_committed');
    options.logStore.appendRawEvent({
      ...identity,
      kind: 'visible_reply_committed',
      eventType: options.event.type,
      visibleMessageIds: conversationMessages.map((message) => message.id)
    });

    const rawEvent = options.logStore.appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: options.event.type,
      status: 'completed',
      visibleMessageIds: conversationMessages.map((message) => message.id)
    });

    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_completed');

    return Object.freeze({
      status: 'completed',
      event: options.event,
      turn,
      conversationMessages,
      rawEvent,
      traceEntries: Object.freeze([...traceEntries])
    } satisfies LocalRuntimeUserMessageCompletedResult);
  } catch (error: unknown) {
    if (error instanceof CharacterInputError) {
      return appendRejectedResult('input_validation_rejected', error.message);
    }

    if (error instanceof CharacterReplyValidationError) {
      return appendRejectedResult('character_reply_rejected', error.message);
    }

    throw error;
  }
}
