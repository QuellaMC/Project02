import {
  CharacterInputError,
  type RuntimeEventIdentity,
} from '../../core/index.ts';
import type {
  RuntimePluginContext,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginHealthSnapshot,
} from '../../plugins/api/index.ts';
import type {
  RuntimePluginHealthHostResult,
  RuntimePluginHost,
} from '../../plugins/index.ts';
import {type RoleModelDecisionRejection} from '../../role-model/index.ts';
import {
  createRoleModelCommitValidationSnapshot,
  type RoleModelCommitValidationSnapshot,
} from '../evidence/records.ts';
import {
  runtimePluginEvidenceOption,
  runtimePluginTurnEvidenceOption,
} from './plugin-evidence.ts';
import {appendRawEvent, visibleMessageIdsForTurnOption} from './commit.ts';
import {
  type LocalRuntimeUserMessageRejectedResult,
  type RuntimeTurnRejectionOptions,
  type RuntimeTurnState,
} from './contracts.ts';

const unexpectedRuntimeTurnFailureMessage =
  'Runtime turn failed before producing a reply.';

export async function appendRejectedResult(
  state: RuntimeTurnState,
  optionsForRejection: RuntimeTurnRejectionOptions,
): Promise<LocalRuntimeUserMessageRejectedResult> {
  const pluginHost = state.options.pluginHost;
  const healthResult =
    optionsForRejection.healthResult ??
    (await pluginHealthForTurn({
      pluginHost,
      runtimePluginContext: optionsForRejection.runtimePluginContext,
    }));
  const runtimePluginEvidence = combineRuntimePluginEvidence(
    optionsForRejection.runtimePluginEvidence ?? [],
    healthResult.evidence,
  );
  const rawEvent = appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_turn_rejected',
    eventType: state.event.type,
    status: 'rejected',
    reason: optionsForRejection.recordReason,
    message: optionsForRejection.message,
    ...rejectionIdentityOptions(optionsForRejection),
    payloadSummary: state.payloadSummary,
    ...(optionsForRejection.round === undefined
      ? {}
      : {round: optionsForRejection.round}),
    ...(optionsForRejection.commitValidation === undefined
      ? {}
      : {commitValidation: optionsForRejection.commitValidation}),
    ...runtimePluginEvidenceOption(runtimePluginEvidence),
    ...runtimePluginTurnEvidenceOption({
      identity: state.identity,
      pluginHost,
      contextItems: optionsForRejection.runtimePluginContextItems ?? [],
      toolInvocations: optionsForRejection.runtimePluginToolInvocations ?? [],
      evidence: runtimePluginEvidence,
      health: healthResult.snapshots,
    }),
  });

  return Object.freeze({
    status: 'rejected',
    event: state.event,
    reason: optionsForRejection.reason,
    message: optionsForRejection.message,
    rawEvent,
    rawEventLogRecords: Object.freeze([...state.rawEventLogRecords]),
  } satisfies LocalRuntimeUserMessageRejectedResult);
}

function rejectionIdentityOptions(options: RuntimeTurnRejectionOptions): {
  readonly toolCallIds?: readonly string[];
  readonly visibleMessageIds?: readonly string[];
} {
  return {
    ...(options.toolCallIds === undefined
      ? {}
      : {toolCallIds: options.toolCallIds}),
    ...(options.visibleMessageIds === undefined
      ? {}
      : {visibleMessageIds: options.visibleMessageIds}),
  };
}

export async function handleRuntimeTurnFailure(
  state: RuntimeTurnState,
  error: unknown,
): Promise<LocalRuntimeUserMessageRejectedResult> {
  if (state.terminalRawEventMayBeDurable) {
    throw error;
  }

  if (error instanceof CharacterInputError) {
    return await appendRejectedResult(state, {
      message: error.message,
      reason: 'input_validation_rejected',
      recordReason: 'input_validation_rejected',
      ...runtimePluginContextOption(state.runtimePluginContextForTurn),
    });
  }

  appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_turn_rejected',
    eventType: state.event.type,
    status: 'rejected',
    reason: 'runtime_failure',
    message: unexpectedRuntimeTurnFailureMessage,
    toolCallIds: Object.freeze([...state.finishedToolCallIds]),
    ...visibleMessageIdsForTurnOption(state.committedVisibleMessages),
    payloadSummary: state.payloadSummary,
  });

  throw error;
}

function runtimePluginContextOption(
  context: RuntimePluginContext | undefined,
): {readonly runtimePluginContext?: RuntimePluginContext} {
  return context === undefined ? {} : {runtimePluginContext: context};
}

export function healthResultRejectsTurn(options: {
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly healthResult: RuntimePluginHealthHostResult;
}): boolean {
  if (
    options.healthResult.evidence.some(evidence =>
      healthEvidenceRejectsTurn(evidence),
    )
  ) {
    return true;
  }

  const rejectingPluginIds = healthRejectingPluginIds(options.pluginHost);

  return options.healthResult.snapshots.some(snapshot =>
    healthSnapshotRejectsTurn({snapshot, rejectingPluginIds}),
  );
}

function healthEvidenceRejectsTurn(
  evidence: RuntimePluginEvidenceSnapshot,
): boolean {
  return evidence.evidenceKind === 'health' && evidence.status === 'failed';
}

export function healthResultRejectionMessage(options: {
  readonly pluginHost: RuntimePluginHost | undefined;
  readonly healthResult: RuntimePluginHealthHostResult;
}): string {
  const failedEvidenceSummary = options.healthResult.evidence.find(evidence =>
    healthEvidenceRejectsTurn(evidence),
  )?.summary;

  if (failedEvidenceSummary !== undefined) {
    return failedEvidenceSummary;
  }

  const rejectingPluginIds = healthRejectingPluginIds(options.pluginHost);
  const rejectingSnapshot = options.healthResult.snapshots.find(snapshot =>
    healthSnapshotRejectsTurn({snapshot, rejectingPluginIds}),
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
  pluginHost: RuntimePluginHost | undefined,
): ReadonlySet<string> {
  if (pluginHost === undefined) {
    return new Set<string>();
  }

  const enabledPluginIds = new Set(pluginHost.enabledPluginIds());

  return new Set(
    pluginHost
      .registrySnapshot()
      .plugins.filter(
        registration =>
          enabledPluginIds.has(registration.manifest.id) &&
          registration.manifest.runtimePolicy.failureBehavior.health ===
            'reject_turn',
      )
      .map(registration => registration.manifest.id),
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
      evidence: Object.freeze([]),
    } satisfies RuntimePluginHealthHostResult);
  }

  return await options.pluginHost.health(options.runtimePluginContext);
}

export function combineRuntimePluginEvidence(
  ...evidenceGroups: readonly (readonly RuntimePluginEvidenceSnapshot[])[]
): readonly RuntimePluginEvidenceSnapshot[] {
  return Object.freeze(evidenceGroups.flatMap(evidence => evidence));
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
      rejection: options.rejection,
    },
  });
}
