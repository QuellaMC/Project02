import type {CharacterProfile, SpeakerIdentity} from '../../core/index.ts';
import type {RawEventLogRecord, RawEventLogRecordInput} from './records.ts';
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
  assertIncrementalConversationAppend,
  assertIncrementalRawEventAppend,
  createRuntimeEvidenceIncrementalState,
} from './validation.ts';

export type RuntimeEvidenceTransitionMachine = {
  readonly state: RuntimeEvidenceIncrementalState;
  prepareRawEventAppend(
    record: RawEventLogRecordInput,
    expectedCharacter?: CharacterProfile,
  ): RawEventLogRecord;
  commitRawEventAppend(record: RawEventLogRecord): void;
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
  } satisfies RuntimeEvidenceTransitionMachine);
}
