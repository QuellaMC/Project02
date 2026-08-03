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
  roleModelCommitValidationFailureRejectionReason,
  type DecisionContext,
} from '../../role-model/index.ts';
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
} from './rollback.ts';

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
  const state = createRuntimeTurnState({
    ...options,
    pluginHost: requiredRuntimePluginHost(options.pluginHost),
  });

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
      traceStep: 'input_validation_rejected',
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
  // Context first, then commit: recentVisibleMessages means "the
  // conversation before this turn", while the current user message rides
  // the event payload. Committing after the context build keeps that
  // meaning without excluding the just-said message by filtering.
  const decisionContext = buildUserTurnDecisionContext({
    session: state.options.session,
    ...(state.options.recentMessageLimit === undefined
      ? {}
      : {recentMessageLimit: state.options.recentMessageLimit}),
  });

  commitUserMessage(state);

  const runtimePluginContext = createRuntimePluginContext({
    ...state.identity,
    sessionId: decisionContext.sessionId,
    eventType: state.event.type,
    currentUserMessage: state.event.payload.currentUserMessage,
    character: decisionContext.characterSnapshot,
  });
  const pluginHost = createPluginHostForTurn(state);

  state.runtimePluginContextForTurn = runtimePluginContext;
  state.runtimePluginHostForTurn = pluginHost;
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
        traceStep: runtimePluginBeforeRoleModelCallRejectionReason,
        // The user message committed before this gate; the terminal
        // event must reference it or later full-evidence reads rebuild
        // a prior conversation that is missing a durable message.
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
    runtimeNotes: prepared.decisionContext.runtimeNotes,
    pluginContextItems: prepared.beforeRoleModelCallResult.contextItems,
  });
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
    traceStep: 'commit_validation_rejected',
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

function createPluginHostForTurn(state: RuntimeTurnState): RuntimePluginHost {
  return requiredRuntimePluginHost(state.options.pluginHost);
}

function requiredRuntimePluginHost(
  pluginHost: RuntimePluginHost | undefined,
): RuntimePluginHost {
  if (pluginHost === undefined) {
    throw new TypeError(
      'Local runtime turns require an explicitly configured plugin host.',
    );
  }

  return pluginHost;
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
