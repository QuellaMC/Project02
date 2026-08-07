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
import {roleModelCharacterSnapshot} from './identity.ts';

export type RuntimeEvidenceTransitionMachine = {
  readonly state: RuntimeEvidenceIncrementalState;
  prepareRawEventAppend(
    record: RawEventLogRecordInput,
    expectedCharacter?: CharacterProfile,
  ): RawEventLogRecord;
  /**
   * A caller that appends between preparing and committing invalidates what
   * prepare proved, so a durable store asserts again before its bytes land.
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

/**
 * A stored log is valid iff it replays through the same assert-then-apply a
 * live append runs; a log a crash cut short replays fewer records.
 */
export function replayRuntimeEvidence(options: {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly sessionId?: string;
  readonly boundCharacter?: CharacterProfile;
  readonly boundUserSpeaker?: SpeakerIdentity;
}): {
  readonly evidence: MutableDurableRuntimeSessionEvidence;
  readonly machine: RuntimeEvidenceTransitionMachine;
} {
  const evidence: MutableDurableRuntimeSessionEvidence = {
    rawEvents: [],
    conversationMessages: [],
  };
  const machine = createRuntimeEvidenceTransitionMachine({
    evidence,
    ...(options.sessionId === undefined ? {} : {sessionId: options.sessionId}),
    ...(options.boundCharacter === undefined
      ? {}
      : {boundCharacter: options.boundCharacter}),
    ...(options.boundUserSpeaker === undefined
      ? {}
      : {boundUserSpeaker: options.boundUserSpeaker}),
  });

  for (const record of options.rawEvents) {
    machine.commitRawEventAppend(record);
  }

  return {evidence, machine};
}

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
      const recordCharacter = roleModelCharacterSnapshot(record);

      assertIncrementalConversationAppend({
        evidence: options.evidence,
        state,
        record: message,
        ...(options.sessionId === undefined
          ? {}
          : {sessionId: options.sessionId}),
        ...(expectedCharacter === undefined ? {} : {expectedCharacter}),
        ...(recordCharacter === undefined ? {} : {recordCharacter}),
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
      // Apply mutates shared evidence, so assert again however long ago the
      // record was prepared.
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
