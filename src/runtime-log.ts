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
  | 'runtime_turn_completed'
  | 'runtime_turn_rejected';

export type RawEventLogRecord = RuntimeEventIdentity & {
  readonly kind: RawEventLogRecordKind;
  readonly eventType: RuntimeEventType;
  readonly status: RuntimeTurnStatus;
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
  readonly status: RuntimeTurnStatus;
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
