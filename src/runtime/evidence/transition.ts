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
  /**
   * Re-runs the append checks a prepared record passed when it was
   * prepared, against the machine's current state. A caller that appends
   * between preparing and committing invalidates what prepare proved, so
   * a durable store asserts this again before its bytes land.
   */
  assertRawEventAppend(
    record: RawEventLogRecord,
    expectedCharacter?: CharacterProfile,
  ): void;
  commitRawEventAppend(
    record: RawEventLogRecord,
    expectedCharacter?: CharacterProfile,
  ): void;
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

  function assertStoredRawEventAppend(
    record: RawEventLogRecord,
    expectedCharacter?: CharacterProfile,
  ): void {
    assertIncrementalRawEventAppend({
      evidence: options.evidence,
      state,
      record,
      ...(options.sessionId === undefined
        ? {}
        : {sessionId: options.sessionId}),
    });

    const message = conversationMessageForRawEvent(record);

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
  }

  return Object.freeze({
    state,
    prepareRawEventAppend(record, expectedCharacter) {
      const storedRecord = decodeRawEventLogRecord(
        encodeRawEventLogRecord(record),
      );

      assertStoredRawEventAppend(storedRecord, expectedCharacter);
      return storedRecord;
    },
    assertRawEventAppend(record, expectedCharacter) {
      assertStoredRawEventAppend(record, expectedCharacter);
    },
    commitRawEventAppend(record, expectedCharacter) {
      // Committing asserts again: apply mutates shared evidence, so a
      // record no valid append could produce must never enter it, however
      // long ago it was prepared.
      assertStoredRawEventAppend(record, expectedCharacter);
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
