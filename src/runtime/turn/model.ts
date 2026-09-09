import {
  createRuntimePluginContext,
  createRuntimePluginToolInvocationSnapshot,
  runtimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginContext,
  type RuntimePluginContextItem,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolInvocationSnapshot,
} from '../../plugins/api/index.ts';
import type {
  RuntimePluginBeforeRoleModelCallCompletedResult,
  RuntimePluginHealthHostResult,
  RuntimePluginHost,
} from '../../plugins/index.ts';
import {
  conversationHistoryWindow,
  conversationTurnVisibleMessages,
  createDecisionContext,
  createRejectedRoleModelDecisionResult,
  createTodayRuntimeNote,
  roleModelCommitValidationFailureRejectionReason,
  selectConversationHistoryWindow,
  type ConversationTurn,
  type DecisionContext,
} from '../../role-model/index.ts';
import {localUserSpeaker, type VisibleMessage} from '../../core/index.ts';
import {conversationHistoryFromRawEvents} from '../evidence/conversation-history.ts';
import {defaultProject02ContextWindowTokens} from '../config/types.ts';
import {
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelLoopResult,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolRoutingEvidence,
  type RoleModelVisibleReplyEvent,
} from '../../role-model/index.ts';
import {
  appendRoleModelRound,
  appendToolCallFinished,
  appendToolCallStarted,
  appendVisibleReplyForDecision,
  commitUserMessage,
  completeRuntimeTurn,
  emitProgress,
  initializeRuntimeTurnEvidence,
  visibleMessageIdsForTurnOption,
} from './commit.ts';
import {
  type LocalRuntimeUserMessageRejectedResult,
  type LocalRuntimeUserMessageResult,
  type RunLocalUserMessageEventOptions,
  type RuntimeTurnState,
  runtimePluginHealthRejectionReason,
} from './contracts.ts';
import {createRuntimeTurnState} from './input.ts';
import {
  appendRejectedResult,
  combineRuntimePluginEvidence,
  createRejectedCommitValidationSnapshot,
  handleRuntimeTurnFailure,
  healthResultRejectionMessage,
  healthResultRejectsTurn,
} from './rejection.ts';

type PreparedRuntimeTurn = {
  readonly decisionContext: DecisionContext;
  readonly conversationHistory: readonly ConversationTurn[];
  readonly runtimePluginContext: RuntimePluginContext;
  readonly pluginHost: RuntimePluginHost;
  readonly beforeRoleModelCallResult: RuntimePluginBeforeRoleModelCallCompletedResult;
  /** Every plugin item the model was shown this turn, whichever frame it rendered in. */
  readonly pluginContextItems: readonly RuntimePluginContextItem[];
};

type PrepareRuntimeTurnResult =
  | {readonly status: 'prepared'; readonly turn: PreparedRuntimeTurn}
  | {
      readonly status: 'rejected';
      readonly result: LocalRuntimeUserMessageRejectedResult;
    };

type RunRuntimeModelResult =
  | {
      readonly status: 'completed';
      readonly result: RoleModelLoopResult;
    }
  | {
      readonly status: 'rejected';
      readonly result: LocalRuntimeUserMessageRejectedResult;
    };

export async function runSerializedLocalUserMessageEvent(
  options: RunLocalUserMessageEventOptions,
): Promise<LocalRuntimeUserMessageResult> {
  const state = createRuntimeTurnState(options);

  initializeRuntimeTurnEvidence(state);
  try {
    return await runPreparedLocalRuntimeTurn(state);
  } catch (error: unknown) {
    return await handleRuntimeTurnFailure(state, error);
  } finally {
    // The turn is over once everything it announced has been heard.
    await state.progress;
  }
}

async function runPreparedLocalRuntimeTurn(
  state: RuntimeTurnState,
): Promise<LocalRuntimeUserMessageResult> {
  if (state.normalizedEventResult.status === 'rejected') {
    return await appendRejectedResult(state, {
      message: state.normalizedEventResult.message,
      reason: 'input_validation_rejected',
      recordReason: 'input_validation_rejected',
    });
  }

  const prepared = await prepareRuntimeTurn(state);

  if (prepared.status === 'rejected') {
    return prepared.result;
  }

  const model = await runRuntimeModel(state, prepared.turn);

  if (model.status === 'rejected') {
    return model.result;
  }

  return await validateAndCommitRuntimeModelResult(
    state,
    prepared.turn,
    model.result,
  );
}

