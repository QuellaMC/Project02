import type { RuntimePluginHost } from '../../plugins/index.ts';
import {
  createRuntimePluginEvidenceSnapshot,
  preparedRuntimePluginConfigEffectHasApprovalEvidence,
  runtimePluginId,
  type PreparedRuntimePluginConfigEffect,
  type RuntimePluginEvidenceSnapshot
} from '../../plugins/api/index.ts';
import type { AcceptedRoleModelLoopResult } from '../../role-model/index.ts';
import { RuntimeConfigConflictError } from '../config/mutate.ts';
import type { RawEventLogRecord, RuntimeLogStore } from '../evidence/records.ts';
import { runtimePluginEvidenceOption } from './plugin-evidence.ts';
import type { RuntimeTurnState } from './contracts.ts';

export function recoverPendingRuntimeConfigEffects(options: {
  readonly logStore: RuntimeLogStore;
  readonly pluginHost: RuntimePluginHost;
}): void {
  if (options.logStore.localRuntimeSessionPaths === undefined) {
    return;
  }

  const rawEvents = options.logStore.readSessionEvidence().stored.rawEvents;
  const reconciledEffectIds = reconciledRuntimeConfigEffectIds(rawEvents);

  for (const terminal of rawEvents) {
    if (terminal.kind !== 'runtime_turn_completed') {
      continue;
    }

    for (const effect of terminal.runtimeConfigEffects ?? []) {
      if (reconciledEffectIds.has(effect.effectId)) {
        continue;
      }

      let evidence: RuntimePluginEvidenceSnapshot;

      try {
        evidence = reconcileRuntimeConfigEffect({
          pluginHost: options.pluginHost,
          effect
        });
      } catch (error: unknown) {
        if (!(error instanceof RuntimeConfigConflictError)) {
          throw error;
        }

        evidence = closeConflictedPreparedRuntimePluginConfigEffect({
          effect,
          reason: error.message
        });
      }

      options.logStore.appendRawEvent({
        eventId: terminal.eventId,
        traceId: terminal.traceId,
        createdAt: terminal.createdAt,
        kind: 'after_turn_committed',
        eventType: terminal.eventType,
        status: 'completed',
        ...(terminal.visibleMessageIds === undefined
          ? {}
          : { visibleMessageIds: terminal.visibleMessageIds }),
        ...(terminal.toolCallIds === undefined
          ? {}
          : { toolCallIds: terminal.toolCallIds }),
        ...(terminal.payloadSummary === undefined
          ? {}
          : { payloadSummary: terminal.payloadSummary }),
        ...runtimePluginEvidenceOption([evidence])
      });
      reconciledEffectIds.add(effect.effectId);
    }
  }
}

export function runtimeConfigEffectsForCompletedTurn(options: {
  readonly state: RuntimeTurnState;
  readonly roleModelResult: AcceptedRoleModelLoopResult;
}): readonly PreparedRuntimePluginConfigEffect[] {
  const effects = options.roleModelResult.pluginToolResults.flatMap(
    (routing) => {
      const effect = options.state.preparedConfigEffectsByToolCallId.get(
        routing.callId
      );

      return routing.result.status === 'accepted' && effect !== undefined
        ? [effect]
        : [];
    }
  );

  if (effects.length !== options.state.preparedConfigEffectsByToolCallId.size) {
    throw new Error(
      'Prepared runtime config effects do not match accepted role-model tool results.'
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
      'Approved runtime config effects require durable local session evidence.'
    );
  }

  if (options.pluginHost.reconcileConfigEffect === undefined) {
    throw new Error(
      'Approved runtime config effects require host reconciliation support.'
    );
  }

  const effectIds = new Set<string>();

  for (const effect of options.effects) {
    const approval = options.state.finishedPluginToolResults.find(
      (routing) => routing.callId === effect.effectId
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
        result: approval.result
      })
    ) {
      throw new Error(
        'Prepared runtime config effect is missing its approved config-update tool evidence.'
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
          effect
        })
      );
    } catch (error: unknown) {
      options.postCommitFailures.push(runtimePostCommitFailureMessage(error));

      if (error instanceof RuntimeConfigConflictError) {
        evidence.push(
          closeConflictedPreparedRuntimePluginConfigEffect({
            effect,
            reason: error.message
          })
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
      'Pending runtime config effect requires host reconciliation support.'
    );
  }

  const evidence = options.pluginHost.reconcileConfigEffect(options.effect);
  const referencesEffect = evidence.sourceReferences?.some(
    (reference) =>
      reference.kind === 'runtime' &&
      reference.id === options.effect.effectId
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
      'Runtime config reconciliation returned invalid commit evidence.'
    );
  }

  return evidence;
}

export function reconciledRuntimeConfigEffectIds(
  rawEvents: readonly RawEventLogRecord[]
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
        (evidence.status !== 'accepted' && evidence.status !== 'rejected')
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
        id: options.effect.effectId
      }
    ],
    redactionLabels: []
  });
}

