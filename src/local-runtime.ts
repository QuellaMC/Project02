import {
  appendCharacterVisibleMessage,
  CharacterInputError,
  CharacterReplyValidationError,
  normalizeCharacterAgentReply,
  runCharacterTurn,
  type CharacterAgent,
  type CharacterAgentReply,
  type CharacterTurnOptions,
  type CharacterTurnResult,
  type ConversationSession
} from './conversation.ts';
import { buildUserTurnDecisionContext } from './decision-context.ts';
import {
  agentCapabilityContractVersion,
  createAgentCapabilityToolInvocationSnapshot,
  createAgentCapabilityTurnEvidenceSnapshot,
  createRuntimeCapabilityAfterTurnCommittedContext,
  createRuntimeCapabilityContext,
  type AgentCapabilityContextItem,
  type AgentCapabilityEvidenceSnapshot,
  type AgentCapabilityHealthSnapshot,
  type AgentCapabilityToolCall,
  type AgentCapabilityToolCallResult,
  type AgentCapabilityToolInvocationSnapshot,
  type AgentCapabilityTurnEvidenceSnapshot,
  type RuntimeCapabilityContext
} from './agent-capabilities.ts';
import {
  runtimeCapabilityBeforeRoleModelCallRejectionReason,
  type RuntimeCapabilityHealthHostResult,
  type RuntimeCapabilityHost
} from './agent-capability-host.ts';
import {
  createDecisionContext,
  createRejectedRoleModelDecisionResult,
  getVisibleReplyToolCall,
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
import { createDefaultProject02PluginHost } from './plugins/index.ts';
import type { RuntimePluginHost } from './plugins/index.ts';
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

const runtimeCapabilityHealthRejectionReason = 'capability_health_rejected';

export type LocalRuntimeUserMessageRejectionReason =
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | typeof runtimeCapabilityHealthRejectionReason
  | typeof runtimeCapabilityBeforeRoleModelCallRejectionReason
  | RoleModelDecisionRejectionReason;

export type RunLocalUserMessageEventOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly rawInput?: string;
  readonly agent?: CharacterAgent;
  readonly characterStateStore?: unknown;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly capabilityHost?: RuntimeCapabilityHost;
  readonly characterTurnOptions?: CharacterTurnOptions;
  readonly committedAt?: string;
  readonly onProgress?: (
    event: LocalRuntimeTurnProgressEvent
  ) => Promise<void> | void;
};

