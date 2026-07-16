import type {
  CharacterProfile,
  VisibleMessage
} from '../core/conversation.ts';
import {
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelIOSnapshot
} from '../role-model/contracts.ts';
import {
  runtimePluginContractVersion,
  createRuntimePluginTurnEvidenceSnapshot,
  type PreparedRuntimePluginConfigEffect,
  type RuntimePluginContextItem,
  type RuntimePluginJsonObject,
  type RuntimePluginHealthSnapshot,
  type RuntimePluginToolCallResult,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginRegistrySnapshot,
  type RuntimePluginToolInvocationSnapshot,
  type RuntimePluginTurnEvidenceSnapshot
} from '../plugins/types.ts';
import {
  assertCanonicalRuntimeTimestamp,
  type RuntimeEventIdentity,
  type RuntimeEventType
} from './event.ts';
import type { LocalRuntimeSessionPaths } from './storage/layout.ts';
import type { LocalRuntimeMutationLockOwnerToken } from './storage/mutation-lock.ts';
import { redactJsonBoundaryText } from '../shared/json-boundary.ts';
import type { MutableDurableRuntimeSessionEvidence } from './storage/runtime-evidence-contract.ts';
import { createRuntimeEvidenceTransitionMachine } from './storage/runtime-evidence-transition.ts';

export const runtimeTurnStatusValues = [
  'completed',
  'completed_with_failures',
  'rejected'
] as const;

export type RuntimeTurnStatus = (typeof runtimeTurnStatusValues)[number];

export const runtimeTraceStepValues = [
  'runtime_event_received',
  'runtime_event_normalized',
  'runtime_turn_started',
  'plugin_before_role_model_call_rejected',
  'tool_call_started',
  'tool_call_finished',
  'interim_visible_reply_emitted',
  'visible_reply_committed',
  'input_validation_rejected',
  'character_reply_rejected',
  'commit_validation_rejected',
  'raw_event_log_appended',
  'runtime_turn_completed',
  'runtime_turn_rejected'
] as const;

export type RuntimeTraceStepName = (typeof runtimeTraceStepValues)[number];

export type RuntimeTraceEntry = RuntimeEventIdentity & {
  readonly step: RuntimeTraceStepName;
};

export const rawEventLogRecordKindValues = [
  'runtime_event_received',
  'runtime_event_normalized',
  'plugin_before_role_model_call_rejected',
  'tool_call_started',
  'tool_call_finished',
  'interim_visible_reply_emitted',
  'visible_reply_committed',
  'input_validation_rejected',
  'character_reply_rejected',
  'commit_validation_rejected',
  'runtime_turn_completed',
  'after_turn_committed',
  'runtime_turn_rejected'
] as const;

export type RawEventLogRecordKind =
  (typeof rawEventLogRecordKindValues)[number];

export type RawEventLogPayloadSummary = {
  readonly rawInput?: string;
  readonly normalizedCurrentUserMessage?: string;
};

export type RawEventLogRecord = RuntimeEventIdentity & {
  readonly kind: RawEventLogRecordKind;
  readonly eventType: RuntimeEventType;
  readonly status?: RuntimeTurnStatus;
  readonly reason?: string;
  readonly visibleMessageIds?: readonly string[];
  readonly toolCallIds?: readonly string[];
  readonly toolCallId?: string;
  readonly dispatchedToHost?: boolean;
  readonly toolRound?: number;
  readonly toolName?: string;
  readonly toolPluginId?: string;
  readonly toolInput?: RuntimePluginJsonObject;
  readonly toolResult?: RuntimePluginToolCallResult;
  readonly pluginStoreRevision?: number;
  readonly payloadSummary?: RawEventLogPayloadSummary;
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
  readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
  readonly runtimePluginTurnEvidence?: RuntimePluginTurnEvidenceSnapshot;
  readonly runtimeConfigEffects?: readonly PreparedRuntimePluginConfigEffect[];
};

export type ConversationLogRecord = VisibleMessage &
  RuntimeEventIdentity & {
    readonly committedAt: string;
  };

export type RuntimeTraceEntryInput = RuntimeEventIdentity & {
  readonly step: RuntimeTraceStepName;
};

