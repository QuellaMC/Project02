import {buildUserTurnDecisionContext} from '../../role-model/index.ts';
import {
  createRuntimePluginContext,
  createRuntimePluginToolInvocationSnapshot,
  runtimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginContext,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolInvocationSnapshot,
} from '../../plugins/api/index.ts';
import type {
  RuntimePluginBeforeRoleModelCallCompletedResult,
  RuntimePluginHealthHostResult,
  RuntimePluginHost,
} from '../../plugins/index.ts';
import {
  createDecisionContext,
  createRejectedRoleModelDecisionResult,
  createTodayRuntimeNote,
  roleModelCommitValidationFailureRejectionReason,
  type DecisionContext,
} from '../../role-model/index.ts';
import {localUserSpeaker} from '../../core/index.ts';
import {
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelLoopResult,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolRoutingEvidence,
  type RoleModelVisibleReplyEvent,
} from '../../role-model/index.ts';
import {
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
  type RoleModelRawEvidence,
  type RunLocalUserMessageEventOptions,
  type RuntimeTurnState,
  runtimePluginHealthRejectionReason,
} from './contracts.ts';
import {createRuntimeTurnState} from './input.ts';
import {
  appendRejectedResult,
  appendRoleModelRejectedResult,
  combineRuntimePluginEvidence,
  createRejectedCommitValidationSnapshot,
  handleRuntimeTurnFailure,
  healthResultRejectionMessage,
  healthResultRejectsTurn,
} from './rejection.ts';

type PreparedRuntimeTurn = {
  readonly decisionContext: DecisionContext;
  readonly runtimePluginContext: RuntimePluginContext;
  readonly pluginHost: RuntimePluginHost;
  readonly beforeRoleModelCallResult: RuntimePluginBeforeRoleModelCallCompletedResult;
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
  }
}

