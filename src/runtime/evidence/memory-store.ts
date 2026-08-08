import type {CharacterProfile, SpeakerIdentity} from '../../core/index.ts';
import type {RuntimeLogStore} from './contract.ts';
import type {MutableDurableRuntimeSessionEvidence} from './contract.ts';
import {createRuntimeEvidenceTransitionMachine} from './transition.ts';
import {deriveRuntimeTraceEntries} from './trace-projection.ts';

/**
 * The second store implementation: both fold appends through the same
 * transition machine and share one snapshot derivation (arch rule 7).
 */
export function createRuntimeLogStore(
  options: {
    readonly sessionId?: string;
    readonly boundCharacter?: CharacterProfile;
    readonly boundUserSpeaker?: SpeakerIdentity;
  } = {},
): RuntimeLogStore {
  const evidence: MutableDurableRuntimeSessionEvidence = {
    rawEvents: [],
    conversationMessages: [],
  };
  const transitionMachine = createRuntimeEvidenceTransitionMachine({
    evidence,
    ...(options.sessionId === undefined ? {} : {sessionId: options.sessionId}),
    ...(options.boundCharacter === undefined
      ? {}
      : {boundCharacter: options.boundCharacter}),
    ...(options.boundUserSpeaker === undefined
      ? {}
      : {boundUserSpeaker: options.boundUserSpeaker}),
  });

  return Object.freeze({
    appendRawEvent(record, expectedCharacter) {
      const storedRecord = transitionMachine.prepareRawEventAppend(
        record,
        expectedCharacter,
      );

      transitionMachine.commitRawEventAppend(storedRecord, expectedCharacter);

      return storedRecord;
    },
    prepareRawEvent(record, expectedCharacter) {
      return transitionMachine.prepareRawEventAppend(record, expectedCharacter);
    },
    persistPreparedRawEvent(record, expectedCharacter) {
      transitionMachine.commitRawEventAppend(record, expectedCharacter);
    },
    readSessionEvidence() {
      return Object.freeze({
        rawEvents: Object.freeze([...evidence.rawEvents]),
        conversationMessages: Object.freeze([...evidence.conversationMessages]),
      });
    },
    traceEntries() {
      return deriveRuntimeTraceEntries(evidence.rawEvents);
    },
    rawEvents() {
      return Object.freeze([...evidence.rawEvents]);
    },
    conversationMessages() {
      return Object.freeze([...evidence.conversationMessages]);
    },
  } satisfies RuntimeLogStore);
}
