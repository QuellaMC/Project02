import {
  CharacterInputError,
  CharacterReplyValidationError,
  runCharacterTurn,
  type CharacterAgent,
  type CharacterAgentReply,
  type CharacterTurnOptions,
  type CharacterTurnResult,
  type ConversationSession
} from './conversation.ts';
import { buildUserTurnDecisionContext } from './decision-context.ts';
import {
  normalizeOneLineMessage,
  OneLineMessageValidationError
} from './message-validation.ts';
import {
  createRejectedRoleModelDecisionResult,
  roleModelInvalidVisibleReplyRejectionReason,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelIOSnapshot
} from './role-model-contracts.ts';
import {
  createRoleModelAdapterFromCharacterAgent,
  runRoleModelLoop,
  type RoleModelAdapter
} from './role-model-loop.ts';
import type { RuntimeEventIdentity, UserMessageRuntimeEvent } from './runtime-event.ts';
import { createRoleModelCommitValidationSnapshot } from './runtime-log.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RawEventLogPayloadSummary,
  RuntimeLogStore,
  RoleModelCommitValidationSnapshot,
  RuntimeTraceEntry,
  RuntimeTraceStepName
} from './runtime-log.ts';

export type LocalRuntimeUserMessageRejectionReason =
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | RoleModelDecisionRejectionReason;

export type RunLocalUserMessageEventOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly rawInput?: string;
  readonly agent?: CharacterAgent;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly characterTurnOptions?: CharacterTurnOptions;
  readonly committedAt?: string;
};

export type LocalRuntimeUserMessageCompletedResult = {
  readonly status: 'completed';
  readonly event: UserMessageRuntimeEvent;
  readonly turn: CharacterTurnResult;
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvent: RawEventLogRecord;
  readonly rawEventLogRecords: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
};

export type LocalRuntimeUserMessageRejectedResult = {
  readonly status: 'rejected';
  readonly event: UserMessageRuntimeEvent;
  readonly reason: LocalRuntimeUserMessageRejectionReason;
  readonly message: string;
  readonly rawEvent: RawEventLogRecord;
  readonly rawEventLogRecords: readonly RawEventLogRecord[];
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
  readonly rawInput?: string;
};

const unexpectedRuntimeTurnFailureMessage =
  'Runtime turn failed before producing a reply.';
const localRuntimeTurnQueues = new WeakMap<ConversationSession, Promise<void>>();

type RoleModelRawEvidence = {
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
};

