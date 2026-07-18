import {
  CharacterInputError,
  CharacterReplyValidationError,
  type RuntimeEventIdentity
} from '../../core/index.ts';
import type {
  RuntimePluginContext,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginHealthSnapshot,
  RuntimePluginToolInvocationSnapshot
} from '../../plugins/api/index.ts';
import type {
  RuntimePluginHealthHostResult,
  RuntimePluginHost
} from '../../plugins/index.ts';
import {
  createRejectedRoleModelDecisionResult,
  roleModelInvalidVisibleReplyRejectionReason,
  type RoleModelDecisionRejection
} from '../../role-model/index.ts';
import {
  createRoleModelCommitValidationSnapshot,
  type RoleModelCommitValidationSnapshot
} from '../evidence/records.ts';
import {
  runtimePluginEvidenceOption,
  runtimePluginTurnEvidenceOption
} from './plugin-evidence.ts';
import {
  IncompleteConversationRollbackError,
  appendRawEvent,
  appendTrace,
  rollbackPluginFileStoreTransaction,
  visibleMessageIdsForTurnOption
} from './commit.ts';
import {
  type LocalRuntimeUserMessageRejectedResult,
  type RoleModelRawEvidence,
  type RuntimeTurnRejectionOptions,
  type RuntimeTurnState
} from './contracts.ts';

const unexpectedRuntimeTurnFailureMessage =
  'Runtime turn failed before producing a reply.';

export async function appendRejectedResult(
  state: RuntimeTurnState,
  optionsForRejection: RuntimeTurnRejectionOptions
): Promise<LocalRuntimeUserMessageRejectedResult> {
  const evidence = optionsForRejection.evidence ?? {};
  const pluginHostForEvidence =
    state.runtimePluginHostForTurn ?? state.options.pluginHost;
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

  await rollbackPluginFileStoreTransaction(state);
  appendTrace(state, optionsForRejection.traceStep);
  appendRawEvent(state, {
    ...state.identity,
    kind: optionsForRejection.rawKind,
    eventType: state.event.type,
    status: 'rejected',
    reason: optionsForRejection.rawReason,
    ...rejectionIdentityOptions(optionsForRejection),
    payloadSummary: state.payloadSummary,
    ...evidence,
    ...runtimePluginEvidenceOption(runtimePluginEvidence),
    ...runtimePluginTurnEvidenceOption({
      identity: state.identity,
      pluginHost: pluginHostForEvidence,
      contextItems: optionsForRejection.runtimePluginContextItems ?? [],
      toolInvocations: optionsForRejection.runtimePluginToolInvocations ?? [],
      evidence: runtimePluginEvidence,
      health: healthResult.snapshots
    })
  });

  const rawEvent = appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_turn_rejected',
    eventType: state.event.type,
    status: 'rejected',
    reason: optionsForRejection.rawReason,
    ...rejectionIdentityOptions(optionsForRejection),
    payloadSummary: state.payloadSummary,
    ...evidence,
    ...runtimePluginEvidenceOption(runtimePluginEvidence),
    ...runtimePluginTurnEvidenceOption({
      identity: state.identity,
      pluginHost: pluginHostForEvidence,
      contextItems: optionsForRejection.runtimePluginContextItems ?? [],
      toolInvocations: optionsForRejection.runtimePluginToolInvocations ?? [],
      evidence: runtimePluginEvidence,
      health: healthResult.snapshots
    })
  });

  appendTrace(state, 'raw_event_log_appended');
  appendTrace(state, 'runtime_turn_rejected');

  return Object.freeze({
    status: 'rejected',
    event: state.event,
    reason: optionsForRejection.reason,
    message: optionsForRejection.message,
    rawEvent,
    rawEventLogRecords: Object.freeze([...state.rawEventLogRecords]),
    traceEntries: Object.freeze([...state.traceEntries])
  } satisfies LocalRuntimeUserMessageRejectedResult);
}

function rejectionIdentityOptions(
  options: RuntimeTurnRejectionOptions
): {
  readonly toolCallIds?: readonly string[];
  readonly visibleMessageIds?: readonly string[];
} {
  return {
    ...(options.toolCallIds === undefined
      ? {}
      : { toolCallIds: options.toolCallIds }),
    ...(options.visibleMessageIds === undefined
      ? {}
      : { visibleMessageIds: options.visibleMessageIds })
  };
}

export function appendRoleModelRejectedResult(
  state: RuntimeTurnState,
  rejection: RoleModelDecisionRejection,
  evidence: RoleModelRawEvidence,
  runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[],
  runtimePluginContextItems?: readonly RuntimePluginContextItem[],
  runtimePluginToolInvocations?: readonly RuntimePluginToolInvocationSnapshot[],
  runtimePluginContext?: RuntimePluginContext
): Promise<LocalRuntimeUserMessageRejectedResult> {
  return appendRejectedResult(state, {
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
    ...(runtimePluginContext === undefined ? {} : { runtimePluginContext }),
    traceStep: 'commit_validation_rejected',
    toolCallIds: Object.freeze([...state.finishedToolCallIds]),
    ...visibleMessageIdsForTurnOption(state.committedVisibleMessages)
  });
}

