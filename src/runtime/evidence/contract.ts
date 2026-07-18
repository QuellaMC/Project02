import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RuntimeTraceEntry,
} from './records.ts';
import type {CharacterProfile} from '../../core/index.ts';

export type RuntimeLogReadMode =
  'append' | 'appendTrace' | 'public' | 'publicDecode';

export type RuntimeLogValidationMode =
  'appendConversation' | 'appendRawEvent' | 'appendTrace' | 'public';

export type DurableRuntimeSessionEvidence = {
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly conversationMessages: readonly ConversationLogRecord[];
};

export type MutableDurableRuntimeSessionEvidence = {
  readonly traceEntries: RuntimeTraceEntry[];
  readonly rawEvents: RawEventLogRecord[];
  readonly conversationMessages: ConversationLogRecord[];
};

export type RuntimeEvidenceFileStamp =
  | {readonly exists: false}
  | {
      readonly exists: true;
      readonly device: bigint;
      readonly inode: bigint;
      readonly size: bigint;
      readonly modifiedAtNanoseconds: bigint;
      readonly changedAtNanoseconds: bigint;
    };

export type RuntimeEvidenceFileStamps = {
  readonly trace: RuntimeEvidenceFileStamp;
  readonly rawEvents: RuntimeEvidenceFileStamp;
  readonly conversation: RuntimeEvidenceFileStamp;
};

export type CachedRuntimeSessionEvidence = {
  readonly stamps: RuntimeEvidenceFileStamps;
  readonly evidence: MutableDurableRuntimeSessionEvidence;
};

export type RuntimeEvidenceIncrementalState = {
  readonly createdAtByIdentity: Map<string, string>;
  readonly traceStepsByIdentity: Map<string, Set<RuntimeTraceEntry['step']>>;
  readonly traceStartedWithoutRaw: Set<string>;
  readonly terminalTraceByIdentity: Map<
    string,
    'runtime_turn_completed' | 'runtime_turn_rejected'
  >;
  readonly rawKindsByIdentity: Map<string, Set<RawEventLogRecord['kind']>>;
  readonly terminalRawByIdentity: Map<
    string,
    'runtime_turn_completed' | 'runtime_turn_rejected'
  >;
  readonly missingStoredTerminalTraceEvidence: Set<string>;
  readonly startedToolCalls: Map<
    string,
    {readonly identityKey: string; readonly record: RawEventLogRecord}
  >;
  readonly finishedToolCalls: Set<string>;
  readonly unfinishedToolCallIdsByIdentity: Map<string, Set<string>>;
  readonly messagesById: Map<string, ConversationLogRecord>;
  readonly messageIdsByIdentity: Map<string, string[]>;
  roleModelCharacter: CharacterProfile | undefined;
  conversationCharacter: CharacterProfile | undefined;
  openRawIdentity: string | undefined;
  openTurnConversationStart: number;
};

export type RuntimeTurnEvidenceState =
  'completed' | 'empty' | 'raw_started' | 'rejected' | 'trace_started';