export function recordLocalUserMessageInputRejection(
  options: RecordLocalUserMessageInputRejectionOptions
): LocalRuntimeUserMessageInputRejectedResult {
  const identity = freezeRuntimeEventIdentity(options.identity);
  const payloadSummary = createRawInputPayloadSummary(options.rawInput);
  const traceEntries: RuntimeTraceEntry[] = [];

  function appendTrace(step: RuntimeTraceStepName): RuntimeTraceEntry {
    const traceEntry = options.logStore.appendTrace({
      ...identity,
      step
    });

    traceEntries.push(traceEntry);
    return traceEntry;
  }

  appendTrace('runtime_event_received');
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
    ...(payloadSummary === undefined ? {} : { payloadSummary })
  });
  appendTrace('input_validation_rejected');
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'input_validation_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message,
    ...(payloadSummary === undefined ? {} : { payloadSummary })
  });

  const rawEvent = options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_turn_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message,
    ...(payloadSummary === undefined ? {} : { payloadSummary })
  });

  appendTrace('raw_event_log_appended');
  appendTrace('runtime_turn_rejected');

  return Object.freeze({
    status: 'rejected',
    identity,
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
  return await enqueueLocalRuntimeTurn(options.session, async () => {
    return await runSerializedLocalUserMessageEvent(options);
  });
}

async function runSerializedLocalUserMessageEvent(
  options: RunLocalUserMessageEventOptions
): Promise<LocalRuntimeUserMessageResult> {
  const traceEntries: RuntimeTraceEntry[] = [];
  const rawEventLogRecords: RawEventLogRecord[] = [];
  const identity = freezeRuntimeEventIdentity({
    eventId: options.event.eventId,
    traceId: options.event.traceId,
    createdAt: options.event.createdAt
  });
  const payloadSummary = createNormalizedPayloadSummary({
    normalizedCurrentUserMessage: options.event.payload.currentUserMessage,
    ...(options.rawInput === undefined ? {} : { rawInput: options.rawInput })
  });

  function appendTrace(step: RuntimeTraceStepName): RuntimeTraceEntry {
    const traceEntry = options.logStore.appendTrace({
      ...identity,
      step
    });

    traceEntries.push(traceEntry);
    return traceEntry;
  }

  function appendRawEvent(record: RawEventLogRecordInput): RawEventLogRecord {
    const rawEvent = options.logStore.appendRawEvent(record);

    rawEventLogRecords.push(rawEvent);
    return rawEvent;
  }

  function appendRejectedResult(optionsForRejection: {
    readonly evidence?: RoleModelRawEvidence;
    readonly message: string;
    readonly rawKind: RawEventLogRecordInput['kind'];
    readonly rawReason: string;
    readonly reason: LocalRuntimeUserMessageRejectionReason;
    readonly traceStep: RuntimeTraceStepName;
  }): LocalRuntimeUserMessageRejectedResult {
    const evidence = optionsForRejection.evidence ?? {};

    appendTrace(optionsForRejection.traceStep);
    appendRawEvent({
      ...identity,
      kind: optionsForRejection.rawKind,
      eventType: options.event.type,
      status: 'rejected',
      reason: optionsForRejection.rawReason,
      payloadSummary,
      ...evidence
    });

    const rawEvent = appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: options.event.type,
      status: 'rejected',
      reason: optionsForRejection.rawReason,
      payloadSummary,
      ...evidence
    });

    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_rejected');

    return Object.freeze({
      status: 'rejected',
      event: options.event,
      reason: optionsForRejection.reason,
      message: optionsForRejection.message,
      rawEvent,
      rawEventLogRecords: Object.freeze([...rawEventLogRecords]),
      traceEntries: Object.freeze([...traceEntries])
    } satisfies LocalRuntimeUserMessageRejectedResult);
  }

  function appendRoleModelRejectedResult(
    rejection: RoleModelDecisionRejection,
    evidence: RoleModelRawEvidence
  ): LocalRuntimeUserMessageRejectedResult {
    return appendRejectedResult({
      evidence,
      message: rejection.details ?? rejection.reason,
      rawKind: 'commit_validation_rejected',
      rawReason: rejection.reason,
      reason: rejection.reason,
      traceStep: 'commit_validation_rejected'
    });
  }

  appendTrace('runtime_event_received');
  appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: options.event.type,
    payloadSummary
  });
  appendTrace('runtime_event_normalized');
  appendRawEvent({
    ...identity,
    kind: 'runtime_event_normalized',
    eventType: options.event.type,
    payloadSummary
  });
  appendTrace('runtime_turn_started');

  try {
    const inputValidationMessage = validateEventUserMessage(
      options.event.payload.currentUserMessage
    );

    if (inputValidationMessage !== undefined) {
      return appendRejectedResult({
        message: inputValidationMessage,
        rawKind: 'input_validation_rejected',
        rawReason: inputValidationMessage,
        reason: 'input_validation_rejected',
        traceStep: 'input_validation_rejected'
      });
    }

    const decisionContext = buildUserTurnDecisionContext({
      session: options.session,
      ...(options.characterTurnOptions?.recentMessageLimit === undefined
        ? {}
        : {
            recentMessageLimit: options.characterTurnOptions.recentMessageLimit
          })
    });
    const roleModelResult = await runRoleModelLoop({
      event: options.event,
      decisionContext,
      ...roleModelLoopAdapterOption(options)
    });
    const roleModelEvidence = {
      roleModelIOSnapshot: roleModelResult.ioSnapshot,
      parsedRoleModelDecisionSnapshot: roleModelResult.parsedDecisionSnapshot
    } satisfies RoleModelRawEvidence;

    if (roleModelResult.status === 'rejected') {
      const commitValidation = createRejectedCommitValidationSnapshot({
        identity,
        rejection: roleModelResult.rejection,
        sessionId: decisionContext.sessionId
      });

      return appendRoleModelRejectedResult(roleModelResult.rejection, {
        ...roleModelEvidence,
        commitValidation
      });
    }

    let turn: CharacterTurnResult;

    try {
      turn = await runCharacterTurn(
        options.session,
        options.event.payload.currentUserMessage,
        createFixedReplyAgent(roleModelResult.decision.action.text),
        options.characterTurnOptions
      );
    } catch (error: unknown) {
      if (error instanceof CharacterInputError) {
        return appendRejectedResult({
          evidence: roleModelEvidence,
          message: error.message,
          rawKind: 'input_validation_rejected',
          rawReason: error.message,
          reason: 'input_validation_rejected',
          traceStep: 'input_validation_rejected'
        });
      }

      if (error instanceof CharacterReplyValidationError) {
        const rejection = createRejectedRoleModelDecisionResult(
          roleModelInvalidVisibleReplyRejectionReason,
          error.message
        ).rejection;
        const commitValidation = createRejectedCommitValidationSnapshot({
          identity,
          rejection,
          sessionId: decisionContext.sessionId
        });

        return appendRoleModelRejectedResult(rejection, {
          ...roleModelEvidence,
          commitValidation
        });
      }

      throw error;
    }

    const committedAt = options.committedAt ?? options.event.createdAt;
    const acceptedCommitValidation = createRoleModelCommitValidationSnapshot({
      ...identity,
      sessionId: decisionContext.sessionId,
      result: {
        status: 'accepted',
        acceptedVisibleReplyText: turn.reply.text
      }
    });
    const acceptedEvidence = {
      ...roleModelEvidence,
      commitValidation: acceptedCommitValidation
    } satisfies RoleModelRawEvidence;
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
    appendRawEvent({
      ...identity,
      kind: 'visible_reply_committed',
      eventType: options.event.type,
      visibleMessageIds: conversationMessages.map((message) => message.id),
      payloadSummary,
      ...acceptedEvidence
    });

    const rawEvent = appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: options.event.type,
      status: 'completed',
      visibleMessageIds: conversationMessages.map((message) => message.id),
      payloadSummary,
      ...acceptedEvidence
    });

    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_completed');

    return Object.freeze({
      status: 'completed',
      event: options.event,
      turn,
      conversationMessages,
      rawEvent,
      rawEventLogRecords: Object.freeze([...rawEventLogRecords]),
      traceEntries: Object.freeze([...traceEntries])
    } satisfies LocalRuntimeUserMessageCompletedResult);
  } catch (error: unknown) {
    if (error instanceof CharacterInputError) {
      return appendRejectedResult({
        message: error.message,
        rawKind: 'input_validation_rejected',
        rawReason: error.message,
        reason: 'input_validation_rejected',
        traceStep: 'input_validation_rejected'
      });
    }

    if (error instanceof CharacterReplyValidationError) {
      const rejection = createRejectedRoleModelDecisionResult(
        roleModelInvalidVisibleReplyRejectionReason,
        error.message
      ).rejection;
      const commitValidation = createRejectedCommitValidationSnapshot({
        identity,
        rejection,
        sessionId: options.session.id
      });

      return appendRoleModelRejectedResult(rejection, {
        commitValidation
      });
    }

    appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: options.event.type,
      status: 'rejected',
      reason: unexpectedRuntimeTurnFailureMessage,
      payloadSummary
    });
    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_rejected');

    throw error;
  }
}