export async function handleRuntimeTurnFailure(
  state: RuntimeTurnState,
  error: unknown
): Promise<LocalRuntimeUserMessageRejectedResult> {
  if (
    state.terminalRawEventMayBeDurable ||
    error instanceof IncompleteConversationRollbackError
  ) {
    throw error;
  }

  if (error instanceof CharacterInputError) {
    return await appendRejectedResult(state, {
      message: error.message,
      rawKind: 'input_validation_rejected',
      rawReason: error.message,
      reason: 'input_validation_rejected',
      ...runtimePluginContextOption(state.runtimePluginContextForTurn),
      traceStep: 'input_validation_rejected'
    });
  }

  if (error instanceof CharacterReplyValidationError) {
    const rejection = createInvalidVisibleReplyRejection(error);

    return await appendRejectedResult(state, {
      message: error.message,
      rawKind: 'character_reply_rejected',
      rawReason: rejection.reason,
      reason: rejection.reason,
      ...runtimePluginContextOption(state.runtimePluginContextForTurn),
      traceStep: 'character_reply_rejected',
      ...visibleMessageIdsForTurnOption(state.committedVisibleMessages)
    });
  }

  await rollbackPluginFileStoreTransaction(state);
  appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_turn_rejected',
    eventType: state.event.type,
    status: 'rejected',
    reason: unexpectedRuntimeTurnFailureMessage,
    toolCallIds: Object.freeze([...state.finishedToolCallIds]),
    ...visibleMessageIdsForTurnOption(state.committedVisibleMessages),
    payloadSummary: state.payloadSummary
  });
  appendTrace(state, 'raw_event_log_appended');
  appendTrace(state, 'runtime_turn_rejected');

  throw error;
}

function runtimePluginContextOption(
  context: RuntimePluginContext | undefined
): { readonly runtimePluginContext?: RuntimePluginContext } {
  return context === undefined ? {} : { runtimePluginContext: context };
}

export function healthResultRejectsTurn(options: {
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

  const rejectingPluginIds = healthRejectingPluginIds(options.pluginHost);

  return options.healthResult.snapshots.some((snapshot) =>
    healthSnapshotRejectsTurn({ snapshot, rejectingPluginIds })
  );
}

function healthEvidenceRejectsTurn(
  evidence: RuntimePluginEvidenceSnapshot
): boolean {
  return evidence.evidenceKind === 'health' && evidence.status === 'failed';
}

export function healthResultRejectionMessage(options: {
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly healthResult: RuntimePluginHealthHostResult;
}): string {
  const failedEvidenceSummary = options.healthResult.evidence.find((evidence) =>
    healthEvidenceRejectsTurn(evidence)
  )?.summary;

  if (failedEvidenceSummary !== undefined) {
    return failedEvidenceSummary;
  }

  const rejectingPluginIds = healthRejectingPluginIds(options.pluginHost);
  const rejectingSnapshot = options.healthResult.snapshots.find((snapshot) =>
    healthSnapshotRejectsTurn({ snapshot, rejectingPluginIds })
  );

  if (rejectingSnapshot !== undefined) {
    return `Plugin health ${rejectingSnapshot.status}: ${rejectingSnapshot.summary}`;
  }

  return 'Plugin health policy rejected the turn.';
}

function healthSnapshotRejectsTurn(options: {
  readonly snapshot: RuntimePluginHealthSnapshot;
  readonly rejectingPluginIds: ReadonlySet<string>;
}): boolean {
  return (
    options.snapshot.status !== 'ok' &&
    options.rejectingPluginIds.has(options.snapshot.pluginId)
  );
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

async function pluginHealthForTurn(options: {
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly runtimePluginContext: RuntimePluginContext | undefined;
}): Promise<RuntimePluginHealthHostResult> {
  if (
    options.pluginHost === undefined ||
    options.runtimePluginContext === undefined
  ) {
    return Object.freeze({
      snapshots: Object.freeze([]),
      evidence: Object.freeze([])
    } satisfies RuntimePluginHealthHostResult);
  }

  return await options.pluginHost.health(options.runtimePluginContext);
}

export function combineRuntimePluginEvidence(
  ...evidenceGroups: readonly (readonly RuntimePluginEvidenceSnapshot[])[]
): readonly RuntimePluginEvidenceSnapshot[] {
  return Object.freeze(evidenceGroups.flatMap((evidence) => evidence));
}

export function createRejectedCommitValidationSnapshot(options: {
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

export function createInvalidVisibleReplyRejection(
  error: CharacterReplyValidationError
): RoleModelDecisionRejection {
  return createRejectedRoleModelDecisionResult(
    roleModelInvalidVisibleReplyRejectionReason,
    error.message
  ).rejection;
}