export type LocalRuntimeTurnProgressEvent =
  | {
      readonly kind: 'visible_reply';
      readonly final: boolean;
      readonly text: string;
    }
  | {
      readonly kind: 'tool_calls_requested';
      readonly round: number;
      readonly toolNames: readonly string[];
    }
  | {
      readonly kind: 'tool_call_completed';
      readonly round: number;
      readonly status: 'accepted' | 'rejected';
      readonly toolName: string;
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
  const normalizedEventResult = normalizeUserMessageRuntimeEvent(options.event);
  const event =
    normalizedEventResult.status === 'accepted'
      ? normalizedEventResult.event
      : options.event;
  const payloadSummary = createNormalizedPayloadSummary({
    normalizedCurrentUserMessage: event.payload.currentUserMessage,
    ...(options.rawInput === undefined ? {} : { rawInput: options.rawInput })
  });
  let runtimeCapabilityContextForTurn: RuntimeCapabilityContext | undefined;

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

  async function appendRejectedResult(optionsForRejection: {
    readonly agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[];
    readonly agentCapabilityContextItems?: readonly AgentCapabilityContextItem[];
    readonly agentCapabilityToolInvocations?: readonly AgentCapabilityToolInvocationSnapshot[];
    readonly evidence?: RoleModelRawEvidence;
    readonly healthResult?: RuntimeCapabilityHealthHostResult;
    readonly message: string;
    readonly rawKind: RawEventLogRecordInput['kind'];
    readonly rawReason: string;
    readonly reason: LocalRuntimeUserMessageRejectionReason;
    readonly runtimeCapabilityContext?: RuntimeCapabilityContext;
    readonly traceStep: RuntimeTraceStepName;
    readonly toolCallIds?: readonly string[];
    readonly visibleMessageIds?: readonly string[];
  }): Promise<LocalRuntimeUserMessageRejectedResult> {
    const evidence = optionsForRejection.evidence ?? {};
    const healthResult =
      optionsForRejection.healthResult ??
      (await capabilityHealthForTurn({
        capabilityHost: options.capabilityHost,
        runtimeCapabilityContext: optionsForRejection.runtimeCapabilityContext
      }));
    const agentCapabilityEvidence = combineAgentCapabilityEvidence(
      optionsForRejection.agentCapabilityEvidence ?? [],
      healthResult.evidence
    );

    appendTrace(optionsForRejection.traceStep);
    appendRawEvent({
      ...identity,
      kind: optionsForRejection.rawKind,
      eventType: event.type,
      status: 'rejected',
      reason: optionsForRejection.rawReason,
      ...(optionsForRejection.toolCallIds === undefined
        ? {}
        : { toolCallIds: optionsForRejection.toolCallIds }),
      ...(optionsForRejection.visibleMessageIds === undefined
        ? {}
        : { visibleMessageIds: optionsForRejection.visibleMessageIds }),
      payloadSummary,
      ...evidence,
      ...agentCapabilityEvidenceOption(agentCapabilityEvidence),
      ...agentCapabilityTurnEvidenceOption({
        identity,
        capabilityHost: options.capabilityHost,
        contextItems: optionsForRejection.agentCapabilityContextItems ?? [],
        toolInvocations:
          optionsForRejection.agentCapabilityToolInvocations ?? [],
        evidence: agentCapabilityEvidence,
        health: healthResult.snapshots
      })
    });

    const rawEvent = appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: event.type,
      status: 'rejected',
      reason: optionsForRejection.rawReason,
      ...(optionsForRejection.toolCallIds === undefined
        ? {}
        : { toolCallIds: optionsForRejection.toolCallIds }),
      ...(optionsForRejection.visibleMessageIds === undefined
        ? {}
        : { visibleMessageIds: optionsForRejection.visibleMessageIds }),
      payloadSummary,
      ...evidence,
      ...agentCapabilityEvidenceOption(agentCapabilityEvidence),
      ...agentCapabilityTurnEvidenceOption({
        identity,
        capabilityHost: options.capabilityHost,
        contextItems: optionsForRejection.agentCapabilityContextItems ?? [],
        toolInvocations:
          optionsForRejection.agentCapabilityToolInvocations ?? [],
        evidence: agentCapabilityEvidence,
        health: healthResult.snapshots
      })
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
    agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[],
    agentCapabilityContextItems?: readonly AgentCapabilityContextItem[],
    agentCapabilityToolInvocations?: readonly AgentCapabilityToolInvocationSnapshot[],
    runtimeCapabilityContext?: RuntimeCapabilityContext
  ): Promise<LocalRuntimeUserMessageRejectedResult> {
    return appendRejectedResult({
      evidence,
      ...(agentCapabilityEvidence === undefined ? {} : { agentCapabilityEvidence }),
      ...(agentCapabilityContextItems === undefined
        ? {}
        : { agentCapabilityContextItems }),
      ...(agentCapabilityToolInvocations === undefined
        ? {}
        : { agentCapabilityToolInvocations }),
      message: rejection.details ?? rejection.reason,
      rawKind: 'commit_validation_rejected',
      rawReason: rejection.reason,
      reason: rejection.reason,
      ...(runtimeCapabilityContext === undefined
        ? {}
        : { runtimeCapabilityContext }),
      traceStep: 'commit_validation_rejected',
      toolCallIds: Object.freeze([...finishedToolCallIds]),
      ...visibleMessageIdsForTurnOption(committedVisibleMessages)
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

  const committedVisibleMessages: ConversationLogRecord[] = [];
  const finishedToolCallIds: string[] = [];
  let userConversationMessage: ConversationLogRecord | undefined;

  async function emitProgress(
    progressEvent: LocalRuntimeTurnProgressEvent
  ): Promise<void> {
    await options.onProgress?.(progressEvent);
  }

  async function appendVisibleReplyForDecision(optionsForReply: {
    readonly agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[];
    readonly final: boolean;
    readonly roleModelIOSnapshot: RoleModelIOSnapshot;
    readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
    readonly text: string;
  }): Promise<CharacterTurnResult | undefined> {
    const normalizedReply = normalizeCharacterAgentReply({
      text: optionsForReply.text
    });
    const commitValidation = createRoleModelCommitValidationSnapshot({
      ...identity,
      sessionId: decisionContextSessionIdFromEvidence(
        optionsForReply.roleModelIOSnapshot
      ),
      result: {
        status: 'accepted',
        acceptedVisibleReplyText: normalizedReply.text
      }
    });

    if (!optionsForReply.final) {
      appendTrace('visible_reply_committed');
      appendRawEvent({
        ...identity,
        kind: 'visible_reply_committed',
        eventType: event.type,
        payloadSummary,
        roleModelIOSnapshot: optionsForReply.roleModelIOSnapshot,
        parsedRoleModelDecisionSnapshot:
          optionsForReply.parsedRoleModelDecisionSnapshot,
        commitValidation,
        ...agentCapabilityEvidenceOption(
          optionsForReply.agentCapabilityEvidence
        )
      });

      await emitProgress({
        kind: 'visible_reply',
        final: false,
        text: normalizedReply.text
      });

      return undefined;
    }

    let turn: CharacterTurnResult;
    let visibleMessagesForThisReply: readonly ConversationLogRecord[];
    const committedAt = options.committedAt ?? options.event.createdAt;

    if (userConversationMessage === undefined) {
      turn = await runCharacterTurn(
        options.session,
        event.payload.currentUserMessage,
        createFixedReplyAgent(normalizedReply.text),
        options.characterTurnOptions
      );

      const userRecord = options.logStore.appendConversationMessage({
        ...turn.userMessage,
        ...identity,
        committedAt
      });
      const characterRecord = options.logStore.appendConversationMessage({
        ...turn.characterMessage,
        ...identity,
        committedAt
      });

      userConversationMessage = userRecord;
      visibleMessagesForThisReply = Object.freeze([userRecord, characterRecord]);
    } else {
      const characterAppend = appendCharacterVisibleMessage(
        options.session,
        normalizedReply
      );
      const characterRecord = options.logStore.appendConversationMessage({
        ...characterAppend.characterMessage,
        ...identity,
        committedAt
      });

      turn = Object.freeze({
        userMessage: userConversationMessage,
        characterMessage: characterAppend.characterMessage,
        reply: characterAppend.reply
      } satisfies CharacterTurnResult);
      visibleMessagesForThisReply = Object.freeze([characterRecord]);
    }

    committedVisibleMessages.push(...visibleMessagesForThisReply);

    appendTrace('visible_reply_committed');
    appendRawEvent({
      ...identity,
      kind: 'visible_reply_committed',
      eventType: event.type,
      visibleMessageIds: visibleMessagesForThisReply.map(
        (message) => message.id
      ),
      payloadSummary,
      roleModelIOSnapshot: optionsForReply.roleModelIOSnapshot,
      parsedRoleModelDecisionSnapshot:
        optionsForReply.parsedRoleModelDecisionSnapshot,
      commitValidation,
      ...agentCapabilityEvidenceOption(
        optionsForReply.agentCapabilityEvidence
      )
    });

    await emitProgress({
      kind: 'visible_reply',
      final: optionsForReply.final,
      text: turn.reply.text
    });

    return turn;
  }

  function appendToolCallStarted(optionsForTool: {
    readonly callId: string;
    readonly round: number;
    readonly call: AgentCapabilityToolCall;
  }): void {
    appendTrace('tool_call_started');
    appendRawEvent({
      ...identity,
      kind: 'tool_call_started',
      eventType: event.type,
      toolCallId: optionsForTool.callId,
      toolRound: optionsForTool.round,
      toolName: optionsForTool.call.toolName,
      toolPluginId: optionsForTool.call.capabilityId,
      toolInput: optionsForTool.call.input,
      payloadSummary
    });
  }

  function appendToolCallFinished(optionsForTool: {
    readonly callId: string;
    readonly round: number;
    readonly capabilityId: string;
    readonly toolName: string;
    readonly result: AgentCapabilityToolCallResult;
  }): void {
    appendTrace('tool_call_finished');
    appendRawEvent({
      ...identity,
      kind: 'tool_call_finished',
      eventType: event.type,
      toolCallId: optionsForTool.callId,
      toolRound: optionsForTool.round,
      toolName: optionsForTool.toolName,
      toolPluginId: optionsForTool.capabilityId,
      toolResult: optionsForTool.result,
      ...pluginStoreRevisionOption(optionsForTool.result),
      payloadSummary
    });
    finishedToolCallIds.push(optionsForTool.callId);
  }

  try {
    if (normalizedEventResult.status === 'rejected') {
      return await appendRejectedResult({
        message: normalizedEventResult.message,
        rawKind: 'input_validation_rejected',
        rawReason: normalizedEventResult.message,
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
    const runtimeCapabilityContext = createRuntimeCapabilityContext({
      ...identity,
      sessionId: decisionContext.sessionId,
      eventType: event.type,
      currentUserMessage: event.payload.currentUserMessage,
      character: decisionContext.characterSnapshot
    });
    runtimeCapabilityContextForTurn = runtimeCapabilityContext;
    const pluginHost = createPluginHostForTurn({
      capabilityHost: options.capabilityHost,
      decisionContextSessionId: decisionContext.sessionId,
      logStore: options.logStore
    });
    const beforeRoleModelCallResult = await pluginHost.beforeRoleModelCall(
      runtimeCapabilityContext
    );

    if (beforeRoleModelCallResult.status === 'rejected') {
      return await appendRejectedResult({
        agentCapabilityEvidence: beforeRoleModelCallResult.evidence,
        message: beforeRoleModelCallResult.message,
        rawKind: runtimeCapabilityBeforeRoleModelCallRejectionReason,
        rawReason: beforeRoleModelCallResult.message,
        reason: beforeRoleModelCallResult.reason,
        runtimeCapabilityContext,
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
      capabilityContextItems: beforeRoleModelCallResult.contextItems
    });
    const roleModelResult = await runRoleModelLoop({
      event,
      decisionContext: roleModelDecisionContext,
      capabilityToolDefinitions: pluginHost.capabilityToolDefinitions(),
      capabilityToolHost: pluginHost,
      runtimeCapabilityContext,
      resolveToolCapabilityId(toolName) {
        return pluginHost.resolveToolCapabilityId(toolName);
      },
      onCapabilityToolCallStarted(progressEvent) {
        appendToolCallStarted({
          callId: progressEvent.callId,
          round: progressEvent.round,
          call: progressEvent.call
        });
      },
      async onCapabilityToolCallCompleted(progressEvent) {
        appendToolCallFinished({
          callId: progressEvent.callId,
          round: progressEvent.round,
          capabilityId: progressEvent.capabilityId,
          toolName: progressEvent.toolName,
          result: progressEvent.result
        });
        await emitProgress({
          kind: 'tool_call_completed',
          round: progressEvent.round,
          status: progressEvent.status,
          toolName: progressEvent.toolName
        });
      },
      async onCapabilityToolCallsRequested(progressEvent) {
        await emitProgress({
          kind: 'tool_calls_requested',
          round: progressEvent.round,
          toolNames: progressEvent.toolNames
        });
      },
      async onInterimVisibleReply(progressEvent) {
        await appendVisibleReplyForDecision({
          agentCapabilityEvidence: beforeRoleModelCallResult.evidence,
          final: false,
          roleModelIOSnapshot: progressEvent.ioSnapshot,
          parsedRoleModelDecisionSnapshot:
            progressEvent.parsedDecisionSnapshot,
          text: progressEvent.text
        });
      },
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
    const roleModelCapabilityToolInvocations =
      capabilityToolInvocationsFromRouting(roleModelResult.capabilityToolResults);

    if (roleModelResult.status === 'rejected') {
      const commitValidation = createRejectedCommitValidationSnapshot({
        identity,
        rejection: roleModelResult.rejection,
        sessionId: decisionContext.sessionId
      });

      return await appendRoleModelRejectedResult(
        roleModelResult.rejection,
        {
          ...roleModelEvidence,
          commitValidation
        },
        roleModelCapabilityEvidence,
        beforeRoleModelCallResult.contextItems,
        roleModelCapabilityToolInvocations,
        runtimeCapabilityContext
      );
    }

    const visibleReply = getVisibleReplyToolCall(roleModelResult.decision);
    const visibleReplyText = visibleReply?.input.text;

    if (visibleReplyText !== undefined) {
      try {
        normalizeCharacterAgentReply({
          text: visibleReplyText
        });
      } catch (error: unknown) {
        if (error instanceof CharacterReplyValidationError) {
          const rejection = createInvalidVisibleReplyRejection(error);
          const commitValidation = createRejectedCommitValidationSnapshot({
            identity,
            rejection,
            sessionId: decisionContext.sessionId
          });

          return await appendRoleModelRejectedResult(
            rejection,
            {
              ...roleModelEvidence,
              commitValidation
            },
            roleModelCapabilityEvidence,
            beforeRoleModelCallResult.contextItems,
            roleModelCapabilityToolInvocations,
            runtimeCapabilityContext
          );
        }

        throw error;
      }
    }

    const preCommitHealthResult = await pluginHost.health(runtimeCapabilityContext);

    if (
      healthResultRejectsTurn({
        capabilityHost: options.capabilityHost,
        healthResult: preCommitHealthResult
      })
    ) {
      return await appendRejectedResult({
        agentCapabilityEvidence: roleModelCapabilityEvidence,
        agentCapabilityContextItems: beforeRoleModelCallResult.contextItems,
        agentCapabilityToolInvocations: roleModelCapabilityToolInvocations,
        evidence: {
          ...roleModelEvidence
        },
        healthResult: preCommitHealthResult,
        message: healthResultRejectionMessage({
          capabilityHost: options.capabilityHost,
          healthResult: preCommitHealthResult
        }),
        rawKind: 'commit_validation_rejected',
        rawReason: runtimeCapabilityHealthRejectionReason,
        reason: runtimeCapabilityHealthRejectionReason,
        runtimeCapabilityContext,
        traceStep: 'commit_validation_rejected',
        ...visibleMessageIdsForTurnOption(committedVisibleMessages)
      });
    }

    const turn =
      visibleReplyText === undefined
        ? undefined
        : await appendVisibleReplyForDecision({
            agentCapabilityEvidence: roleModelCapabilityEvidence,
            final: true,
            roleModelIOSnapshot: roleModelResult.ioSnapshot,
            parsedRoleModelDecisionSnapshot: roleModelResult.parsedDecisionSnapshot,
            text: visibleReplyText
          });
    const afterCommitCapabilityContext =
      createRuntimeCapabilityAfterTurnCommittedContext({
        ...identity,
        sessionId: decisionContext.sessionId,
        eventType: event.type,
        currentUserMessage: event.payload.currentUserMessage,
        character: decisionContext.characterSnapshot,
        committedAt: options.committedAt ?? options.event.createdAt,
        visibleMessages: committedVisibleMessages
      });

    const afterTurnCommittedResult =
      await pluginHost.afterTurnCommitted(afterCommitCapabilityContext);
    const completedCapabilityEvidence = combineAgentCapabilityEvidence(
      roleModelCapabilityEvidence,
      afterTurnCommittedResult.evidence,
      preCommitHealthResult.evidence
    );

    const rawEvent = appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: event.type,
      status: 'completed',
      ...visibleMessageIdsForTurnOption(committedVisibleMessages),
      toolCallIds: Object.freeze([...finishedToolCallIds]),
      payloadSummary,
      roleModelIOSnapshot: roleModelResult.ioSnapshot,
      parsedRoleModelDecisionSnapshot: roleModelResult.parsedDecisionSnapshot,
      commitValidation: createRoleModelCommitValidationSnapshot({
        ...identity,
        sessionId: decisionContext.sessionId,
        result: {
          status: 'accepted',
          ...(turn === undefined ? {} : { acceptedVisibleReplyText: turn.reply.text })
        }
      }),
      ...agentCapabilityEvidenceOption(completedCapabilityEvidence),
      ...agentCapabilityTurnEvidenceOption({
        identity,
        capabilityHost: options.capabilityHost,
        contextItems: beforeRoleModelCallResult.contextItems,
        toolInvocations: roleModelCapabilityToolInvocations,
        evidence: completedCapabilityEvidence,
        health: preCommitHealthResult.snapshots
      })
    });

    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_completed');

    return Object.freeze({
      status: 'completed',
      event,
      turn: turn as CharacterTurnResult,
      conversationMessages: Object.freeze([...committedVisibleMessages]),
      rawEvent,
      rawEventLogRecords: Object.freeze([...rawEventLogRecords]),
      traceEntries: Object.freeze([...traceEntries])
    } satisfies LocalRuntimeUserMessageCompletedResult);
  } catch (error: unknown) {
    if (error instanceof CharacterInputError) {
      return await appendRejectedResult({
        message: error.message,
        rawKind: 'input_validation_rejected',
        rawReason: error.message,
        reason: 'input_validation_rejected',
        ...(runtimeCapabilityContextForTurn === undefined
          ? {}
          : { runtimeCapabilityContext: runtimeCapabilityContextForTurn }),
        traceStep: 'input_validation_rejected'
      });
    }

    if (error instanceof CharacterReplyValidationError) {
      const rejection = createInvalidVisibleReplyRejection(error);

      return await appendRejectedResult({
        message: error.message,
        rawKind: 'character_reply_rejected',
        rawReason: rejection.reason,
        reason: rejection.reason,
        ...(runtimeCapabilityContextForTurn === undefined
          ? {}
          : { runtimeCapabilityContext: runtimeCapabilityContextForTurn }),
        traceStep: 'character_reply_rejected',
        ...visibleMessageIdsForTurnOption(committedVisibleMessages)
      });
    }

    appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: event.type,
      status: 'rejected',
      reason: unexpectedRuntimeTurnFailureMessage,
      toolCallIds: Object.freeze([...finishedToolCallIds]),
      ...visibleMessageIdsForTurnOption(committedVisibleMessages),
      payloadSummary
    });
    appendTrace('raw_event_log_appended');
    appendTrace('runtime_turn_rejected');

    throw error;
  }
}

function visibleMessageIdsForTurnOption(
  messages: readonly ConversationLogRecord[]
): { readonly visibleMessageIds?: readonly string[] } {
  if (messages.length === 0) {
    return {};
  }

  return {
    visibleMessageIds: Object.freeze(messages.map((message) => message.id))
  };
}

function pluginStoreRevisionOption(
  result: AgentCapabilityToolCallResult
): { readonly pluginStoreRevision?: number } {
  if (result.status !== 'accepted') {
    return {};
  }

  const output = result.output;

  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return {};
  }

  const revision = (output as Readonly<Record<string, unknown>>)[
    'pluginStoreRevision'
  ];

  if (typeof revision !== 'number') {
    return {};
  }

  return {
    pluginStoreRevision: revision
  };
}

function decisionContextSessionIdFromEvidence(
  snapshot: RoleModelIOSnapshot
): string {
  return snapshot.inputEnvelope.decisionContext.sessionId;
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

function createPluginHostForTurn(options: {
  readonly capabilityHost: RuntimeCapabilityHost | undefined;
  readonly decisionContextSessionId: string;
  readonly logStore: RuntimeLogStore;
}): RuntimePluginHost {
  const sessionPaths = options.logStore.localRuntimeSessionPaths;

  return createDefaultProject02PluginHost({
    ...(options.capabilityHost === undefined
      ? {}
      : { capabilityHost: options.capabilityHost }),
    ...(sessionPaths === undefined ? {} : { storeRoot: sessionPaths.storeRoot }),
    sessionId: sessionPaths?.sessionId ?? options.decisionContextSessionId
  });
}

function createEmptyHealthResult(): RuntimeCapabilityHealthHostResult {
  return Object.freeze({
    snapshots: Object.freeze([]),
    evidence: Object.freeze([])
  } satisfies RuntimeCapabilityHealthHostResult);
}

async function capabilityHealthForTurn(options: {
  readonly capabilityHost: RuntimeCapabilityHost | undefined;
  readonly runtimeCapabilityContext: RuntimeCapabilityContext | undefined;
}): Promise<RuntimeCapabilityHealthHostResult> {
  if (
    options.capabilityHost === undefined ||
    options.runtimeCapabilityContext === undefined
  ) {
    return createEmptyHealthResult();
  }

  return await options.capabilityHost.health(options.runtimeCapabilityContext);
}

function healthResultRejectsTurn(options: {
  readonly capabilityHost: RuntimeCapabilityHost | undefined;
  readonly healthResult: RuntimeCapabilityHealthHostResult;
}): boolean {
  if (
    options.healthResult.evidence.some((evidence) =>
      healthEvidenceRejectsTurn(evidence)
    )
  ) {
    return true;
  }

  const rejectingCapabilityIds = healthRejectingCapabilityIds(
    options.capabilityHost
  );

  return options.healthResult.snapshots.some(
    (snapshot) =>
      snapshot.status === 'unavailable' &&
      rejectingCapabilityIds.has(snapshot.capabilityId)
  );
}

function healthEvidenceRejectsTurn(
  evidence: AgentCapabilityEvidenceSnapshot
): boolean {
  return evidence.evidenceKind === 'health' && evidence.status === 'failed';
}

function healthResultRejectionMessage(options: {
  readonly capabilityHost: RuntimeCapabilityHost | undefined;
  readonly healthResult: RuntimeCapabilityHealthHostResult;
}): string {
  const failedEvidenceSummary = options.healthResult.evidence.find((evidence) =>
    healthEvidenceRejectsTurn(evidence)
  )?.summary;

  if (failedEvidenceSummary !== undefined) {
    return failedEvidenceSummary;
  }

  const rejectingCapabilityIds = healthRejectingCapabilityIds(
    options.capabilityHost
  );
  const unavailableSnapshot = options.healthResult.snapshots.find(
    (snapshot) =>
      snapshot.status === 'unavailable' &&
      rejectingCapabilityIds.has(snapshot.capabilityId)
  );

  if (unavailableSnapshot !== undefined) {
    return `Capability health unavailable: ${unavailableSnapshot.summary}`;
  }

  return 'Capability health policy rejected the turn.';
}

function healthRejectingCapabilityIds(
  capabilityHost: RuntimeCapabilityHost | undefined
): ReadonlySet<string> {
  if (capabilityHost === undefined) {
    return new Set<string>();
  }

  const enabledCapabilityIds = new Set(capabilityHost.enabledCapabilityIds());

  return new Set(
    capabilityHost
      .registrySnapshot()
      .capabilities.filter(
        (registration) =>
          enabledCapabilityIds.has(registration.manifest.id) &&
          registration.manifest.runtimePolicy.failureBehavior.health ===
            'reject_turn'
      )
      .map((registration) => registration.manifest.id)
  );
}

function capabilityToolEvidenceFromRouting(
  results: readonly RoleModelCapabilityToolRoutingEvidence[]
): readonly AgentCapabilityEvidenceSnapshot[] {
  return Object.freeze(results.flatMap((routing) => routing.result.evidence));
}

function capabilityToolInvocationsFromRouting(
  results: readonly RoleModelCapabilityToolRoutingEvidence[]
): readonly AgentCapabilityToolInvocationSnapshot[] {
  return Object.freeze(
    results.map((routing) =>
      createAgentCapabilityToolInvocationSnapshot({
        ...routing.call,
        kind: 'agent_capability_tool_invocation_snapshot',
        result: routing.result
      })
    )
  );
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

function agentCapabilityTurnEvidenceOption(options: {
  readonly identity: RuntimeEventIdentity;
  readonly capabilityHost: RuntimeCapabilityHost | undefined;
  readonly contextItems: readonly AgentCapabilityContextItem[];
  readonly toolInvocations: readonly AgentCapabilityToolInvocationSnapshot[];
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
  readonly health: readonly AgentCapabilityHealthSnapshot[];
}): { readonly agentCapabilityTurnEvidence?: AgentCapabilityTurnEvidenceSnapshot } {
  if (options.capabilityHost === undefined) {
    return {};
  }

  const registry = options.capabilityHost.registrySnapshot();
  const enabledCapabilityIds = new Set(options.capabilityHost.enabledCapabilityIds());
  const healthStatuses = new Map(
    options.health.map((snapshot) => [snapshot.capabilityId, snapshot.status])
  );

  return {
    agentCapabilityTurnEvidence: createAgentCapabilityTurnEvidenceSnapshot({
      ...options.identity,
      kind: 'agent_capability_turn_evidence_snapshot',
      contractVersion: agentCapabilityContractVersion,
      capabilities: registry.capabilities.map((registration) => {
        const enabled = enabledCapabilityIds.has(registration.manifest.id);
        const healthStatus = healthStatuses.get(registration.manifest.id);

        return {
          capabilityId: registration.manifest.id,
          manifest: registration.manifest,
          providedTools: registration.providedTools,
          registeredLifecycleHooks: registration.registeredLifecycleHooks,
          installed: true,
          registered: true,
          enabled,
          availableForTurn: enabled,
          redactionLabels: registration.manifest.runtimePolicy.redactionLabels,
          ...(healthStatus === undefined ? {} : { healthStatus }),
          ...(registration.manifest.config.fingerprint === undefined
            ? {}
            : { configFingerprint: registration.manifest.config.fingerprint })
        };
      }),
      contextItems: options.contextItems,
      toolInvocations: options.toolInvocations,
      evidence: options.evidence,
      health: options.health
    })
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