async function prepareRuntimeTurn(
  state: RuntimeTurnState,
): Promise<PrepareRuntimeTurnResult> {
  // History first, then commit: the window is the conversation before this
  // turn, and the current user message rides the event payload.
  const history = conversationHistoryFromRawEvents(
    state.options.logStore.rawEvents(),
  );
  const conversationHistory = selectConversationHistoryWindow(history.turns, {
    contextWindowTokens:
      state.options.contextWindowTokens ?? defaultProject02ContextWindowTokens,
  });
  const decisionContext = createDecisionContext({
    sessionId: state.options.session.id,
    characterSnapshot: state.options.session.character,
    historyWindow: conversationHistoryWindow(conversationHistory),
    ...(history.summary === undefined ? {} : {contextSummary: history.summary}),
  });
  const windowVisibleMessageIds = conversationHistory.flatMap(turn =>
    conversationTurnVisibleMessages(turn).map(message => message.id),
  );

  await commitUserMessage(state);

  const runtimePluginContext = createRuntimePluginContext({
    ...state.identity,
    sessionId: decisionContext.sessionId,
    eventType: state.event.type,
    currentUserMessage: state.event.payload.currentUserMessage,
    // What the model sees this turn: the replayed window plus everything
    // committed so far, read live because interim replies land while
    // the turn is still running.
    recentVisibleMessageIds: () => [
      ...windowVisibleMessageIds,
      ...state.committedVisibleMessages.map(message => message.id),
    ],
    character: decisionContext.characterSnapshot,
  });
  const pluginHost = state.options.pluginHost;

  state.runtimePluginContextForTurn = runtimePluginContext;
  const beforeRoleModelCallResult =
    await pluginHost.beforeRoleModelCall(runtimePluginContext);

  if (beforeRoleModelCallResult.status === 'rejected') {
    return {
      status: 'rejected',
      result: await appendRejectedResult(state, {
        runtimePluginEvidence: beforeRoleModelCallResult.evidence,
        message: beforeRoleModelCallResult.message,
        reason: beforeRoleModelCallResult.reason,
        recordReason: runtimePluginBeforeRoleModelCallRejectionReason,
        runtimePluginContext,
        // The terminal event must reference the already-committed user
        // message, or later evidence reads rebuild a conversation missing it.
        ...visibleMessageIdsForTurnOption(state.committedVisibleMessages),
      }),
    };
  }

  return {
    status: 'prepared',
    turn: {
      decisionContext,
      conversationHistory,
      runtimePluginContext,
      pluginHost,
      beforeRoleModelCallResult,
      pluginContextItems: [
        ...beforeRoleModelCallResult.runtimeNotes,
        ...beforeRoleModelCallResult.contextItems,
      ],
    },
  };
}

