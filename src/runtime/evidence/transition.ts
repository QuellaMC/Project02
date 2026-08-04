import type {CharacterProfile, SpeakerIdentity} from '../../core/index.ts';
import type {
  RawEventLogRecord,
  RawEventLogRecordInput,
  RuntimeTraceEntry,
  RuntimeTraceEntryInput,
} from './records.ts';
import {conversationMessageForRawEvent} from './cache.ts';
import type {
  MutableDurableRuntimeSessionEvidence,
  RuntimeEvidenceIncrementalState,
} from './contract.ts';
import {
  decodeRawEventLogRecord,
  encodeRawEventLogRecord,
} from '../storage/raw-event-codec.ts';
import {
  applyIncrementalConversationAppend,
  applyIncrementalRawEventAppend,
  applyIncrementalTraceAppend,
  assertIncrementalConversationAppend,
  assertIncrementalRawEventAppend,
  assertIncrementalStatePublicReadable,
  assertIncrementalTraceAppend,
  createRuntimeEvidenceIncrementalState,
} from './validation.ts';
import {
  decodeRuntimeTraceEntry,
  encodeRuntimeTraceEntry,
} from '../storage/trace-codec.ts';

export type RuntimeEvidenceTransitionMachine = {
  readonly state: RuntimeEvidenceIncrementalState;
  prepareTraceAppend(entry: RuntimeTraceEntryInput): RuntimeTraceEntry;
  commitTraceAppend(entry: RuntimeTraceEntry): void;
  prepareRawEventAppend(
    record: RawEventLogRecordInput,
    expectedCharacter?: CharacterProfile,
  ): RawEventLogRecord;
  commitRawEventAppend(record: RawEventLogRecord): void;
  assertPublicReadable(): void;
};

export function createRuntimeEvidenceTransitionMachine(options: {
  readonly evidence: MutableDurableRuntimeSessionEvidence;
  readonly sessionId?: string;
  readonly boundCharacter?: CharacterProfile;
  readonly boundUserSpeaker?: SpeakerIdentity;
}): RuntimeEvidenceTransitionMachine {
  const state = createRuntimeEvidenceIncrementalState(
    options.evidence,
    options.boundCharacter,
    options.boundUserSpeaker,
  );

  return Object.freeze({
    state,
    prepareTraceAppend(entry) {
      const storedEntry = decodeRuntimeTraceEntry(
        encodeRuntimeTraceEntry(entry),
      );

      assertIncrementalTraceAppend(state, storedEntry);
      return storedEntry;
    },
    commitTraceAppend(entry) {
      options.evidence.traceEntries.push(entry);
      applyIncrementalTraceAppend(state, entry);
    },
    prepareRawEventAppend(record, expectedCharacter) {
      const storedRecord = decodeRawEventLogRecord(
        encodeRawEventLogRecord(record),
      );

      assertIncrementalRawEventAppend({
        evidence: options.evidence,
        state,
        record: storedRecord,
        ...(options.sessionId === undefined
          ? {}
          : {sessionId: options.sessionId}),
      });

      const message = conversationMessageForRawEvent(storedRecord);

      if (message !== undefined) {
        assertIncrementalConversationAppend({
          evidence: options.evidence,
          state,
          record: message,
          ...(options.sessionId === undefined
            ? {}
            : {sessionId: options.sessionId}),
          ...(expectedCharacter === undefined ? {} : {expectedCharacter}),
        });
      }

      return storedRecord;
    },
    commitRawEventAppend(record) {
      options.evidence.rawEvents.push(record);
      applyIncrementalRawEventAppend({
        evidence: options.evidence,
        state,
        record,
      });

      const message = conversationMessageForRawEvent(record);

      if (message !== undefined) {
        options.evidence.conversationMessages.push(message);
        applyIncrementalConversationAppend(state, message);
      }
    },
    assertPublicReadable() {
      assertIncrementalStatePublicReadable(state, options.evidence);
    },
  } satisfies RuntimeEvidenceTransitionMachine);
}
