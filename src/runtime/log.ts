import type { VisibleMessage } from '../core/conversation.ts';
import {
  createParsedRoleModelDecisionSnapshot,
  createRoleModelIOSnapshot,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelIOSnapshot
} from '../role-model/contracts.ts';
import {
  createRuntimePluginEvidenceSnapshot,
  runtimePluginContractVersion,
  createRuntimePluginTurnEvidenceSnapshot,
  type RuntimePluginContextItem,
  type RuntimePluginJsonObject,
  type RuntimePluginHealthSnapshot,
  type RuntimePluginToolCallResult,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolInvocationSnapshot,
  type RuntimePluginTurnEvidenceSnapshot
} from '../plugins/types.ts';
import type { RuntimePluginHost } from '../plugins/host.ts';
import type { RuntimeEventIdentity, RuntimeEventType } from './event.ts';
import type { LocalRuntimeSessionPaths } from './storage/layout.ts';

export type RuntimeTurnStatus =
  | 'completed'
  | 'completed_with_failures'
  | 'rejected';

export type RuntimeTraceStepName =
  | 'runtime_event_received'
  | 'runtime_event_normalized'
  | 'runtime_turn_started'
  | 'plugin_before_role_model_call_rejected'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'visible_reply_committed'
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | 'commit_validation_rejected'
  | 'raw_event_log_appended'
  | 'runtime_turn_completed'
  | 'runtime_turn_rejected';

export type RuntimeTraceEntry = RuntimeEventIdentity & {
  readonly step: RuntimeTraceStepName;
};

export type RawEventLogRecordKind =
  | 'runtime_event_received'
  | 'runtime_event_normalized'
  | 'plugin_before_role_model_call_rejected'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'visible_reply_committed'
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | 'commit_validation_rejected'
  | 'runtime_turn_completed'
  | 'after_turn_committed'
  | 'runtime_turn_rejected';

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
};

export type ConversationLogRecordInput = VisibleMessage &
  RuntimeEventIdentity & {
    readonly committedAt: string;
  };

