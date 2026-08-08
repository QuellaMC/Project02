import type {RuntimePluginHost} from '../../plugins/index.ts';
import {
  createRuntimePluginEvidenceSnapshot,
  preparedRuntimePluginConfigEffectHasApprovalEvidence,
  runtimePluginId,
  type PreparedRuntimePluginConfigEffect,
  type RuntimePluginEvidenceSnapshot,
} from '../../plugins/api/index.ts';
import type {AcceptedRoleModelLoopResult} from '../../role-model/index.ts';
import {RuntimeConfigConflictError} from '../config/mutate.ts';
import type {RawEventLogRecord} from '../evidence/records.ts';
import {
  approvalToolRecordsByCallId,
  runtimeConfigEffectHasLoggedApproval,
} from '../evidence/config-effect-approval.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {runtimePluginEvidenceOption} from './plugin-evidence.ts';
import type {RuntimeTurnState} from './contracts.ts';

export async function recoverPendingRuntimeConfigEffects(options: {
  readonly logStore: RuntimeLogStore;
  readonly pluginHost: RuntimePluginHost;
}): Promise<void> {
  if (options.logStore.localRuntimeSessionPaths === undefined) {
    return;
  }

  const rawEvents = options.logStore.readSessionEvidence().rawEvents;
  const approvalRecords = approvalToolRecordsByCallId(rawEvents);
  const reconciledEffectIds = reconciledRuntimeConfigEffectIds(rawEvents);
  const acceptedReconciledIds = reconciledRuntimeConfigEffectIds(rawEvents, [
    'accepted',
  ]);

  for (const terminal of rawEvents) {
    if (terminal.kind !== 'runtime_turn_completed') {
      continue;
    }

    const terminalEffects = terminal.runtimeConfigEffects ?? [];
    const pendingEffects = terminalEffects.filter(
      effect => !reconciledEffectIds.has(effect.effectId),
    );

    if (pendingEffects.length === 0) {
      continue;
    }

    const priorAcceptedEffectIds = new Set(
      terminalEffects
        .filter(effect => acceptedReconciledIds.has(effect.effectId))
        .map(effect => effect.effectId),
    );
    const reconcileEvidence: RuntimePluginEvidenceSnapshot[] = [];
    const failedEffectIds = new Set<string>();

    for (const effect of pendingEffects) {
      // Replay acts only on what the log says: an effect with no approved
      // config-update call is closed rejected, never applied.
      if (!runtimeConfigEffectHasLoggedApproval(effect, approvalRecords)) {
        reconcileEvidence.push(
          closeRejectedPreparedRuntimePluginConfigEffect({
            effect,
            summary: `Refused plugin "${effect.targetPluginId}" config effect "${effect.effectId}" without applying it: the session log carries no approved config-update tool call for it.`,
          }),
        );
        continue;
      }

      try {
        reconcileEvidence.push(
          reconcileRuntimeConfigEffect({
            pluginHost: options.pluginHost,
            effect,
          }),
        );
      } catch (error: unknown) {
        if (error instanceof RuntimeConfigConflictError) {
          reconcileEvidence.push(
            closeConflictedPreparedRuntimePluginConfigEffect({
              effect,
              reason: error.message,
            }),
          );
          continue;
        }

        // A transient failure must not abort the pass: this effect stays
        // pending, and the next pass retries it.
        failedEffectIds.add(effect.effectId);
        reconcileEvidence.push(
          failedRuntimeConfigEffectRecoveryEvidence({
            effect,
            message: runtimePostCommitFailureMessage(error),
          }),
        );
      }
    }

    // Recovery runs at turn start, keeping the "next turn reflects the
    // change" contract across crashes; the effects reload as one batch.
    const reload = await applyCompletedRuntimeConfigReloads({
      pluginHost: options.pluginHost,
      effects: terminalEffects,
      reconcileEvidence,
      priorAcceptedEffectIds,
    });

    options.logStore.appendRawEvent({
      eventId: terminal.eventId,
      traceId: terminal.traceId,
      createdAt: terminal.createdAt,
      kind: 'after_turn_committed',
      eventType: terminal.eventType,
      status:
        reload.failures.length > 0 || failedEffectIds.size > 0
          ? 'completed_with_failures'
          : 'completed',
      ...(terminal.visibleMessageIds === undefined
        ? {}
        : {visibleMessageIds: terminal.visibleMessageIds}),
      ...(terminal.toolCallIds === undefined
        ? {}
        : {toolCallIds: terminal.toolCallIds}),
      ...(terminal.payloadSummary === undefined
        ? {}
        : {payloadSummary: terminal.payloadSummary}),
      ...runtimePluginEvidenceOption([
        ...reconcileEvidence,
        ...reload.evidence,
      ]),
    });

    for (const effect of pendingEffects) {
      if (!failedEffectIds.has(effect.effectId)) {
        reconciledEffectIds.add(effect.effectId);
      }
    }
  }
}