export type RawEventLogRecordInput = RuntimeEventIdentity & {
  readonly kind: RawEventLogRecordKind;
  readonly eventType: RuntimeEventType;
  readonly status?: RuntimeTurnStatus;
  readonly reason?: string;
  readonly visibleMessageIds?: readonly string[];
  readonly toolCallIds?: readonly string[];
  readonly toolCallId?: string;
  readonly dispatchedToHost?: boolean;
  readonly toolRound?: number;
  readonly toolName?: string;
  readonly toolPluginId?: string;
  readonly toolInput?: RuntimePluginJsonObject;
  readonly toolResult?: RuntimePluginToolCallResult;
  readonly pluginStoreRevision?: number;
  readonly payloadSummary?: RawEventLogPayloadSummary;
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
  readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
  readonly runtimePluginTurnEvidence?: RuntimePluginTurnEvidenceSnapshot;
  readonly runtimeConfigEffects?: readonly PreparedRuntimePluginConfigEffect[];
};

export type ConversationLogRecordInput = VisibleMessage &
  RuntimeEventIdentity & {
    readonly committedAt: string;
  };

export type RuntimeDerivedTraceEntry = RuntimeTraceEntry & {
  readonly provenance: {
    readonly source: 'terminal_raw_event';
    readonly reason: 'missing_persisted_trace_entry';
    readonly rawEventAnchor: RuntimeEventIdentity & {
      readonly kind: 'runtime_turn_completed' | 'runtime_turn_rejected';
    };
  };
};

export type RuntimeStoredSessionEvidence = {
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly conversationMessages: readonly ConversationLogRecord[];
};

export type RuntimeDerivedSessionEvidence = {
  readonly traceEntries: readonly RuntimeDerivedTraceEntry[];
};

export type RuntimeSessionEvidenceSnapshot = {
  readonly stored: RuntimeStoredSessionEvidence;
  readonly derived: RuntimeDerivedSessionEvidence;
};

export type RuntimeLogStore = {
  readonly localRuntimeSessionPaths?: LocalRuntimeSessionPaths;
  readonly localRuntimeWriterLockOwnerToken?: LocalRuntimeMutationLockOwnerToken;
  appendTrace(entry: RuntimeTraceEntryInput): RuntimeTraceEntry;
  appendRawEvent(record: RawEventLogRecordInput): RawEventLogRecord;
  appendConversationMessage(
    record: ConversationLogRecordInput,
    expectedCharacter?: CharacterProfile
  ): ConversationLogRecord;
  removeConversationMessages(messageIds: readonly string[]): void;
  checkpointWriterEvidence?(): void;
  recoverAbandonedWriterEvidence?(): boolean;
  readSessionEvidence(): RuntimeSessionEvidenceSnapshot;
  traceEntries(): readonly RuntimeTraceEntry[];
  rawEvents(): readonly RawEventLogRecord[];
  conversationMessages(): readonly ConversationLogRecord[];
};

export type AcceptedRoleModelCommitValidationResult = {
  readonly status: 'accepted';
  readonly acceptedVisibleReplyText?: string;
};

export type RejectedRoleModelCommitValidationResult = {
  readonly status: 'rejected';
  readonly rejection: RoleModelDecisionRejection;
};

export type RoleModelCommitValidationResult =
  | AcceptedRoleModelCommitValidationResult
  | RejectedRoleModelCommitValidationResult;

export type RoleModelCommitValidationSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_commit_validation_snapshot';
  readonly sessionId: string;
  readonly result: RoleModelCommitValidationResult;
};

export type CreateRoleModelCommitValidationSnapshotOptions =
  RuntimeEventIdentity & {
    readonly sessionId: string;
    readonly result: RoleModelCommitValidationResult;
  };

export function createRoleModelCommitValidationSnapshot(
  options: CreateRoleModelCommitValidationSnapshotOptions
): RoleModelCommitValidationSnapshot {
  return Object.freeze({
    eventId: options.eventId,
    traceId: options.traceId,
    createdAt: assertCanonicalRuntimeTimestamp(
      options.createdAt,
      'Role-model commit validation createdAt'
    ),
    kind: 'role_model_commit_validation_snapshot',
    sessionId: options.sessionId,
    result: freezeRoleModelCommitValidationResult(options.result)
  } satisfies RoleModelCommitValidationSnapshot);
}

export function isTerminalRawEventLogRecordKind(
  kind: RawEventLogRecordKind
): boolean {
  return kind === 'runtime_turn_completed' || kind === 'runtime_turn_rejected';
}

