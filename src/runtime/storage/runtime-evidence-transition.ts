import type { CharacterProfile } from '../../core/conversation.ts';
import type {
  ConversationLogRecord,
  ConversationLogRecordInput,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RuntimeTraceEntry,
  RuntimeTraceEntryInput
} from '../log.ts';
import {
  decodeConversationLogRecord,
  encodeConversationLogRecord
} from './conversation-codec.ts';
import type {
  MutableDurableRuntimeSessionEvidence,
  RuntimeEvidenceIncrementalState
} from './runtime-evidence-contract.ts';
import {
  decodeRawEventLogRecord,
  encodeRawEventLogRecord
} from './raw-event-codec.ts';
import {
  applyIncrementalConversationAppend,
  applyIncrementalConversationRemoval,
  applyIncrementalRawEventAppend,
  applyIncrementalTraceAppend,
  assertIncrementalConversationAppend,
  assertIncrementalRawEventAppend,
  assertIncrementalStatePublicReadable,
  assertIncrementalTraceAppend,
  createRuntimeEvidenceIncrementalState
} from './runtime-evidence-validation.ts';
import {
  decodeRuntimeTraceEntry,
  encodeRuntimeTraceEntry
} from './trace-codec.ts';

export type RuntimeEvidenceTransitionMachine = {
  readonly state: RuntimeEvidenceIncrementalState;
  prepareTraceAppend(entry: RuntimeTraceEntryInput): RuntimeTraceEntry;
  commitTraceAppend(entry: RuntimeTraceEntry): void;
  prepareRawEventAppend(record: RawEventLogRecordInput): RawEventLogRecord;
  commitRawEventAppend(record: RawEventLogRecord): void;
  prepareConversationAppend(
    record: ConversationLogRecordInput,
    expectedCharacter?: CharacterProfile
  ): ConversationLogRecord;
  commitConversationAppend(record: ConversationLogRecord): void;
  removeConversationMessages(messageIds: readonly string[]): void;
  assertPublicReadable(): void;
};

export function createRuntimeEvidenceTransitionMachine(options: {
  readonly evidence: MutableDurableRuntimeSessionEvidence;
  readonly sessionId?: string;
}): RuntimeEvidenceTransitionMachine {
  const state = createRuntimeEvidenceIncrementalState(options.evidence);

  return Object.freeze({
    state,
    prepareTraceAppend(entry) {
      const storedEntry = decodeRuntimeTraceEntry(encodeRuntimeTraceEntry(entry));

      assertIncrementalTraceAppend(state, storedEntry);
      return storedEntry;
    },
    commitTraceAppend(entry) {
      options.evidence.traceEntries.push(entry);
      applyIncrementalTraceAppend(state, entry);
    },
    prepareRawEventAppend(record) {
      const storedRecord = decodeRawEventLogRecord(encodeRawEventLogRecord(record));

      assertIncrementalRawEventAppend({
        evidence: options.evidence,
        state,
        record: storedRecord,
        ...(options.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId })
      });
      return storedRecord;
    },
    commitRawEventAppend(record) {
      options.evidence.rawEvents.push(record);
      applyIncrementalRawEventAppend({
        evidence: options.evidence,
        state,
        record
      });
    },
    prepareConversationAppend(record, expectedCharacter) {
      const storedRecord = decodeConversationLogRecord(
        encodeConversationLogRecord(record)
      );

      assertIncrementalConversationAppend({
        evidence: options.evidence,
        state,
        record: storedRecord,
        ...(options.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId }),
        ...(expectedCharacter === undefined ? {} : { expectedCharacter })
      });
      return storedRecord;
    },
    commitConversationAppend(record) {
      options.evidence.conversationMessages.push(record);
      applyIncrementalConversationAppend(state, record);
    },
    removeConversationMessages(messageIds) {
      const ids = new Set(messageIds);

      for (
        let index = options.evidence.conversationMessages.length - 1;
        index >= 0;
        index -= 1
      ) {
        const message = options.evidence.conversationMessages[index];

        if (message !== undefined && ids.has(message.id)) {
          options.evidence.conversationMessages.splice(index, 1);
        }
      }

      applyIncrementalConversationRemoval(state, messageIds);
    },
    assertPublicReadable() {
      assertIncrementalStatePublicReadable(state);
    }
  } satisfies RuntimeEvidenceTransitionMachine);
}
