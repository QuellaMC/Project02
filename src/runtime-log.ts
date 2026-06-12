import type { VisibleMessage } from './conversation.ts';
import {
  createCharacterStatePatchSnapshot,
  type CharacterStatePatchSnapshot
} from './character-state.ts';
import {
  createParsedRoleModelDecisionSnapshot,
  createRoleModelIOSnapshot,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelIOSnapshot
} from './role-model-contracts.ts';
import {
  createAgentCapabilityEvidenceSnapshot,
  createAgentCapabilityTurnEvidenceSnapshot,
  type AgentCapabilityEvidenceSnapshot,
  type AgentCapabilityTurnEvidenceSnapshot
} from './agent-capabilities.ts';
import type { RuntimeEventIdentity, RuntimeEventType } from './runtime-event.ts';
import type { LocalRuntimeSessionPaths } from './local-storage.ts';

export type RuntimeTurnStatus = 'completed' | 'rejected';

export type RuntimeTraceStepName =
  | 'runtime_event_received'
  | 'runtime_event_normalized'
  | 'runtime_turn_started'
  | 'capability_before_role_model_call_rejected'
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
  | 'capability_before_role_model_call_rejected'
  | 'visible_reply_committed'
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | 'commit_validation_rejected'
  | 'runtime_turn_completed'
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
  readonly payloadSummary?: RawEventLogPayloadSummary;
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
  readonly characterStatePatchSnapshot?: CharacterStatePatchSnapshot;
  readonly agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[];
  readonly agentCapabilityTurnEvidence?: AgentCapabilityTurnEvidenceSnapshot;
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
  readonly payloadSummary?: RawEventLogPayloadSummary;
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
  readonly characterStatePatchSnapshot?: CharacterStatePatchSnapshot;
  readonly agentCapabilityEvidence?: readonly AgentCapabilityEvidenceSnapshot[];
  readonly agentCapabilityTurnEvidence?: AgentCapabilityTurnEvidenceSnapshot;
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
  traceEntries(): readonly RuntimeTraceEntry[];
  rawEvents(): readonly RawEventLogRecord[];
  conversationMessages(): readonly ConversationLogRecord[];
};

export type AcceptedRoleModelCommitValidationResult = {
  readonly status: 'accepted';
  readonly acceptedVisibleReplyText: string;
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
  const characterStatePatchSnapshot = freezeCharacterStatePatchSnapshot(
    record.characterStatePatchSnapshot
  );
  const agentCapabilityEvidence = freezeAgentCapabilityEvidenceSnapshots(
    record.agentCapabilityEvidence
  );
  const agentCapabilityTurnEvidence = freezeAgentCapabilityTurnEvidenceSnapshot(
    record.agentCapabilityTurnEvidence
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
    ...(payloadSummary === undefined ? {} : { payloadSummary }),
    ...(roleModelIOSnapshot === undefined ? {} : { roleModelIOSnapshot }),
    ...(parsedRoleModelDecisionSnapshot === undefined
      ? {}
      : { parsedRoleModelDecisionSnapshot }),
    ...(commitValidation === undefined ? {} : { commitValidation }),
    ...(characterStatePatchSnapshot === undefined
      ? {}
      : { characterStatePatchSnapshot }),
    ...(agentCapabilityEvidence === undefined
      ? {}
      : { agentCapabilityEvidence }),
    ...(agentCapabilityTurnEvidence === undefined
      ? {}
      : { agentCapabilityTurnEvidence })
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

function freezeCharacterStatePatchSnapshot(
  snapshot: CharacterStatePatchSnapshot | undefined
): CharacterStatePatchSnapshot | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  return createCharacterStatePatchSnapshot(snapshot);
}

function freezeAgentCapabilityEvidenceSnapshots(
  snapshots: readonly AgentCapabilityEvidenceSnapshot[] | undefined
): readonly AgentCapabilityEvidenceSnapshot[] | undefined {
  if (snapshots === undefined) {
    return undefined;
  }

  return Object.freeze(
    snapshots.map((snapshot) =>
      createAgentCapabilityEvidenceSnapshot(snapshot)
    )
  );
}

function freezeAgentCapabilityTurnEvidenceSnapshot(
  snapshot: AgentCapabilityTurnEvidenceSnapshot | undefined
): AgentCapabilityTurnEvidenceSnapshot | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  return createAgentCapabilityTurnEvidenceSnapshot(snapshot);
}

function freezeRoleModelCommitValidationResult(
  result: RoleModelCommitValidationResult
): RoleModelCommitValidationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      acceptedVisibleReplyText: result.acceptedVisibleReplyText
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
