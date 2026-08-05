import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RuntimeTraceEntry,
} from './records.ts';
import type {LocalRuntimeSessionPaths} from '../storage/layout-contract.ts';
import type {LocalRuntimeMutationLockOwnerToken} from '../storage/mutation-lock.ts';
import type {CharacterProfile, SpeakerIdentity} from '../../core/index.ts';

export type RuntimeLogReadMode = 'append' | 'public' | 'publicDecode';

export type RuntimeLogValidationMode =
  'appendConversation' | 'appendRawEvent' | 'public';

export type DurableRuntimeSessionEvidence = {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly conversationMessages: readonly ConversationLogRecord[];
};

export type MutableDurableRuntimeSessionEvidence = {
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
  readonly rawEvents: RuntimeEvidenceFileStamp;
};

export type CachedRuntimeSessionEvidence = {
  readonly stamps: RuntimeEvidenceFileStamps;
  readonly evidence: MutableDurableRuntimeSessionEvidence;
};

export type RuntimeEvidenceIncrementalState = {
  readonly createdAtByIdentity: Map<string, string>;
  readonly rawKindsByIdentity: Map<string, Set<RawEventLogRecord['kind']>>;
  readonly terminalRawByIdentity: Map<
    string,
    'runtime_turn_completed' | 'runtime_turn_rejected'
  >;
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
  readonly boundCharacter: CharacterProfile | undefined;
  userSpeaker: SpeakerIdentity | undefined;
  readonly boundUserSpeaker: SpeakerIdentity | undefined;
  openRawIdentity: string | undefined;
  openTurnConversationStart: number;
};

export type RuntimeLogStore = {
  readonly localRuntimeSessionPaths?: LocalRuntimeSessionPaths;
  readonly localRuntimeWriterLockOwnerToken?: LocalRuntimeMutationLockOwnerToken;
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
  readSessionEvidence(): DurableRuntimeSessionEvidence;
  /** The turn trace, derived from the event log — never stored. */
  traceEntries(): readonly RuntimeTraceEntry[];
  rawEvents(): readonly RawEventLogRecord[];
  conversationMessages(): readonly ConversationLogRecord[];
};
