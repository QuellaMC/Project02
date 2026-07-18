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
import type {RawEventLogRecord, RuntimeLogStore} from '../evidence/records.ts';
import {runtimePluginEvidenceOption} from './plugin-evidence.ts';
import type {RuntimeTurnState} from './contracts.ts';

export async function recoverPendingRuntimeConfigEffects(options: {
  readonly logStore: RuntimeLogStore;
  readonly pluginHost: RuntimePluginHost;
}): Promise<void> {
  if (options.logStore.localRuntimeSessionPaths === undefined) {
    return;
  }

  const rawEvents = options.logStore.readSessionEvidence().stored.rawEvents;
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

    // Snapshot which pending effects the authored file ALREADY carries
    // before replay mutates anything: those effects landed in an earlier
    // pass (e.g. a commit whose marker append was lost), so the running
    // host was constructed at-or-after their config and a reload would
    // pointlessly rebuild and retire a fresh instance.
    const preAppliedEffectIds = new Set(
      pendingEffects
        .filter(
          effect =>
            options.pluginHost.configEffectIsAlreadyApplied?.(effect) === true,
        )
        .map(effect => effect.effectId),
    );
    const priorAcceptedEffectIds = new Set(
      terminalEffects
        .filter(effect => acceptedReconciledIds.has(effect.effectId))
        .map(effect => effect.effectId),
    );

    // Effects reconciled in an earlier pass were applied in that pass, so
    // they never count as newly applied by this one.
    for (const effectId of priorAcceptedEffectIds) {
      preAppliedEffectIds.add(effectId);
    }

    const reconcileEvidence: RuntimePluginEvidenceSnapshot[] = [];

    for (const effect of pendingEffects) {
      try {
        reconcileEvidence.push(
          reconcileRuntimeConfigEffect({
            pluginHost: options.pluginHost,
            effect,
          }),
        );
      } catch (error: unknown) {
        if (!(error instanceof RuntimeConfigConflictError)) {
          throw error;
        }

        reconcileEvidence.push(
          closeConflictedPreparedRuntimePluginConfigEffect({
            effect,
            reason: error.message,
          }),
        );
      }
    }

    // The host was constructed before this replay mutated the config
    // file, so its instances are stale in exactly the mid-session way;
    // recovery runs at turn start, which is what keeps the "next turn
    // reflects the change" contract across crashes. The event's effects
    // reload as ONE batch — including effects already reconciled by an
    // earlier pass — so a group the original commit would have refused
    // to live-apply (e.g. mixed live and session-scoped fields) defers
    // here exactly the same way.
    const reload = await applyCompletedRuntimeConfigReloads({
      pluginHost: options.pluginHost,
      effects: terminalEffects,
      reconcileEvidence,
      priorAcceptedEffectIds,
      preAppliedEffectIds,
    });

    options.logStore.appendRawEvent({
      eventId: terminal.eventId,
      traceId: terminal.traceId,
      createdAt: terminal.createdAt,
      kind: 'after_turn_committed',
      eventType: terminal.eventType,
      status:
        reload.failures.length > 0 ? 'completed_with_failures' : 'completed',
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
      reconciledEffectIds.add(effect.effectId);
    }
  }
}

/**
 * Live-applies committed config effects after reconciliation: groups the
 * effects whose reconcile evidence was accepted by target plugin and asks
 * the host to rebuild each. Hosts without reload support (or without any
 * accepted effect) do nothing; a reload problem never fails the turn.
 */
export async function applyCompletedRuntimeConfigReloads(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly effects: readonly PreparedRuntimePluginConfigEffect[];
  readonly reconcileEvidence: readonly RuntimePluginEvidenceSnapshot[];
  /** Effects accepted by an earlier pass; they join the group for eligibility. */
  readonly priorAcceptedEffectIds?: ReadonlySet<string>;
  /** Effects the authored file already carried before this pass replayed anything. */
  readonly preAppliedEffectIds?: ReadonlySet<string>;
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

    // Effects arrive in apply order, so the authored file ends at the LAST
    // accepted effect of the whole turn — every per-plugin group must verify
    // against that fingerprint, not its own last effect.
    turnFinalAcceptedEffect = effect;

    const group = effectsByPluginId.get(effect.targetPluginId) ?? [];

    group.push(effect);
    effectsByPluginId.set(effect.targetPluginId, group);
  }

  const evidence: RuntimePluginEvidenceSnapshot[] = [];
  const failures: string[] = [];

  for (const group of effectsByPluginId.values()) {
    // A group this pass did not move needs no reload: the running host was
    // constructed at-or-after that config (or an earlier pass already made
    // the reload decision), so a rebuild would only churn a fresh instance.
    if (
      group.every(
        effect => options.preAppliedEffectIds?.has(effect.effectId) === true,
      )
    ) {
      continue;
    }

    try {
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

export function reconciledRuntimeConfigEffectIds(
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

export function closeConflictedPreparedRuntimePluginConfigEffect(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly reason: string;
}): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.effect.eventId,
    traceId: options.effect.traceId,
    createdAt: options.effect.createdAt,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: runtimePluginId,
    evidenceKind: 'after_turn_committed',
    status: 'rejected',
    summary: `Closed conflicted plugin "${options.effect.targetPluginId}" config effect "${options.effect.effectId}" without applying it: ${options.reason}`,
    sourceReferences: [
      {
        kind: 'runtime',
        id: options.effect.effectId,
      },
    ],
    redactionLabels: [],
  });
}
