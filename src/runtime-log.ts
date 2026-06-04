import type { VisibleMessage } from './conversation.ts';
import type { RuntimeEventIdentity, RuntimeEventType } from './runtime-event.ts';

export type RuntimeTurnStatus = 'completed' | 'rejected';

export type RuntimeTraceStepName =
  | 'runtime_event_received'
  | 'runtime_event_normalized'
  | 'runtime_turn_started'
  | 'visible_reply_committed'
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | 'raw_event_log_appended'
  | 'runtime_turn_completed'
  | 'runtime_turn_rejected';

export type RuntimeTraceEntry = RuntimeEventIdentity & {
  readonly step: RuntimeTraceStepName;
};

export type RawEventLogRecordKind =
  | 'runtime_event_received'
  | 'runtime_event_normalized'
  | 'visible_reply_committed'
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | 'runtime_turn_completed'
  | 'runtime_turn_rejected';

export type RawEventLogRecord = RuntimeEventIdentity & {
  readonly kind: RawEventLogRecordKind;
  readonly eventType: RuntimeEventType;
  readonly status?: RuntimeTurnStatus;
  readonly reason?: string;
  readonly visibleMessageIds?: readonly string[];
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
};

export type ConversationLogRecordInput = VisibleMessage &
  RuntimeEventIdentity & {
    readonly committedAt: string;
  };

export type RuntimeLogStore = {
  appendTrace(entry: RuntimeTraceEntryInput): RuntimeTraceEntry;
  appendRawEvent(record: RawEventLogRecordInput): RawEventLogRecord;
  appendConversationMessage(record: ConversationLogRecordInput): ConversationLogRecord;
  traceEntries(): readonly RuntimeTraceEntry[];
  rawEvents(): readonly RawEventLogRecord[];
  conversationMessages(): readonly ConversationLogRecord[];
};

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

  return Object.freeze({
    eventId: record.eventId,
    traceId: record.traceId,
    createdAt: record.createdAt,
    kind: record.kind,
    eventType: record.eventType,
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(visibleMessageIds === undefined ? {} : { visibleMessageIds })
  } satisfies RawEventLogRecord);
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
