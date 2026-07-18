import {
  CharacterReplyValidationError,
  normalizeCharacterAgentReply,
} from '../../core/index.ts';
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
  type RoleModelDecisionRejection,
} from '../../role-model/index.ts';
import {
  createRoleModelAdapterFromCharacterAgent,
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelLoopExecutionResult,
  type RoleModelInterimVisibleReplyEvent,
  type RoleModelLoopResult,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolRoutingEvidence,
} from '../../role-model/index.ts';
import {
  appendToolCallFinished,
  appendToolCallStarted,
  appendVisibleReplyForDecision,
  beginPluginFileStoreTransaction,
  completeRuntimeTurn,
  emitProgress,
  initializeRuntimeTurnEvidence,
  visibleMessageIdsForTurnOption,
} from './commit.ts';
import {
  roleModelIOSnapshotSessionId,
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
  createInvalidVisibleReplyRejection,
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
      readonly result: RoleModelLoopExecutionResult;
    }
  | {
      readonly status: 'rejected';
      readonly result: LocalRuntimeUserMessageRejectedResult;
    };

type InvalidInterimVisibleReply = {
  rejection: RoleModelDecisionRejection | undefined;
  evidence: RoleModelRawEvidence | undefined;
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
  const decisionContext = buildUserTurnDecisionContext({
    session: state.options.session,
    ...(state.options.characterTurnOptions?.recentMessageLimit === undefined
      ? {}
      : {
          recentMessageLimit:
            state.options.characterTurnOptions.recentMessageLimit,
        }),
  });
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
  beginPluginFileStoreTransaction(state, pluginHost);
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
  const invalidInterim: InvalidInterimVisibleReply = {
    rejection: undefined,
    evidence: undefined,
  };
  const roleModelDecisionContext = createDecisionContext({
    sessionId: prepared.decisionContext.sessionId,
    characterSnapshot: prepared.decisionContext.characterSnapshot,
    recentVisibleMessages: prepared.decisionContext.recentVisibleMessages,
    runtimeNotes: prepared.decisionContext.runtimeNotes,
    pluginContextItems: prepared.beforeRoleModelCallResult.contextItems,
  });

  try {
    const result = await runRoleModelLoop({
      event: state.event,
      decisionContext: roleModelDecisionContext,
      ...(state.options.maxToolRounds === undefined
        ? {}
        : {maxToolRounds: state.options.maxToolRounds}),
      pluginToolDefinitions: prepared.pluginHost.pluginToolDefinitions(),
      pluginToolHost: prepared.pluginHost,
      preparedConfigEffectsByToolCallId:
        state.preparedConfigEffectsByToolCallId,
      runtimePluginContext: prepared.runtimePluginContext,
      onPluginToolCallStarted(event) {
        recordPluginToolCallStarted(state, event);
      },
      async onPluginToolCallCompleted(event) {
        await recordPluginToolCallCompleted(state, event);
      },
      async onPluginToolCallsRequested(event) {
        await recordPluginToolCallsRequested(state, event);
      },
      async onInterimVisibleReply(event) {
        await recordInterimVisibleReply(state, prepared, invalidInterim, event);
      },
      ...roleModelLoopAdapterOption(state.options),
    });

    return {status: 'completed', result};
  } catch (error: unknown) {
    const rejection = await rejectInvalidInterimVisibleReply(
      state,
      prepared,
      invalidInterim,
      error,
    );

    if (rejection !== undefined) {
      return {status: 'rejected', result: rejection};
    }

    throw error;
  }
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

async function recordInterimVisibleReply(
  state: RuntimeTurnState,
  prepared: PreparedRuntimeTurn,
  invalidInterim: InvalidInterimVisibleReply,
  event: RoleModelInterimVisibleReplyEvent,
): Promise<void> {
  try {
    normalizeCharacterAgentReply({text: event.text});
  } catch (error: unknown) {
    if (error instanceof CharacterReplyValidationError) {
      const rejection = createInvalidVisibleReplyRejection(error);

      invalidInterim.rejection = rejection;
      invalidInterim.evidence = {
        roleModelIOSnapshot: event.ioSnapshot,
        parsedRoleModelDecisionSnapshot: event.parsedDecisionSnapshot,
        commitValidation: createRejectedCommitValidationSnapshot({
          identity: state.identity,
          rejection,
          sessionId: roleModelIOSnapshotSessionId(event.ioSnapshot),
        }),
      };
    }

    throw error;
  }

  await appendVisibleReplyForDecision(state, {
    runtimePluginEvidence: prepared.beforeRoleModelCallResult.evidence,
    final: false,
    roleModelIOSnapshot: event.ioSnapshot,
    parsedRoleModelDecisionSnapshot: event.parsedDecisionSnapshot,
    text: event.text,
  });
}

async function rejectInvalidInterimVisibleReply(
  state: RuntimeTurnState,
  prepared: PreparedRuntimeTurn,
  invalidInterim: InvalidInterimVisibleReply,
  error: unknown,
): Promise<LocalRuntimeUserMessageRejectedResult | undefined> {
  if (
    !(error instanceof CharacterReplyValidationError) ||
    invalidInterim.rejection === undefined ||
    invalidInterim.evidence === undefined
  ) {
    return undefined;
  }

  const pluginEvidence = combineRuntimePluginEvidence(
    prepared.beforeRoleModelCallResult.evidence,
    pluginToolEvidenceFromRouting(state.finishedPluginToolResults),
  );
  const toolInvocations = pluginToolInvocationsFromRouting(
    state.finishedPluginToolResults,
  );

  return await appendRoleModelRejectedResult(
    state,
    invalidInterim.rejection,
    invalidInterim.evidence,
    pluginEvidence,
    prepared.beforeRoleModelCallResult.contextItems,
    toolInvocations,
    prepared.runtimePluginContext,
  );
}

async function validateAndCommitRuntimeModelResult(
  state: RuntimeTurnState,
  prepared: PreparedRuntimeTurn,
  roleModelExecutionResult: RoleModelLoopExecutionResult,
): Promise<LocalRuntimeUserMessageResult> {
  const roleModelResult = roleModelExecutionResult.publicResult;
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

  if (roleModelExecutionResult.status === 'rejected') {
    return await rejectRoleModelResult({
      state,
      prepared,
      roleModelResult: roleModelExecutionResult.publicResult,
      roleModelEvidence,
      roleModelPluginEvidence,
      roleModelPluginToolInvocations,
    });
  }

  const acceptedRoleModelResult = roleModelExecutionResult.publicResult;
  const visibleReplyText = roleModelExecutionResult.visibleReplyText;
  const visibleReplyRejection = validateVisibleReplyText(visibleReplyText);

  if (visibleReplyRejection !== undefined) {
    return await appendRoleModelRejectedResult(
      state,
      visibleReplyRejection,
      {
        ...roleModelEvidence,
        commitValidation: createRejectedCommitValidationSnapshot({
          identity: state.identity,
          rejection: visibleReplyRejection,
          sessionId: prepared.decisionContext.sessionId,
        }),
      },
      roleModelPluginEvidence,
      prepared.beforeRoleModelCallResult.contextItems,
      roleModelPluginToolInvocations,
      prepared.runtimePluginContext,
    );
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
    roleModelResult: acceptedRoleModelResult,
    roleModelPluginEvidence,
    roleModelPluginToolInvocations,
    preCommitHealthResult,
    visibleReplyText,
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

function validateVisibleReplyText(
  visibleReplyText: string | undefined,
): RoleModelDecisionRejection | undefined {
  if (visibleReplyText === undefined) {
    return undefined;
  }

  try {
    normalizeCharacterAgentReply({text: visibleReplyText});
    return undefined;
  } catch (error: unknown) {
    if (error instanceof CharacterReplyValidationError) {
      return createInvalidVisibleReplyRejection(error);
    }

    throw error;
  }
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
  if (options.roleModelAdapter !== undefined) {
    return {adapter: options.roleModelAdapter};
  }

  if (options.agent !== undefined) {
    return {adapter: createRoleModelAdapterFromCharacterAgent(options.agent)};
  }

  return {};
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