async function runRuntimeModel(
  state: RuntimeTurnState,
  prepared: PreparedRuntimeTurn,
): Promise<RunRuntimeModelResult> {
  const roleModelDecisionContext = createDecisionContext({
    sessionId: prepared.decisionContext.sessionId,
    characterSnapshot: prepared.decisionContext.characterSnapshot,
    historyWindow: prepared.decisionContext.historyWindow,
    ...(prepared.decisionContext.contextSummary === undefined
      ? {}
      : {contextSummary: prepared.decisionContext.contextSummary}),
    runtimeNotes: [
      createTodayRuntimeNote(
        state.event.createdAt,
        state.options.timeZone ??
          Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
      ...prepared.beforeRoleModelCallResult.runtimeNotes.map(item => ({
        id: item.id,
        text: item.text,
        pluginId: item.pluginId,
      })),
    ],
    pluginContextItems: prepared.beforeRoleModelCallResult.contextItems,
    curatedContextSections: prepared.beforeRoleModelCallResult.curatedContext,
  });
  const userDisplayName = state.options.session.userSpeaker.displayName;
  const result = await runRoleModelLoop({
    event: state.event,
    decisionContext: roleModelDecisionContext,
    ...(state.options.maxToolRounds === undefined
      ? {}
      : {maxToolRounds: state.options.maxToolRounds}),
    pluginToolDefinitions: prepared.pluginHost.pluginToolDefinitions(),
    pluginToolHost: prepared.pluginHost,
    conversationHistory: prepared.conversationHistory,
    runtimePluginContext: prepared.runtimePluginContext,
    ...(state.options.characterPersonaSections === undefined
      ? {}
      : {personaSections: state.options.characterPersonaSections}),
    // The default label is a transcript speaker, not a name the prompt uses.
    ...(userDisplayName === localUserSpeaker.displayName
      ? {}
      : {userDisplayName}),
    ...(state.options.characterRef === undefined
      ? {}
      : {characterRef: state.options.characterRef}),
    onRound(event) {
      appendRoleModelRound(state, event);
    },
    onPluginToolCallStarted(event) {
      appendToolCallStarted(state, event);
    },
    async onPluginToolCallCompleted(event) {
      await recordPluginToolCallCompleted(state, event);
    },
    async onPluginToolCallsRequested(event) {
      await recordPluginToolCallsRequested(state, event);
    },
    async onVisibleReply(event) {
      return await commitVisibleReply(state, prepared, event);
    },
    onReplyDelta(event) {
      // A draft is fired, never awaited: the model keeps writing meanwhile.
      void emitProgress(state, {kind: 'reply_delta', ...event});
    },
    onReplyWithdrawn(event) {
      void emitProgress(state, {kind: 'reply_withdrawn', ...event});
    },
    ...roleModelLoopAdapterOption(state.options),
  });

  return {status: 'completed', result};
}

async function recordPluginToolCallCompleted(
  state: RuntimeTurnState,
  event: RoleModelPluginToolCallCompletedEvent,
): Promise<void> {
  appendToolCallFinished(state, {
    callId: event.callId,
    dispatchedToHost: event.dispatchedToHost,
    round: event.round,
    pluginId: event.pluginId,
    toolName: event.toolName,
    result: event.result,
  });
  await emitProgress(state, {
    kind: 'tool_call_completed',
    round: event.round,
    status: event.status,
    toolName: event.toolName,
  });
}

async function recordPluginToolCallsRequested(
  state: RuntimeTurnState,
  event: RoleModelPluginToolCallsRequestedEvent,
): Promise<void> {
  await emitProgress(state, {
    kind: 'tool_calls_requested',
    round: event.round,
    toolNames: event.toolNames,
  });
}

async function commitVisibleReply(
  state: RuntimeTurnState,
  prepared: PreparedRuntimeTurn,
  event: RoleModelVisibleReplyEvent,
): Promise<VisibleMessage> {
  return await appendVisibleReplyForDecision(state, {
    runtimePluginEvidence: prepared.beforeRoleModelCallResult.evidence,
    sessionId: prepared.decisionContext.sessionId,
    round: event.round,
    text: event.text,
    draftId: event.draftId,
  });
}

async function validateAndCommitRuntimeModelResult(
  state: RuntimeTurnState,
  prepared: PreparedRuntimeTurn,
  roleModelResult: RoleModelLoopResult,
): Promise<LocalRuntimeUserMessageResult> {
  const roleModelPluginEvidence = combineRuntimePluginEvidence(
    prepared.beforeRoleModelCallResult.evidence,
    pluginToolEvidenceFromRouting(roleModelResult.pluginToolResults),
  );
  const roleModelPluginToolInvocations = pluginToolInvocationsFromRouting(
    roleModelResult.pluginToolResults,
  );

  if (roleModelResult.status === 'rejected') {
    return await rejectRoleModelResult({
      state,
      prepared,
      roleModelResult,
      roleModelPluginEvidence,
      roleModelPluginToolInvocations,
    });
  }

  const preCommitHealthResult = await prepared.pluginHost.health(
    prepared.runtimePluginContext,
  );

  if (
    healthResultRejectsTurn({
      pluginHost: prepared.pluginHost,
      healthResult: preCommitHealthResult,
    })
  ) {
    return await rejectPreCommitHealth({
      state,
      prepared,
      round: roleModelResult.round,
      roleModelPluginEvidence,
      roleModelPluginToolInvocations,
      preCommitHealthResult,
    });
  }

  return await completeRuntimeTurn({
    state,
    decisionContext: prepared.decisionContext,
    pluginHost: prepared.pluginHost,
    contextItems: prepared.pluginContextItems,
    roleModelResult,
    roleModelPluginEvidence,
    roleModelPluginToolInvocations,
    preCommitHealthResult,
  });
}

async function rejectRoleModelResult(options: {
  readonly state: RuntimeTurnState;
  readonly prepared: PreparedRuntimeTurn;
  readonly roleModelResult: Extract<RoleModelLoopResult, {status: 'rejected'}>;
  readonly roleModelPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly roleModelPluginToolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
}): Promise<LocalRuntimeUserMessageRejectedResult> {
  const {state, prepared, roleModelResult} = options;
  const {rejection} = roleModelResult;

  return await appendRejectedResult(state, {
    runtimePluginEvidence: options.roleModelPluginEvidence,
    runtimePluginContextItems: prepared.pluginContextItems,
    runtimePluginToolInvocations: options.roleModelPluginToolInvocations,
    round: roleModelResult.round,
    commitValidation: createRejectedCommitValidationSnapshot({
      identity: state.identity,
      rejection,
      sessionId: prepared.decisionContext.sessionId,
    }),
    message: rejection.details ?? rejection.reason,
    reason: rejection.reason,
    recordReason: rejection.reason,
    runtimePluginContext: prepared.runtimePluginContext,
    toolCallIds: Object.freeze([...state.finishedToolCallIds]),
    ...visibleMessageIdsForTurnOption(state.committedVisibleMessages),
  });
}

async function rejectPreCommitHealth(options: {
  readonly state: RuntimeTurnState;
  readonly prepared: PreparedRuntimeTurn;
  readonly round: number;
  readonly roleModelPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly roleModelPluginToolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
  readonly preCommitHealthResult: RuntimePluginHealthHostResult;
}): Promise<LocalRuntimeUserMessageRejectedResult> {
  const message = healthResultRejectionMessage({
    pluginHost: options.prepared.pluginHost,
    healthResult: options.preCommitHealthResult,
  });
  const rejection = createRejectedRoleModelDecisionResult(
    roleModelCommitValidationFailureRejectionReason,
    message,
  ).rejection;

  return await appendRejectedResult(options.state, {
    runtimePluginEvidence: options.roleModelPluginEvidence,
    runtimePluginContextItems: options.prepared.pluginContextItems,
    runtimePluginToolInvocations: options.roleModelPluginToolInvocations,
    round: options.round,
    commitValidation: createRejectedCommitValidationSnapshot({
      identity: options.state.identity,
      rejection,
      sessionId: options.prepared.decisionContext.sessionId,
    }),
    healthResult: options.preCommitHealthResult,
    message,
    reason: runtimePluginHealthRejectionReason,
    recordReason: roleModelCommitValidationFailureRejectionReason,
    runtimePluginContext: options.prepared.runtimePluginContext,
    toolCallIds: Object.freeze([...options.state.finishedToolCallIds]),
    ...visibleMessageIdsForTurnOption(options.state.committedVisibleMessages),
  });
}

function roleModelLoopAdapterOption(options: RunLocalUserMessageEventOptions): {
  readonly adapter?: RoleModelAdapter;
} {
  return options.roleModelAdapter === undefined
    ? {}
    : {adapter: options.roleModelAdapter};
}

function pluginToolEvidenceFromRouting(
  results: readonly RoleModelPluginToolRoutingEvidence[],
): readonly RuntimePluginEvidenceSnapshot[] {
  return Object.freeze(results.flatMap(routing => routing.result.evidence));
}

function pluginToolInvocationsFromRouting(
  results: readonly RoleModelPluginToolRoutingEvidence[],
): readonly RuntimePluginToolInvocationSnapshot[] {
  return Object.freeze(
    results.map(routing =>
      createRuntimePluginToolInvocationSnapshot({
        ...routing.call,
        kind: 'runtime_plugin_tool_invocation_snapshot',
        result: routing.result,
      }),
    ),
  );
}