function failedRuntimeConfigEffectRecoveryEvidence(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly message: string;
}): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.effect.eventId,
    traceId: options.effect.traceId,
    createdAt: options.effect.createdAt,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: runtimePluginId,
    evidenceKind: 'after_turn_committed',
    status: 'failed',
    summary: `Recovery could not reconcile plugin "${options.effect.targetPluginId}" config effect "${options.effect.effectId}"; it stays pending: ${options.message}`,
    sourceReferences: [
      {
        kind: 'runtime',
        id: options.effect.effectId,
      },
    ],
    redactionLabels: [],
  });
}

/**
 * Only effects whose reconcile evidence was accepted are applied, and a
 * reload problem never fails the turn.
 */
export async function applyCompletedRuntimeConfigReloads(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly effects: readonly PreparedRuntimePluginConfigEffect[];
  readonly reconcileEvidence: readonly RuntimePluginEvidenceSnapshot[];
  /** Effects accepted by an earlier pass; they join the group for eligibility. */
  readonly priorAcceptedEffectIds?: ReadonlySet<string>;
}): Promise<{
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly failures: readonly string[];
}> {
  const reload = options.pluginHost.reloadPluginForCommittedConfig?.bind(
    options.pluginHost,
  );

  if (reload === undefined || options.effects.length === 0) {
    return {evidence: Object.freeze([]), failures: Object.freeze([])};
  }

  const acceptedEffectIds = acceptedReconcileEffectIds(
    options.reconcileEvidence,
  );

  for (const effectId of options.priorAcceptedEffectIds ?? []) {
    acceptedEffectIds.add(effectId);
  }

  const effectsByPluginId = new Map<
    string,
    PreparedRuntimePluginConfigEffect[]
  >();
  let turnFinalAcceptedEffect: PreparedRuntimePluginConfigEffect | undefined;

  for (const effect of options.effects) {
    if (!acceptedEffectIds.has(effect.effectId)) {
      continue;
    }

    // Effects arrive in apply order, so the authored file ends at the last
    // accepted effect of the turn, not at each group's own last one.
    turnFinalAcceptedEffect = effect;

    const group = effectsByPluginId.get(effect.targetPluginId) ?? [];

    group.push(effect);
    effectsByPluginId.set(effect.targetPluginId, group);
  }

  const evidence: RuntimePluginEvidenceSnapshot[] = [];
  const failures: string[] = [];

  for (const [groupPluginId, group] of effectsByPluginId.entries()) {
    // Skip only when the host already reflects this group's final state or
    // the turn's; a host that reflects neither reloads and heals.
    const groupFinalEffect = group[group.length - 1];
    const hostReflects = (fingerprint: string | undefined): boolean =>
      fingerprint !== undefined &&
      options.pluginHost.pluginConfigCurrentFor?.(
        groupPluginId,
        fingerprint,
      ) === true;

    try {
      // Inside the try on purpose: a throwing currency predicate is recorded
      // as a reload failure, never escaping after the turn is durable.
      if (
        hostReflects(groupFinalEffect?.resultFingerprint) ||
        hostReflects(turnFinalAcceptedEffect?.resultFingerprint)
      ) {
        continue;
      }

      const result = await reload(
        group,
        turnFinalAcceptedEffect === undefined
          ? undefined
          : {
              turnResultFingerprint: turnFinalAcceptedEffect.resultFingerprint,
            },
      );

      if (result.evidence !== undefined) {
        evidence.push(result.evidence);
      }
      if (result.failure !== undefined) {
        failures.push(result.failure);
      }
    } catch (error: unknown) {
      failures.push(runtimePostCommitFailureMessage(error));
    }
  }

  return {evidence: Object.freeze(evidence), failures: Object.freeze(failures)};
}

function acceptedReconcileEffectIds(
  reconcileEvidence: readonly RuntimePluginEvidenceSnapshot[],
): Set<string> {
  const effectIds = new Set<string>();

  for (const snapshot of reconcileEvidence) {
    if (snapshot.status !== 'accepted') {
      continue;
    }

    for (const reference of snapshot.sourceReferences ?? []) {
      if (reference.kind === 'runtime') {
        effectIds.add(reference.id);
      }
    }
  }

  return effectIds;
}

export function runtimeConfigEffectsForCompletedTurn(options: {
  readonly state: RuntimeTurnState;
  readonly roleModelResult: AcceptedRoleModelLoopResult;
}): readonly PreparedRuntimePluginConfigEffect[] {
  const effects = options.roleModelResult.pluginToolResults.flatMap(routing => {
    const effect = options.state.preparedConfigEffectsByToolCallId.get(
      routing.callId,
    );

    return routing.result.status === 'accepted' && effect !== undefined
      ? [effect]
      : [];
  });

  if (effects.length !== options.state.preparedConfigEffectsByToolCallId.size) {
    throw new Error(
      'Prepared runtime config effects do not match accepted role-model tool results.',
    );
  }

  return Object.freeze(effects);
}