async function runPreparedLocalRuntimeTurn(
  state: RuntimeTurnState,
): Promise<LocalRuntimeUserMessageResult> {
  if (state.normalizedEventResult.status === 'rejected') {
    return await appendRejectedResult(state, {
      message: state.normalizedEventResult.message,
      rawKind: 'input_validation_rejected',
      rawReason: state.normalizedEventResult.message,
      reason: 'input_validation_rejected',
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
  // Context first, then commit: recentVisibleMessages means the conversation
  // before this turn, and the current user message rides the event payload.
  const decisionContext = buildUserTurnDecisionContext({
    session: state.options.session,
  });

  await commitUserMessage(state);

  const runtimePluginContext = createRuntimePluginContext({
    ...state.identity,
    sessionId: decisionContext.sessionId,
    eventType: state.event.type,
    currentUserMessage: state.event.payload.currentUserMessage,
    // What the model sees this turn: the recent window plus everything
    // committed so far, read live because interim replies land while
    // the turn is still running.
    recentVisibleMessageIds: () =>
      [
        ...decisionContext.recentVisibleMessages,
        ...state.committedVisibleMessages,
      ].map(message => message.id),
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
        rawKind: runtimePluginBeforeRoleModelCallRejectionReason,
        rawReason: beforeRoleModelCallResult.message,
        reason: beforeRoleModelCallResult.reason,
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
      runtimePluginContext,
      pluginHost,
      beforeRoleModelCallResult,
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
    recentVisibleMessages: prepared.decisionContext.recentVisibleMessages,
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
    preparedConfigEffectsByToolCallId: state.preparedConfigEffectsByToolCallId,
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
    onPluginToolCallStarted(event) {
      recordPluginToolCallStarted(state, event);
    },
    async onPluginToolCallCompleted(event) {
      await recordPluginToolCallCompleted(state, event);
    },
    async onPluginToolCallsRequested(event) {
      await recordPluginToolCallsRequested(state, event);
    },
    async onVisibleReply(event) {
      await commitVisibleReply(state, prepared, event);
    },
    ...roleModelLoopAdapterOption(state.options),
  });

  return {status: 'completed', result};
}

function recordPluginToolCallStarted(
  state: RuntimeTurnState,
  event: RoleModelPluginToolCallStartedEvent,
): void {
  state.startedPluginToolCalls.set(event.callId, event.call);
  appendToolCallStarted(state, {
    callId: event.callId,
    round: event.round,
    call: event.call,
    roleModelIOSnapshot: event.ioSnapshot,
    parsedRoleModelDecisionSnapshot: event.parsedDecisionSnapshot,
  });
}

async function recordPluginToolCallCompleted(
  state: RuntimeTurnState,
  event: RoleModelPluginToolCallCompletedEvent,
): Promise<void> {
  const call = state.startedPluginToolCalls.get(event.callId);

  if (call === undefined) {
    throw new Error(
      `Completed plugin tool call is missing start evidence: ${event.callId}.`,
    );
  }

  state.finishedPluginToolResults.push(
    Object.freeze({
      callId: event.callId,
      call,
      dispatchedToHost: event.dispatchedToHost,
      result: event.result,
    } satisfies RoleModelPluginToolRoutingEvidence),
  );
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
): Promise<void> {
  await appendVisibleReplyForDecision(state, {
    runtimePluginEvidence: prepared.beforeRoleModelCallResult.evidence,
    roleModelIOSnapshot: event.ioSnapshot,
    parsedRoleModelDecisionSnapshot: event.parsedDecisionSnapshot,
    round: event.round,
    text: event.text,
  });
}

async function validateAndCommitRuntimeModelResult(
  state: RuntimeTurnState,
  prepared: PreparedRuntimeTurn,
  roleModelResult: RoleModelLoopResult,
): Promise<LocalRuntimeUserMessageResult> {
  const roleModelEvidence = {
    roleModelIOSnapshot: roleModelResult.ioSnapshot,
    parsedRoleModelDecisionSnapshot: roleModelResult.parsedDecisionSnapshot,
  } satisfies RoleModelRawEvidence;
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
      roleModelEvidence,
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
      roleModelEvidence,
      roleModelPluginEvidence,
      roleModelPluginToolInvocations,
      preCommitHealthResult,
    });
  }

  return await completeRuntimeTurn({
    state,
    decisionContext: prepared.decisionContext,
    pluginHost: prepared.pluginHost,
    contextItems: prepared.beforeRoleModelCallResult.contextItems,
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
  readonly roleModelEvidence: RoleModelRawEvidence;
  readonly roleModelPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly roleModelPluginToolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
}): Promise<LocalRuntimeUserMessageRejectedResult> {
  const {state, prepared, roleModelResult} = options;
  const commitValidation = createRejectedCommitValidationSnapshot({
    identity: state.identity,
    rejection: roleModelResult.rejection,
    sessionId: prepared.decisionContext.sessionId,
  });

  return await appendRoleModelRejectedResult(
    state,
    roleModelResult.rejection,
    {...options.roleModelEvidence, commitValidation},
    options.roleModelPluginEvidence,
    prepared.beforeRoleModelCallResult.contextItems,
    options.roleModelPluginToolInvocations,
    prepared.runtimePluginContext,
  );
}

async function rejectPreCommitHealth(options: {
  readonly state: RuntimeTurnState;
  readonly prepared: PreparedRuntimeTurn;
  readonly roleModelEvidence: RoleModelRawEvidence;
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
    runtimePluginContextItems:
      options.prepared.beforeRoleModelCallResult.contextItems,
    runtimePluginToolInvocations: options.roleModelPluginToolInvocations,
    evidence: {
      ...options.roleModelEvidence,
      commitValidation: createRejectedCommitValidationSnapshot({
        identity: options.state.identity,
        rejection,
        sessionId: options.prepared.decisionContext.sessionId,
      }),
    },
    healthResult: options.preCommitHealthResult,
    message,
    rawKind: 'commit_validation_rejected',
    rawReason: roleModelCommitValidationFailureRejectionReason,
    reason: runtimePluginHealthRejectionReason,
    runtimePluginContext: options.prepared.runtimePluginContext,
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