export type RuntimeLogStore = {
  readonly localRuntimeSessionPaths?: LocalRuntimeSessionPaths;
  appendTrace(entry: RuntimeTraceEntryInput): RuntimeTraceEntry;
  appendRawEvent(record: RawEventLogRecordInput): RawEventLogRecord;
  appendConversationMessage(record: ConversationLogRecordInput): ConversationLogRecord;
  removeConversationMessages(messageIds: readonly string[]): void;
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
    createdAt: options.createdAt,
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

export function runtimePluginTurnEvidenceOption(options: {
  readonly identity: RuntimeEventIdentity;
  readonly pluginHost: RuntimePluginHost | undefined;
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

export function createRuntimeLogStore(): RuntimeLogStore {
  const traceEntries: RuntimeTraceEntry[] = [];
  const rawEvents: RawEventLogRecord[] = [];
  const conversationMessages: ConversationLogRecord[] = [];

  return Object.freeze({
    appendTrace(entry) {
      const storedEntry = freezeTraceEntry(entry);

      traceEntries.push(storedEntry);

      return storedEntry;
    },
    appendRawEvent(record) {
      const storedRecord = freezeRawEventRecord(record);

      rawEvents.push(storedRecord);

      return storedRecord;
    },
    appendConversationMessage(record) {
      const storedRecord = freezeConversationLogRecord(record);

      conversationMessages.push(storedRecord);

      return storedRecord;
    },
    removeConversationMessages(messageIds) {
      const ids = new Set(messageIds);

      for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
        const message = conversationMessages[index];

        if (message !== undefined && ids.has(message.id)) {
          conversationMessages.splice(index, 1);
        }
      }
    },
    traceEntries() {
      return Object.freeze([...traceEntries]);
    },
    rawEvents() {
      return Object.freeze([...rawEvents]);
    },
    conversationMessages() {
      return Object.freeze([...conversationMessages]);
    }
  } satisfies RuntimeLogStore);
}

function freezeTraceEntry(entry: RuntimeTraceEntryInput): RuntimeTraceEntry {
  return Object.freeze({
    eventId: entry.eventId,
    traceId: entry.traceId,
    createdAt: entry.createdAt,
    step: entry.step
  } satisfies RuntimeTraceEntry);
}

function freezeRawEventRecord(record: RawEventLogRecordInput): RawEventLogRecord {
  const visibleMessageIds =
    record.visibleMessageIds === undefined
      ? undefined
      : Object.freeze([...record.visibleMessageIds]);
  const toolCallIds =
    record.toolCallIds === undefined
      ? undefined
      : Object.freeze([...record.toolCallIds]);
  const payloadSummary = freezeRawEventPayloadSummary(record.payloadSummary);
  const roleModelIOSnapshot = freezeRoleModelIOSnapshot(
    record.roleModelIOSnapshot
  );
  const parsedRoleModelDecisionSnapshot =
    freezeParsedRoleModelDecisionSnapshot(
      record.parsedRoleModelDecisionSnapshot
    );
  const commitValidation = freezeRoleModelCommitValidationSnapshot(
    record.commitValidation
  );
  const runtimePluginEvidence = freezeRuntimePluginEvidenceSnapshots(
    record.runtimePluginEvidence
  );
  const runtimePluginTurnEvidence = freezeRuntimePluginTurnEvidenceSnapshot(
    record.runtimePluginTurnEvidence
  );

  return Object.freeze({
    eventId: record.eventId,
    traceId: record.traceId,
    createdAt: record.createdAt,
    kind: record.kind,
    eventType: record.eventType,
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(visibleMessageIds === undefined ? {} : { visibleMessageIds }),
    ...(toolCallIds === undefined ? {} : { toolCallIds }),
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(record.toolRound === undefined ? {} : { toolRound: record.toolRound }),
    ...(record.toolName === undefined ? {} : { toolName: record.toolName }),
    ...(record.toolPluginId === undefined
      ? {}
      : { toolPluginId: record.toolPluginId }),
    ...(record.toolInput === undefined ? {} : { toolInput: record.toolInput }),
    ...(record.toolResult === undefined ? {} : { toolResult: record.toolResult }),
    ...(record.pluginStoreRevision === undefined
      ? {}
      : { pluginStoreRevision: record.pluginStoreRevision }),
    ...(payloadSummary === undefined ? {} : { payloadSummary }),
    ...(roleModelIOSnapshot === undefined ? {} : { roleModelIOSnapshot }),
    ...(parsedRoleModelDecisionSnapshot === undefined
      ? {}
      : { parsedRoleModelDecisionSnapshot }),
    ...(commitValidation === undefined ? {} : { commitValidation }),
    ...(runtimePluginEvidence === undefined
      ? {}
      : { runtimePluginEvidence }),
    ...(runtimePluginTurnEvidence === undefined
      ? {}
      : { runtimePluginTurnEvidence })
  } satisfies RawEventLogRecord);
}

function freezeRawEventPayloadSummary(
  payloadSummary: RawEventLogPayloadSummary | undefined
): RawEventLogPayloadSummary | undefined {
  if (payloadSummary === undefined) {
    return undefined;
  }

  return Object.freeze({
    ...(payloadSummary.rawInput === undefined
      ? {}
      : { rawInput: payloadSummary.rawInput }),
    ...(payloadSummary.normalizedCurrentUserMessage === undefined
      ? {}
      : {
          normalizedCurrentUserMessage:
            payloadSummary.normalizedCurrentUserMessage
        })
  } satisfies RawEventLogPayloadSummary);
}

function freezeConversationLogRecord(
  record: ConversationLogRecordInput
): ConversationLogRecord {
  return Object.freeze({
    eventId: record.eventId,
    traceId: record.traceId,
    createdAt: record.createdAt,
    id: record.id,
    role: record.role,
    speakerId: record.speakerId,
    speakerName: record.speakerName,
    text: record.text,
    committedAt: record.committedAt
  } satisfies ConversationLogRecord);
}

function freezeRoleModelIOSnapshot(
  snapshot: RoleModelIOSnapshot | undefined
): RoleModelIOSnapshot | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  return createRoleModelIOSnapshot(snapshot);
}

function freezeParsedRoleModelDecisionSnapshot(
  snapshot: ParsedRoleModelDecisionSnapshot | undefined
): ParsedRoleModelDecisionSnapshot | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  return createParsedRoleModelDecisionSnapshot(snapshot);
}

function freezeRoleModelCommitValidationSnapshot(
  snapshot: RoleModelCommitValidationSnapshot | undefined
): RoleModelCommitValidationSnapshot | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  return createRoleModelCommitValidationSnapshot(snapshot);
}

function freezeRuntimePluginEvidenceSnapshots(
  snapshots: readonly RuntimePluginEvidenceSnapshot[] | undefined
): readonly RuntimePluginEvidenceSnapshot[] | undefined {
  if (snapshots === undefined) {
    return undefined;
  }

  return Object.freeze(
    snapshots.map((snapshot) =>
      createRuntimePluginEvidenceSnapshot(snapshot)
    )
  );
}

function freezeRuntimePluginTurnEvidenceSnapshot(
  snapshot: RuntimePluginTurnEvidenceSnapshot | undefined
): RuntimePluginTurnEvidenceSnapshot | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  return createRuntimePluginTurnEvidenceSnapshot(snapshot);
}

function freezeRoleModelCommitValidationResult(
  result: RoleModelCommitValidationResult
): RoleModelCommitValidationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      ...(result.acceptedVisibleReplyText === undefined
        ? {}
        : { acceptedVisibleReplyText: result.acceptedVisibleReplyText })
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
