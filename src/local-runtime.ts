import {
  CharacterInputError,
  CharacterReplyValidationError,
  rollbackLastCharacterTurn,
  runCharacterTurn,
  type CharacterAgent,
  type CharacterAgentReply,
  type CharacterTurnOptions,
  type CharacterTurnResult,
  type ConversationSession
} from './conversation.ts';
import {
  createCharacterStatePatchSnapshot,
  createInMemoryCharacterStateStore,
  createLivingStateBrief,
  planCharacterStatePatch,
  type CharacterRuntimeState,
  type CharacterStatePatchSnapshot,
  type CharacterStateStore
} from './character-state.ts';
import { createFileCharacterStateStore } from './file-character-state-store.ts';
import { buildUserTurnDecisionContext } from './decision-context.ts';
import {
  createRuntimeCapabilityContext,
  type AgentCapabilityEvidenceSnapshot
} from './agent-capabilities.ts';
import {
  runtimeCapabilityBeforeRoleModelCallRejectionReason,
  type RuntimeCapabilityBeforeRoleModelCallCompletedResult,
  type RuntimeCapabilityHookHostResult,
  type RuntimeCapabilityHost
} from './agent-capability-host.ts';
import {
  createDecisionContext,
  createRejectedRoleModelDecisionResult,
  getCharacterStatePatchToolCall,
  getRequiredVisibleReplyText,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelIOSnapshot
} from './role-model-contracts.ts';
import {
  createRoleModelAdapterFromCharacterAgent,
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelCapabilityToolRoutingEvidence
} from './role-model-loop.ts';
import {
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent
} from './runtime-event.ts';
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
  | typeof runtimeCapabilityBeforeRoleModelCallRejectionReason
  | RoleModelDecisionRejectionReason;

export type RunLocalUserMessageEventOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly rawInput?: string;
  readonly agent?: CharacterAgent;
  readonly characterStateStore?: CharacterStateStore;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly capabilityHost?: RuntimeCapabilityHost;
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
const defaultCharacterStateStores = new WeakMap<
  ConversationSession,
  CharacterStateStore
>();

