import {
  assertCanonicalRuntimeTimestamp,
  type CharacterProfile,
  type RuntimeEventIdentity,
  type RuntimeEventType,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelIOSnapshot,
} from '../../role-model/index.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginJsonObject,
  RuntimePluginToolCallResult,
  RuntimePluginTurnEvidenceSnapshot,
} from '../../plugins/api/index.ts';
import type {LocalRuntimeSessionPaths} from '../storage/layout-contract.ts';
import type {LocalRuntimeMutationLockOwnerToken} from '../storage/mutation-lock.ts';

export const runtimeTurnStatusValues = [
  'completed',
  'completed_with_failures',
  'rejected',
] as const;

export type RuntimeTurnStatus = (typeof runtimeTurnStatusValues)[number];

export const runtimeTraceStepValues = [
  'runtime_event_received',
  'runtime_event_normalized',
  'runtime_turn_started',
  'plugin_before_role_model_call_rejected',
  'tool_call_started',
  'tool_call_finished',
  'visible_message_committed',
  'input_validation_rejected',
  'character_reply_rejected',
  'commit_validation_rejected',
  'raw_event_log_appended',
  'runtime_turn_completed',
  'runtime_turn_rejected',
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
  'visible_message_committed',
  'input_validation_rejected',
  'character_reply_rejected',
  'commit_validation_rejected',
  'runtime_turn_completed',
  'after_turn_committed',
  'runtime_turn_rejected',
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
  /** The message this event commits; present exactly on commit events. */
  readonly visibleMessage?: VisibleMessage;
  readonly committedAt?: string;
  /** The sampling round that asked for a committed reply. */
  readonly decisionRound?: number;
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
  /** The message this event commits; present exactly on commit events. */
  readonly visibleMessage?: VisibleMessage;
  readonly committedAt?: string;
  /** The sampling round that asked for a committed reply. */
  readonly decisionRound?: number;
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
  appendRawEvent(
    record: RawEventLogRecordInput,
    expectedCharacter?: CharacterProfile,
  ): RawEventLogRecord;
  /**
   * Validates a record and returns it in stored form without writing.
   * Callers that must show a message before it is durable validate here,
   * then persist with {@link persistPreparedRawEvent}.
   */
  prepareRawEvent(
    record: RawEventLogRecordInput,
    expectedCharacter?: CharacterProfile,
  ): RawEventLogRecord;
  persistPreparedRawEvent(record: RawEventLogRecord): void;
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
  options: CreateRoleModelCommitValidationSnapshotOptions,
): RoleModelCommitValidationSnapshot {
  return Object.freeze({
    eventId: options.eventId,
    traceId: options.traceId,
    createdAt: assertCanonicalRuntimeTimestamp(
      options.createdAt,
      'Role-model commit validation createdAt',
    ),
    kind: 'role_model_commit_validation_snapshot',
    sessionId: options.sessionId,
    result: freezeRoleModelCommitValidationResult(options.result),
  } satisfies RoleModelCommitValidationSnapshot);
}

export function isTerminalRawEventLogRecordKind(
  kind: RawEventLogRecordKind,
): boolean {
  return kind === 'runtime_turn_completed' || kind === 'runtime_turn_rejected';
}

export function isTerminalRawEventLogRecord(
  record: Pick<RawEventLogRecord, 'kind'>,
): boolean {
  return isTerminalRawEventLogRecordKind(record.kind);
}

function freezeRoleModelCommitValidationResult(
  result: RoleModelCommitValidationResult,
): RoleModelCommitValidationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      ...(result.acceptedVisibleReplyText === undefined
        ? {}
        : {
            acceptedVisibleReplyText: result.acceptedVisibleReplyText,
          }),
    } satisfies AcceptedRoleModelCommitValidationResult);
  }

  return Object.freeze({
    status: 'rejected',
    rejection: Object.freeze({
      reason: result.rejection.reason,
      ...(result.rejection.details === undefined
        ? {}
        : {details: result.rejection.details}),
    } satisfies RoleModelDecisionRejection),
  } satisfies RejectedRoleModelCommitValidationResult);
}