export function assertRuntimeConfigEffectsCanCommit(options: {
  readonly state: RuntimeTurnState;
  readonly pluginHost: RuntimePluginHost;
  readonly effects: readonly PreparedRuntimePluginConfigEffect[];
}): void {
  if (options.effects.length === 0) {
    return;
  }

  if (options.state.options.logStore.localRuntimeSessionPaths === undefined) {
    throw new Error(
      'Approved runtime config effects require durable local session evidence.',
    );
  }

  if (options.pluginHost.reconcileConfigEffect === undefined) {
    throw new Error(
      'Approved runtime config effects require host reconciliation support.',
    );
  }

  const effectIds = new Set<string>();

  for (const effect of options.effects) {
    const approval = options.state.finishedPluginToolResults.find(
      routing => routing.callId === effect.effectId,
    );

    if (
      approval === undefined ||
      !preparedRuntimePluginConfigEffectHasApprovalEvidence({
        effect,
        eventIdentity: approval.call,
        inputIdentity: approval.call,
        inputPluginId: approval.call.pluginId,
        inputToolName: approval.call.toolName,
        toolCallId: approval.callId,
        dispatchedToHost: approval.dispatchedToHost,
        pluginId: approval.call.pluginId,
        toolName: approval.call.toolName,
        result: approval.result,
      })
    ) {
      throw new Error(
        'Prepared runtime config effect is missing its approved config-update tool evidence.',
      );
    }

    if (effectIds.has(effect.effectId)) {
      throw new Error('Prepared runtime config effect id must be unique.');
    }

    effectIds.add(effect.effectId);
  }
}

export function reconcileCompletedRuntimeConfigEffects(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly effects: readonly PreparedRuntimePluginConfigEffect[];
  readonly postCommitFailures: string[];
}): readonly RuntimePluginEvidenceSnapshot[] {
  const evidence: RuntimePluginEvidenceSnapshot[] = [];

  for (const effect of options.effects) {
    try {
      evidence.push(
        reconcileRuntimeConfigEffect({
          pluginHost: options.pluginHost,
          effect,
        }),
      );
    } catch (error: unknown) {
      options.postCommitFailures.push(runtimePostCommitFailureMessage(error));

      if (error instanceof RuntimeConfigConflictError) {
        evidence.push(
          closeConflictedPreparedRuntimePluginConfigEffect({
            effect,
            reason: error.message,
          }),
        );
      }
    }
  }

  return Object.freeze(evidence);
}

function reconcileRuntimeConfigEffect(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly effect: PreparedRuntimePluginConfigEffect;
}): RuntimePluginEvidenceSnapshot {
  if (options.pluginHost.reconcileConfigEffect === undefined) {
    throw new Error(
      'Pending runtime config effect requires host reconciliation support.',
    );
  }

  const evidence = options.pluginHost.reconcileConfigEffect(options.effect);
  const referencesEffect = evidence.sourceReferences?.some(
    reference =>
      reference.kind === 'runtime' && reference.id === options.effect.effectId,
  );

  if (
    evidence.pluginId !== runtimePluginId ||
    evidence.evidenceKind !== 'after_turn_committed' ||
    evidence.status !== 'accepted' ||
    evidence.eventId !== options.effect.eventId ||
    evidence.traceId !== options.effect.traceId ||
    evidence.createdAt !== options.effect.createdAt ||
    referencesEffect !== true
  ) {
    throw new Error(
      'Runtime config reconciliation returned invalid commit evidence.',
    );
  }

  return evidence;
}

function reconciledRuntimeConfigEffectIds(
  rawEvents: readonly RawEventLogRecord[],
  statuses: readonly ('accepted' | 'rejected')[] = ['accepted', 'rejected'],
): Set<string> {
  const effectIds = new Set<string>();

  for (const rawEvent of rawEvents) {
    if (rawEvent.kind !== 'after_turn_committed') {
      continue;
    }

    for (const evidence of rawEvent.runtimePluginEvidence ?? []) {
      if (
        evidence.pluginId !== runtimePluginId ||
        evidence.evidenceKind !== 'after_turn_committed' ||
        !statuses.some(status => status === evidence.status)
      ) {
        continue;
      }

      for (const reference of evidence.sourceReferences ?? []) {
        if (reference.kind === 'runtime') {
          effectIds.add(reference.id);
        }
      }
    }
  }

  return effectIds;
}

export function runtimePostCommitFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Runtime post-commit work failed.';
}

function closeConflictedPreparedRuntimePluginConfigEffect(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly reason: string;
}): RuntimePluginEvidenceSnapshot {
  return closeRejectedPreparedRuntimePluginConfigEffect({
    effect: options.effect,
    summary: `Closed conflicted plugin "${options.effect.targetPluginId}" config effect "${options.effect.effectId}" without applying it: ${options.reason}`,
  });
}

function closeRejectedPreparedRuntimePluginConfigEffect(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly summary: string;
}): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.effect.eventId,
    traceId: options.effect.traceId,
    createdAt: options.effect.createdAt,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: runtimePluginId,
    evidenceKind: 'after_turn_committed',
    status: 'rejected',
    summary: options.summary,
    sourceReferences: [
      {
        kind: 'runtime',
        id: options.effect.effectId,
      },
    ],
    redactionLabels: [],
  });
}