type RoleModelRawEvidence = {
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
  readonly characterStatePatchSnapshot?: CharacterStatePatchSnapshot;
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
  const normalizedEventResult = normalizeUserMessageRuntimeEvent(options.event);
  const event =
    normalizedEventResult.status === 'accepted'
      ? normalizedEventResult.event
      : options.event;
  const payloadSummary = createNormalizedPayloadSummary({
    normalizedCurrentUserMessage: event.payload.currentUserMessage,
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
    readonly agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[];
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
      eventType: event.type,
      status: 'rejected',
      reason: optionsForRejection.rawReason,
      payloadSummary,
      ...evidence,
      ...agentCapabilityEvidenceOption(
        optionsForRejection.agentCapabilityEvidence
      )
    });

    const rawEvent = appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: event.type,
      status: 'rejected',
      reason: optionsForRejection.rawReason,
      payloadSummary,
      ...evidence,
      ...agentCapabilityEvidenceOption(
        optionsForRejection.agentCapabilityEvidence
      )
    });

    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_rejected');

    return Object.freeze({
      status: 'rejected',
      event,
      reason: optionsForRejection.reason,
      message: optionsForRejection.message,
      rawEvent,
      rawEventLogRecords: Object.freeze([...rawEventLogRecords]),
      traceEntries: Object.freeze([...traceEntries])
    } satisfies LocalRuntimeUserMessageRejectedResult);
  }

  function appendRoleModelRejectedResult(
    rejection: RoleModelDecisionRejection,
    evidence: RoleModelRawEvidence,
    agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[]
  ): LocalRuntimeUserMessageRejectedResult {
    return appendRejectedResult({
      evidence,
      ...(agentCapabilityEvidence === undefined ? {} : { agentCapabilityEvidence }),
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
    eventType: event.type,
    payloadSummary
  });
  appendTrace('runtime_event_normalized');
  appendRawEvent({
    ...identity,
    kind: 'runtime_event_normalized',
    eventType: event.type,
    payloadSummary
  });
  appendTrace('runtime_turn_started');

  let writtenCharacterStateRollback:
    | {
        readonly state: CharacterRuntimeState;
        readonly store: CharacterStateStore;
        rollbackAllowed: boolean;
      }
    | undefined;
  let sessionTurnRollback:
    | {
        readonly session: ConversationSession;
        readonly turn: CharacterTurnResult;
        rollbackAllowed: boolean;
      }
    | undefined;

  try {
    if (normalizedEventResult.status === 'rejected') {
      return appendRejectedResult({
        message: normalizedEventResult.message,
        rawKind: 'input_validation_rejected',
        rawReason: normalizedEventResult.message,
        reason: 'input_validation_rejected',
        traceStep: 'input_validation_rejected'
      });
    }

    const characterStateStore = characterStateStoreForTurn(options);
    const currentCharacterState = characterStateStore.readCurrentState();
    const decisionContext = buildUserTurnDecisionContext({
      session: options.session,
      livingStateBrief: createLivingStateBrief(currentCharacterState),
      ...(options.characterTurnOptions?.recentMessageLimit === undefined
        ? {}
        : {
            recentMessageLimit: options.characterTurnOptions.recentMessageLimit
          })
    });
    const runtimeCapabilityContext = createRuntimeCapabilityContext({
      ...identity,
      sessionId: decisionContext.sessionId,
      eventType: event.type,
      currentUserMessage: event.payload.currentUserMessage,
      character: decisionContext.characterSnapshot
    });
    const beforeRoleModelCallResult =
      options.capabilityHost === undefined
        ? createEmptyBeforeRoleModelCallResult()
        : await options.capabilityHost.beforeRoleModelCall(
            runtimeCapabilityContext
          );

    if (beforeRoleModelCallResult.status === 'rejected') {
      return appendRejectedResult({
        agentCapabilityEvidence: beforeRoleModelCallResult.evidence,
        message: beforeRoleModelCallResult.message,
        rawKind: runtimeCapabilityBeforeRoleModelCallRejectionReason,
        rawReason: beforeRoleModelCallResult.message,
        reason: beforeRoleModelCallResult.reason,
        traceStep: runtimeCapabilityBeforeRoleModelCallRejectionReason
      });
    }

    const roleModelDecisionContext = createDecisionContext({
      sessionId: decisionContext.sessionId,
      characterSnapshot: decisionContext.characterSnapshot,
      recentVisibleMessages: decisionContext.recentVisibleMessages,
      runtimeNotes: Object.freeze([
        ...decisionContext.runtimeNotes,
        ...beforeRoleModelCallResult.runtimeNotes
      ]),
      capabilityContextItems: beforeRoleModelCallResult.contextItems,
      ...(decisionContext.livingStateBrief === undefined
        ? {}
        : { livingStateBrief: decisionContext.livingStateBrief })
    });
    const roleModelResult = await runRoleModelLoop({
      event,
      decisionContext: roleModelDecisionContext,
      capabilityToolDefinitions:
        options.capabilityHost?.capabilityToolDefinitions() ?? [],
      ...(options.capabilityHost === undefined
        ? {}
        : {
            capabilityToolHost: options.capabilityHost,
            runtimeCapabilityContext
          }),
      ...roleModelLoopAdapterOption(options)
    });
    const roleModelEvidence = {
      roleModelIOSnapshot: roleModelResult.ioSnapshot,
      parsedRoleModelDecisionSnapshot: roleModelResult.parsedDecisionSnapshot
    } satisfies RoleModelRawEvidence;
    const roleModelCapabilityEvidence = combineAgentCapabilityEvidence(
      beforeRoleModelCallResult.evidence,
      capabilityToolEvidenceFromRouting(roleModelResult.capabilityToolResults)
    );

    if (roleModelResult.status === 'rejected') {
      const commitValidation = createRejectedCommitValidationSnapshot({
        identity,
        rejection: roleModelResult.rejection,
        sessionId: decisionContext.sessionId
      });

      return appendRoleModelRejectedResult(
        roleModelResult.rejection,
        {
          ...roleModelEvidence,
          commitValidation
        },
        roleModelCapabilityEvidence
      );
    }

    const statePatchToolCall = getCharacterStatePatchToolCall(
      roleModelResult.decision
    );
    const statePatchPlan =
      statePatchToolCall === undefined
        ? undefined
        : planCharacterStatePatch({
            before: currentCharacterState,
            patchInput: statePatchToolCall.input
          });
    const statePatchSnapshot =
      statePatchPlan === undefined
        ? undefined
        : createCharacterStatePatchSnapshot({
            ...identity,
            sessionId: decisionContext.sessionId,
            result: statePatchPlan
          });

    if (statePatchPlan?.status === 'rejected') {
      const rejection = createRejectedRoleModelDecisionResult(
        roleModelInvalidCharacterStatePatchRejectionReason,
        statePatchPlan.rejection.details
      ).rejection;
      const commitValidation = createRejectedCommitValidationSnapshot({
        identity,
        rejection,
        sessionId: decisionContext.sessionId
      });

      return appendRoleModelRejectedResult(
        rejection,
        {
          ...roleModelEvidence,
          commitValidation,
          ...(statePatchSnapshot === undefined
            ? {}
            : { characterStatePatchSnapshot: statePatchSnapshot })
        },
        roleModelCapabilityEvidence
      );
    }

    let turn: CharacterTurnResult;
    const visibleReplyText = getRequiredVisibleReplyText(roleModelResult.decision);

    try {
      turn = await runCharacterTurn(
        options.session,
        event.payload.currentUserMessage,
        createFixedReplyAgent(visibleReplyText),
        options.characterTurnOptions
      );
    } catch (error: unknown) {
      if (error instanceof CharacterInputError) {
        return appendRejectedResult({
          agentCapabilityEvidence: roleModelCapabilityEvidence,
          evidence: roleModelEvidence,
          message: error.message,
          rawKind: 'input_validation_rejected',
          rawReason: error.message,
          reason: 'input_validation_rejected',
          traceStep: 'input_validation_rejected'
        });
      }

      if (error instanceof CharacterReplyValidationError) {
        const rejection = createInvalidVisibleReplyRejection(error);
        const commitValidation = createRejectedCommitValidationSnapshot({
          identity,
          rejection,
          sessionId: decisionContext.sessionId
        });

        return appendRoleModelRejectedResult(
          rejection,
          {
            ...roleModelEvidence,
            commitValidation
          },
          roleModelCapabilityEvidence
        );
      }

      throw error;
    }

    sessionTurnRollback = {
      session: options.session,
      turn,
      rollbackAllowed: true
    };

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
      commitValidation: acceptedCommitValidation,
      ...(statePatchSnapshot === undefined
        ? {}
        : { characterStatePatchSnapshot: statePatchSnapshot })
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

    if (statePatchPlan?.status === 'accepted') {
      characterStateStore.writeCurrentState(statePatchPlan.after);
      writtenCharacterStateRollback = {
        store: characterStateStore,
        state: currentCharacterState,
        rollbackAllowed: true
      };
    }

    appendTrace('visible_reply_committed');
    appendRawEvent({
      ...identity,
      kind: 'visible_reply_committed',
      eventType: event.type,
      visibleMessageIds: conversationMessages.map((message) => message.id),
      payloadSummary,
      ...acceptedEvidence,
      ...agentCapabilityEvidenceOption(roleModelCapabilityEvidence)
    });

    sessionTurnRollback.rollbackAllowed = false;

    const afterTurnCommittedResult =
      options.capabilityHost === undefined
        ? createEmptyHookResult()
        : await options.capabilityHost.afterTurnCommitted(
            runtimeCapabilityContext
          );
    const completedCapabilityEvidence = combineAgentCapabilityEvidence(
      roleModelCapabilityEvidence,
      afterTurnCommittedResult.evidence
    );

    const rawEvent = appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: event.type,
      status: 'completed',
      visibleMessageIds: conversationMessages.map((message) => message.id),
      payloadSummary,
      ...acceptedEvidence,
      ...agentCapabilityEvidenceOption(completedCapabilityEvidence)
    });

    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_completed');

    if (writtenCharacterStateRollback !== undefined) {
      writtenCharacterStateRollback.rollbackAllowed = false;
    }

    return Object.freeze({
      status: 'completed',
      event,
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
      const rejection = createInvalidVisibleReplyRejection(error);

      return appendRejectedResult({
        message: error.message,
        rawKind: 'character_reply_rejected',
        rawReason: rejection.reason,
        reason: rejection.reason,
        traceStep: 'character_reply_rejected'
      });
    }

    rollbackWrittenCharacterStateIfSafe(writtenCharacterStateRollback);
    rollbackSessionTurnIfSafe(sessionTurnRollback);
    appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: event.type,
      status: 'rejected',
      reason: unexpectedRuntimeTurnFailureMessage,
      payloadSummary
    });
    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_rejected');

    throw error;
  }
}