async function enqueueLocalRuntimeTurn<T>(
  session: ConversationSession,
  operation: () => Promise<T>
): Promise<T> {
  const previousTurn = localRuntimeTurnQueues.get(session) ?? Promise.resolve();
  const currentTurn = previousTurn.then(operation, operation);

  localRuntimeTurnQueues.set(
    session,
    currentTurn.then(
      () => undefined,
      () => undefined
    )
  );

  return await currentTurn;
}

function freezeRuntimeEventIdentity(identity: RuntimeEventIdentity): RuntimeEventIdentity {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: identity.createdAt
  } satisfies RuntimeEventIdentity);
}

function createRawInputPayloadSummary(
  rawInput: string | undefined
): RawEventLogPayloadSummary | undefined {
  if (rawInput === undefined) {
    return undefined;
  }

  return Object.freeze({
    rawInput
  } satisfies RawEventLogPayloadSummary);
}

function createNormalizedPayloadSummary(options: {
  readonly normalizedCurrentUserMessage: string;
  readonly rawInput?: string;
}): RawEventLogPayloadSummary {
  return Object.freeze({
    ...(options.rawInput === undefined ? {} : { rawInput: options.rawInput }),
    normalizedCurrentUserMessage: options.normalizedCurrentUserMessage
  } satisfies RawEventLogPayloadSummary);
}

function validateEventUserMessage(message: string): string | undefined {
  try {
    normalizeOneLineMessage(message);
    return undefined;
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      return error.message;
    }

    throw error;
  }
}

function roleModelLoopAdapterOption(
  options: RunLocalUserMessageEventOptions
): { readonly adapter?: RoleModelAdapter } {
  if (options.roleModelAdapter !== undefined) {
    return {
      adapter: options.roleModelAdapter
    };
  }

  if (options.agent !== undefined) {
    return {
      adapter: createRoleModelAdapterFromCharacterAgent(options.agent)
    };
  }

  return {};
}

function createFixedReplyAgent(replyText: string): CharacterAgent {
  return Object.freeze({
    reply(): CharacterAgentReply {
      return {
        text: replyText
      };
    }
  } satisfies CharacterAgent);
}

function createRejectedCommitValidationSnapshot(options: {
  readonly identity: RuntimeEventIdentity;
  readonly rejection: RoleModelDecisionRejection;
  readonly sessionId: string;
}): RoleModelCommitValidationSnapshot {
  return createRoleModelCommitValidationSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    result: {
      status: 'rejected',
      rejection: options.rejection
    }
  });
}