export function isTerminalRawEventLogRecord(
  record: Pick<RawEventLogRecord, 'kind'>
): boolean {
  return isTerminalRawEventLogRecordKind(record.kind);
}

export function runtimePluginEvidenceOption(
  evidence: readonly RuntimePluginEvidenceSnapshot[] | undefined
): { readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[] } {
  if (evidence === undefined || evidence.length === 0) {
    return {};
  }

  return {
    runtimePluginEvidence: Object.freeze([...evidence])
  };
}

// Structural view of the plugin host limited to what turn evidence needs.
// Importing the host implementation here would re-create the
// runtime <-> plugins import cycle.
type RuntimePluginRegistryView = {
  registrySnapshot(): RuntimePluginRegistrySnapshot;
  enabledPluginIds(): readonly string[];
};

export function runtimePluginTurnEvidenceOption(options: {
  readonly identity: RuntimeEventIdentity;
  readonly pluginHost: RuntimePluginRegistryView | undefined;
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
          requestedAccess: registration.requestedAccess,
          grantedAccess: registration.grantedAccess,
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

export function createRuntimeLogStore(
  options: { readonly sessionId?: string } = {}
): RuntimeLogStore {
  const evidence: MutableDurableRuntimeSessionEvidence = {
    traceEntries: [],
    rawEvents: [],
    conversationMessages: []
  };
  const transitionMachine = createRuntimeEvidenceTransitionMachine({
    evidence,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
  });

  return Object.freeze({
    appendTrace(entry) {
      const storedEntry = transitionMachine.prepareTraceAppend(entry);

      transitionMachine.commitTraceAppend(storedEntry);

      return storedEntry;
    },
    appendRawEvent(record) {
      const storedRecord = transitionMachine.prepareRawEventAppend(record);

      transitionMachine.commitRawEventAppend(storedRecord);

      return storedRecord;
    },
    appendConversationMessage(record, expectedCharacter) {
      const storedRecord = transitionMachine.prepareConversationAppend(
        record,
        expectedCharacter
      );

      transitionMachine.commitConversationAppend(storedRecord);

      return storedRecord;
    },
    removeConversationMessages(messageIds) {
      transitionMachine.removeConversationMessages(messageIds);
    },
    readSessionEvidence() {
      transitionMachine.assertPublicReadable();

      return createRuntimeSessionEvidenceSnapshot({
        traceEntries: evidence.traceEntries,
        rawEvents: evidence.rawEvents,
        conversationMessages: evidence.conversationMessages
      });
    },
    traceEntries() {
      transitionMachine.assertPublicReadable();

      return Object.freeze([...evidence.traceEntries]);
    },
    rawEvents() {
      transitionMachine.assertPublicReadable();

      return Object.freeze([...evidence.rawEvents]);
    },
    conversationMessages() {
      transitionMachine.assertPublicReadable();

      return Object.freeze([...evidence.conversationMessages]);
    }
  } satisfies RuntimeLogStore);
}

function createRuntimeSessionEvidenceSnapshot(options: {
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly conversationMessages: readonly ConversationLogRecord[];
}): RuntimeSessionEvidenceSnapshot {
  return Object.freeze({
    stored: Object.freeze({
      traceEntries: Object.freeze([...options.traceEntries]),
      rawEvents: Object.freeze([...options.rawEvents]),
      conversationMessages: Object.freeze([...options.conversationMessages])
    }),
    derived: Object.freeze({
      traceEntries: Object.freeze([])
    })
  } satisfies RuntimeSessionEvidenceSnapshot);
}

function freezeRoleModelCommitValidationResult(
  result: RoleModelCommitValidationResult
): RoleModelCommitValidationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      ...(result.acceptedVisibleReplyText === undefined
        ? {}
        : {
            acceptedVisibleReplyText: redactJsonBoundaryText(
              result.acceptedVisibleReplyText
            )
          })
    } satisfies AcceptedRoleModelCommitValidationResult);
  }

  return Object.freeze({
    status: 'rejected',
    rejection: Object.freeze({
      reason: result.rejection.reason,
      ...(result.rejection.details === undefined
        ? {}
        : { details: result.rejection.details })
    } satisfies RoleModelDecisionRejection)
  } satisfies RejectedRoleModelCommitValidationResult);
}