function characterStateStoreForTurn(
  options: RunLocalUserMessageEventOptions
): CharacterStateStore {
  if (options.characterStateStore !== undefined) {
    return options.characterStateStore;
  }

  if (options.logStore.localRuntimeSessionPaths !== undefined) {
    return createFileCharacterStateStore({
      storeRoot: options.logStore.localRuntimeSessionPaths.storeRoot,
      sessionId: options.logStore.localRuntimeSessionPaths.sessionId
    });
  }

  const existingStore = defaultCharacterStateStores.get(options.session);

  if (existingStore !== undefined) {
    return existingStore;
  }

  const store = createInMemoryCharacterStateStore();

  defaultCharacterStateStores.set(options.session, store);
  return store;
}

function rollbackSessionTurnIfSafe(
  rollback:
    | {
        readonly session: ConversationSession;
        readonly turn: CharacterTurnResult;
        readonly rollbackAllowed: boolean;
      }
    | undefined
): void {
  if (rollback?.rollbackAllowed !== true) {
    return;
  }

  rollbackLastCharacterTurn(rollback.session, rollback.turn);
}

function rollbackWrittenCharacterStateIfSafe(
  rollback:
    | {
        readonly state: CharacterRuntimeState;
        readonly store: CharacterStateStore;
        readonly rollbackAllowed: boolean;
      }
    | undefined
): void {
  if (rollback?.rollbackAllowed !== true) {
    return;
  }

  rollback.store.writeCurrentState(rollback.state);
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

type NormalizeUserMessageRuntimeEventResult =
  | {
      readonly status: 'accepted';
      readonly event: UserMessageRuntimeEvent;
    }
  | {
      readonly status: 'rejected';
      readonly message: string;
    };

function normalizeUserMessageRuntimeEvent(
  event: UserMessageRuntimeEvent
): NormalizeUserMessageRuntimeEventResult {
  try {
    return Object.freeze({
      status: 'accepted',
      event: createUserMessageRuntimeEvent(event.payload.currentUserMessage, event)
    } satisfies NormalizeUserMessageRuntimeEventResult);
  } catch (error: unknown) {
    if (error instanceof RuntimeEventInputError) {
      return Object.freeze({
        status: 'rejected',
        message: error.message
      } satisfies NormalizeUserMessageRuntimeEventResult);
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

function createEmptyBeforeRoleModelCallResult(): RuntimeCapabilityBeforeRoleModelCallCompletedResult {
  return Object.freeze({
    status: 'completed',
    contextItems: Object.freeze([]),
    runtimeNotes: Object.freeze([]),
    evidence: Object.freeze([])
  } satisfies RuntimeCapabilityBeforeRoleModelCallCompletedResult);
}

function createEmptyHookResult(): RuntimeCapabilityHookHostResult {
  return Object.freeze({
    status: 'completed',
    evidence: Object.freeze([])
  } satisfies RuntimeCapabilityHookHostResult);
}

function capabilityToolEvidenceFromRouting(
  results: readonly RoleModelCapabilityToolRoutingEvidence[]
): readonly AgentCapabilityEvidenceSnapshot[] {
  return Object.freeze(results.flatMap((routing) => routing.result.evidence));
}

function combineAgentCapabilityEvidence(
  ...evidenceGroups: readonly (readonly AgentCapabilityEvidenceSnapshot[])[]
): readonly AgentCapabilityEvidenceSnapshot[] {
  return Object.freeze(evidenceGroups.flatMap((evidence) => evidence));
}

function agentCapabilityEvidenceOption(
  evidence: readonly AgentCapabilityEvidenceSnapshot[] | undefined
): { readonly agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[] } {
  if (evidence === undefined || evidence.length === 0) {
    return {};
  }

  return {
    agentCapabilityEvidence: Object.freeze([...evidence])
  };
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

function createInvalidVisibleReplyRejection(
  error: CharacterReplyValidationError
): RoleModelDecisionRejection {
  return createRejectedRoleModelDecisionResult(
    roleModelInvalidVisibleReplyRejectionReason,
    error.message
  ).rejection;
}
