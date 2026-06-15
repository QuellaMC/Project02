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
} from '../core/conversation.ts';
import { buildUserTurnDecisionContext } from '../role-model/decision-context.ts';
import {
  runtimePluginContractVersion,
  createRuntimePluginToolInvocationSnapshot,
  createRuntimePluginTurnEvidenceSnapshot,
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
  type RuntimePluginContextItem,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginHealthSnapshot,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
  type RuntimePluginToolInvocationSnapshot,
  type RuntimePluginTurnEvidenceSnapshot,
  type RuntimePluginContext
} from '../plugins/types.ts';
import {
  runtimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginHealthHostResult
} from '../plugins/index.ts';
import {
  createDecisionContext,
  createRejectedRoleModelDecisionResult,
  getVisibleReplyToolCall,
  roleModelInvalidVisibleReplyRejectionReason,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelIOSnapshot
} from '../role-model/contracts.ts';
import {
  createRoleModelAdapterFromCharacterAgent,
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelPluginToolRoutingEvidence
} from '../role-model/loop.ts';
import {
  createDefaultProject02PluginHost,
  type RuntimePluginHost
} from '../plugins/index.ts';
import {
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent
} from './event.ts';
import { createRoleModelCommitValidationSnapshot } from './log.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RawEventLogPayloadSummary,
  RuntimeLogStore,
  RoleModelCommitValidationSnapshot,
  RuntimeTraceEntry,
  RuntimeTraceStepName
} from './log.ts';

const runtimePluginHealthRejectionReason = 'plugin_health_rejected';

export type LocalRuntimeUserMessageRejectionReason =
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | typeof runtimePluginHealthRejectionReason
  | typeof runtimePluginBeforeRoleModelCallRejectionReason
  | RoleModelDecisionRejectionReason;

export type RunLocalUserMessageEventOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly rawInput?: string;
  readonly agent?: CharacterAgent;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly pluginHost?: RuntimePluginHost;
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
  let runtimePluginContextForTurn: RuntimePluginContext | undefined;
  let runtimePluginHostForTurn: RuntimePluginHost | undefined;

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
    readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
    readonly runtimePluginContextItems?: readonly RuntimePluginContextItem[];
    readonly runtimePluginToolInvocations?: readonly RuntimePluginToolInvocationSnapshot[];
    readonly evidence?: RoleModelRawEvidence;
    readonly healthResult?: RuntimePluginHealthHostResult;
    readonly message: string;
    readonly rawKind: RawEventLogRecordInput['kind'];
    readonly rawReason: string;
    readonly reason: LocalRuntimeUserMessageRejectionReason;
    readonly runtimePluginContext?: RuntimePluginContext;
    readonly traceStep: RuntimeTraceStepName;
    readonly toolCallIds?: readonly string[];
    readonly visibleMessageIds?: readonly string[];
  }): Promise<LocalRuntimeUserMessageRejectedResult> {
    const evidence = optionsForRejection.evidence ?? {};
    const pluginHostForEvidence =
      runtimePluginHostForTurn ?? options.pluginHost;
    const healthResult =
      optionsForRejection.healthResult ??
      (await pluginHealthForTurn({
        pluginHost: pluginHostForEvidence,
        runtimePluginContext: optionsForRejection.runtimePluginContext
      }));
    const runtimePluginEvidence = combineRuntimePluginEvidence(
      optionsForRejection.runtimePluginEvidence ?? [],
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
      ...runtimePluginEvidenceOption(runtimePluginEvidence),
      ...runtimePluginTurnEvidenceOption({
        identity,
        pluginHost: pluginHostForEvidence,
        contextItems: optionsForRejection.runtimePluginContextItems ?? [],
        toolInvocations:
          optionsForRejection.runtimePluginToolInvocations ?? [],
        evidence: runtimePluginEvidence,
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
      ...runtimePluginEvidenceOption(runtimePluginEvidence),
      ...runtimePluginTurnEvidenceOption({
        identity,
        pluginHost: pluginHostForEvidence,
        contextItems: optionsForRejection.runtimePluginContextItems ?? [],
        toolInvocations:
          optionsForRejection.runtimePluginToolInvocations ?? [],
        evidence: runtimePluginEvidence,
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
    runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[],
    runtimePluginContextItems?: readonly RuntimePluginContextItem[],
    runtimePluginToolInvocations?: readonly RuntimePluginToolInvocationSnapshot[],
    runtimePluginContext?: RuntimePluginContext
  ): Promise<LocalRuntimeUserMessageRejectedResult> {
    return appendRejectedResult({
      evidence,
      ...(runtimePluginEvidence === undefined ? {} : { runtimePluginEvidence }),
      ...(runtimePluginContextItems === undefined
        ? {}
        : { runtimePluginContextItems }),
      ...(runtimePluginToolInvocations === undefined
        ? {}
        : { runtimePluginToolInvocations }),
      message: rejection.details ?? rejection.reason,
      rawKind: 'commit_validation_rejected',
      rawReason: rejection.reason,
      reason: rejection.reason,
      ...(runtimePluginContext === undefined
        ? {}
        : { runtimePluginContext }),
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
    readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
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
        ...runtimePluginEvidenceOption(
          optionsForReply.runtimePluginEvidence
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
      ...runtimePluginEvidenceOption(
        optionsForReply.runtimePluginEvidence
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
    readonly call: RuntimePluginToolCall;
  }): void {
    appendTrace('tool_call_started');
    appendRawEvent({
      ...identity,
      kind: 'tool_call_started',
      eventType: event.type,
      toolCallId: optionsForTool.callId,
      toolRound: optionsForTool.round,
      toolName: optionsForTool.call.toolName,
      toolPluginId: optionsForTool.call.pluginId,
      toolInput: optionsForTool.call.input,
      payloadSummary
    });
  }

  function appendToolCallFinished(optionsForTool: {
    readonly callId: string;
    readonly round: number;
    readonly pluginId: string;
    readonly toolName: string;
    readonly result: RuntimePluginToolCallResult;
  }): void {
    appendTrace('tool_call_finished');
    appendRawEvent({
      ...identity,
      kind: 'tool_call_finished',
      eventType: event.type,
      toolCallId: optionsForTool.callId,
      toolRound: optionsForTool.round,
      toolName: optionsForTool.toolName,
      toolPluginId: optionsForTool.pluginId,
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
    const runtimePluginContext = createRuntimePluginContext({
      ...identity,
      sessionId: decisionContext.sessionId,
      eventType: event.type,
      currentUserMessage: event.payload.currentUserMessage,
      character: decisionContext.characterSnapshot
    });
    runtimePluginContextForTurn = runtimePluginContext;
    const pluginHost = createPluginHostForTurn({
      pluginHost: options.pluginHost,
      decisionContextSessionId: decisionContext.sessionId,
      logStore: options.logStore
    });
    runtimePluginHostForTurn = pluginHost;
    const beforeRoleModelCallResult = await pluginHost.beforeRoleModelCall(
      runtimePluginContext
    );

    if (beforeRoleModelCallResult.status === 'rejected') {
      return await appendRejectedResult({
        runtimePluginEvidence: beforeRoleModelCallResult.evidence,
        message: beforeRoleModelCallResult.message,
        rawKind: runtimePluginBeforeRoleModelCallRejectionReason,
        rawReason: beforeRoleModelCallResult.message,
        reason: beforeRoleModelCallResult.reason,
        runtimePluginContext,
        traceStep: runtimePluginBeforeRoleModelCallRejectionReason
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
      pluginContextItems: beforeRoleModelCallResult.contextItems
    });
    const roleModelResult = await runRoleModelLoop({
      event,
      decisionContext: roleModelDecisionContext,
      pluginToolDefinitions: pluginHost.pluginToolDefinitions(),
      pluginToolHost: pluginHost,
      runtimePluginContext,
      resolveToolPluginId(toolName) {
        return pluginHost.resolveToolPluginId(toolName);
      },
      onPluginToolCallStarted(progressEvent) {
        appendToolCallStarted({
          callId: progressEvent.callId,
          round: progressEvent.round,
          call: progressEvent.call
        });
      },
      async onPluginToolCallCompleted(progressEvent) {
        appendToolCallFinished({
          callId: progressEvent.callId,
          round: progressEvent.round,
          pluginId: progressEvent.pluginId,
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
      async onPluginToolCallsRequested(progressEvent) {
        await emitProgress({
          kind: 'tool_calls_requested',
          round: progressEvent.round,
          toolNames: progressEvent.toolNames
        });
      },
      async onInterimVisibleReply(progressEvent) {
        await appendVisibleReplyForDecision({
          runtimePluginEvidence: beforeRoleModelCallResult.evidence,
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
    const roleModelPluginEvidence = combineRuntimePluginEvidence(
      beforeRoleModelCallResult.evidence,
      pluginToolEvidenceFromRouting(roleModelResult.pluginToolResults)
    );
    const roleModelPluginToolInvocations =
      pluginToolInvocationsFromRouting(roleModelResult.pluginToolResults);

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
        roleModelPluginEvidence,
        beforeRoleModelCallResult.contextItems,
        roleModelPluginToolInvocations,
        runtimePluginContext
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
            roleModelPluginEvidence,
            beforeRoleModelCallResult.contextItems,
            roleModelPluginToolInvocations,
            runtimePluginContext
          );
        }

        throw error;
      }
    }

    const preCommitHealthResult = await pluginHost.health(runtimePluginContext);

    if (
      healthResultRejectsTurn({
        pluginHost,
        healthResult: preCommitHealthResult
      })
    ) {
      return await appendRejectedResult({
        runtimePluginEvidence: roleModelPluginEvidence,
        runtimePluginContextItems: beforeRoleModelCallResult.contextItems,
        runtimePluginToolInvocations: roleModelPluginToolInvocations,
        evidence: {
          ...roleModelEvidence
        },
        healthResult: preCommitHealthResult,
        message: healthResultRejectionMessage({
          pluginHost,
          healthResult: preCommitHealthResult
        }),
        rawKind: 'commit_validation_rejected',
        rawReason: runtimePluginHealthRejectionReason,
        reason: runtimePluginHealthRejectionReason,
        runtimePluginContext,
        traceStep: 'commit_validation_rejected',
        ...visibleMessageIdsForTurnOption(committedVisibleMessages)
      });
    }

    const turn =
      visibleReplyText === undefined
        ? undefined
        : await appendVisibleReplyForDecision({
            runtimePluginEvidence: roleModelPluginEvidence,
            final: true,
            roleModelIOSnapshot: roleModelResult.ioSnapshot,
            parsedRoleModelDecisionSnapshot: roleModelResult.parsedDecisionSnapshot,
            text: visibleReplyText
          });
    const afterCommitPluginContext =
      createRuntimePluginAfterTurnCommittedContext({
        ...identity,
        sessionId: decisionContext.sessionId,
        eventType: event.type,
        currentUserMessage: event.payload.currentUserMessage,
        character: decisionContext.characterSnapshot,
        committedAt: options.committedAt ?? options.event.createdAt,
        visibleMessages: committedVisibleMessages
      });

    const afterTurnCommittedResult =
      await pluginHost.afterTurnCommitted(afterCommitPluginContext);
    const completedPluginEvidence = combineRuntimePluginEvidence(
      roleModelPluginEvidence,
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
      ...runtimePluginEvidenceOption(completedPluginEvidence),
      ...runtimePluginTurnEvidenceOption({
        identity,
        pluginHost,
        contextItems: beforeRoleModelCallResult.contextItems,
        toolInvocations: roleModelPluginToolInvocations,
        evidence: completedPluginEvidence,
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
        ...(runtimePluginContextForTurn === undefined
          ? {}
          : { runtimePluginContext: runtimePluginContextForTurn }),
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
        ...(runtimePluginContextForTurn === undefined
          ? {}
          : { runtimePluginContext: runtimePluginContextForTurn }),
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
  result: RuntimePluginToolCallResult
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
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly decisionContextSessionId: string;
  readonly logStore: RuntimeLogStore;
}): RuntimePluginHost {
  if (options.pluginHost !== undefined) {
    return options.pluginHost;
  }

  const sessionPaths = options.logStore.localRuntimeSessionPaths;

  return createDefaultProject02PluginHost({
    ...(sessionPaths === undefined ? {} : { storeRoot: sessionPaths.storeRoot }),
    sessionId: sessionPaths?.sessionId ?? options.decisionContextSessionId
  });
}

function createEmptyHealthResult(): RuntimePluginHealthHostResult {
  return Object.freeze({
    snapshots: Object.freeze([]),
    evidence: Object.freeze([])
  } satisfies RuntimePluginHealthHostResult);
}

async function pluginHealthForTurn(options: {
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly runtimePluginContext: RuntimePluginContext | undefined;
}): Promise<RuntimePluginHealthHostResult> {
  if (
    options.pluginHost === undefined ||
    options.runtimePluginContext === undefined
  ) {
    return createEmptyHealthResult();
  }

  return await options.pluginHost.health(options.runtimePluginContext);
}

function healthResultRejectsTurn(options: {
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly healthResult: RuntimePluginHealthHostResult;
}): boolean {
  if (
    options.healthResult.evidence.some((evidence) =>
      healthEvidenceRejectsTurn(evidence)
    )
  ) {
    return true;
  }

  const rejectingPluginIds = healthRejectingPluginIds(
    options.pluginHost
  );

  return options.healthResult.snapshots.some(
    (snapshot) =>
      snapshot.status === 'unavailable' &&
      rejectingPluginIds.has(snapshot.pluginId)
  );
}

function healthEvidenceRejectsTurn(
  evidence: RuntimePluginEvidenceSnapshot
): boolean {
  return evidence.evidenceKind === 'health' && evidence.status === 'failed';
}

function healthResultRejectionMessage(options: {
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly healthResult: RuntimePluginHealthHostResult;
}): string {
  const failedEvidenceSummary = options.healthResult.evidence.find((evidence) =>
    healthEvidenceRejectsTurn(evidence)
  )?.summary;

  if (failedEvidenceSummary !== undefined) {
    return failedEvidenceSummary;
  }

  const rejectingPluginIds = healthRejectingPluginIds(
    options.pluginHost
  );
  const unavailableSnapshot = options.healthResult.snapshots.find(
    (snapshot) =>
      snapshot.status === 'unavailable' &&
      rejectingPluginIds.has(snapshot.pluginId)
  );

  if (unavailableSnapshot !== undefined) {
    return `Plugin health unavailable: ${unavailableSnapshot.summary}`;
  }

  return 'Plugin health policy rejected the turn.';
}

function healthRejectingPluginIds(
  pluginHost: RuntimePluginHost | undefined
): ReadonlySet<string> {
  if (pluginHost === undefined) {
    return new Set<string>();
  }

  const enabledPluginIds = new Set(pluginHost.enabledPluginIds());

  return new Set(
    pluginHost
      .registrySnapshot()
      .plugins.filter(
        (registration) =>
          enabledPluginIds.has(registration.manifest.id) &&
          registration.manifest.runtimePolicy.failureBehavior.health ===
            'reject_turn'
      )
      .map((registration) => registration.manifest.id)
  );
}

function pluginToolEvidenceFromRouting(
  results: readonly RoleModelPluginToolRoutingEvidence[]
): readonly RuntimePluginEvidenceSnapshot[] {
  return Object.freeze(results.flatMap((routing) => routing.result.evidence));
}

function pluginToolInvocationsFromRouting(
  results: readonly RoleModelPluginToolRoutingEvidence[]
): readonly RuntimePluginToolInvocationSnapshot[] {
  return Object.freeze(
    results.map((routing) =>
      createRuntimePluginToolInvocationSnapshot({
        ...routing.call,
        kind: 'runtime_plugin_tool_invocation_snapshot',
        result: routing.result
      })
    )
  );
}

function combineRuntimePluginEvidence(
  ...evidenceGroups: readonly (readonly RuntimePluginEvidenceSnapshot[])[]
): readonly RuntimePluginEvidenceSnapshot[] {
  return Object.freeze(evidenceGroups.flatMap((evidence) => evidence));
}

function runtimePluginEvidenceOption(
  evidence: readonly RuntimePluginEvidenceSnapshot[] | undefined
): { readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[] } {
  if (evidence === undefined || evidence.length === 0) {
    return {};
  }

  return {
    runtimePluginEvidence: Object.freeze([...evidence])
  };
}

function runtimePluginTurnEvidenceOption(options: {
  readonly identity: RuntimeEventIdentity;
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly toolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly health: readonly RuntimePluginHealthSnapshot[];
}): { readonly runtimePluginTurnEvidence?: RuntimePluginTurnEvidenceSnapshot } {
  if (options.pluginHost === undefined) {
    return {};
  }

  const registry = options.pluginHost.registrySnapshot();
  const enabledPluginIds = new Set(options.pluginHost.enabledPluginIds());
  const healthStatuses = new Map(
    options.health.map((snapshot) => [snapshot.pluginId, snapshot.status])
  );

  return {
    runtimePluginTurnEvidence: createRuntimePluginTurnEvidenceSnapshot({
      ...options.identity,
      kind: 'runtime_plugin_turn_evidence_snapshot',
      contractVersion: runtimePluginContractVersion,
      plugins: registry.plugins.map((registration) => {
        const enabled = enabledPluginIds.has(registration.manifest.id);
        const healthStatus = healthStatuses.get(registration.manifest.id);

        return {
          pluginId: registration.manifest.id,
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
