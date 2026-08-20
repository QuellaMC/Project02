import {
  createUserSpeaker,
  type CharacterProfile,
  type Session,
  type SpeakerIdentity,
} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {
  createSessionContinuationSnapshot,
  type SessionContinuationPlan,
} from '../evidence/records.ts';
import {createRuntimeEventIdentity} from '../../core/index.ts';
import {durableRuntimeSessionCharacterProfile} from '../evidence/validation.ts';
import {createFileRuntimeLogStore} from '../storage/file-runtime-log-store.ts';
import type {
  LocalRuntimeMutationLockLease,
  LocalRuntimeMutationLockOwnerToken,
} from '../storage/mutation-lock.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  type LocalRuntimeSessionConversationEvidence,
  type LocalRuntimeSessionStore,
} from '../storage/session-store.ts';

/** One character's live participation: its session, log, and writer lease. */
export type ConversationSegment = {
  readonly session: Session;
  readonly logStore: RuntimeLogStore;
  readonly writerLease: LocalRuntimeMutationLockLease;
};

export type SegmentContext = {
  readonly storageOptions: {
    readonly storeRoot: string;
    readonly characterId: string;
  };
  readonly sessionStore: LocalRuntimeSessionStore;
  /** Owns every lease of the open conversation, so re-entry never blocks. */
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly character: CharacterProfile;
  readonly boundUserSpeaker: SpeakerIdentity;
};

/** Takes the segment's writer lease; released again on any failure. */
export async function openSegment(
  context: SegmentContext,
  sessionId: string,
  prepare?: (logStore: RuntimeLogStore) => void,
): Promise<ConversationSegment> {
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    ...context.storageOptions,
    sessionId,
    ownerToken: context.ownerToken,
  });

  try {
    const logStore = createFileRuntimeLogStore({
      ...context.storageOptions,
      sessionId,
      writerLockOwnerToken: context.ownerToken,
      boundCharacter: context.character,
      boundUserSpeaker: context.boundUserSpeaker,
    });

    prepare?.(logStore);

    return Object.freeze({
      session: await context.sessionStore.rehydrateSession(sessionId, {
        conversationLogReader: {
          readConversationEvidence() {
            return readDurableConversationEvidence(
              logStore,
              context.character,
              context.boundUserSpeaker,
            );
          },
        },
      }),
      logStore,
      writerLease,
    } satisfies ConversationSegment);
  } catch (error: unknown) {
    await writerLease.release();
    throw error;
  }
}

/**
 * Opens the segment that continues the plan's source: its first record
 * carries the summary and the turns brought along. A segment that could not
 * receive that record is discarded again, so nothing ever resumes into an
 * empty continuation.
 */
export async function openContinuedSegment(
  context: SegmentContext,
  plan: SessionContinuationPlan,
): Promise<ConversationSegment> {
  const metadata = await context.sessionStore.createContinuedSession({
    continuedFrom: plan.continuedFrom.sessionId,
  });

  try {
    return await openSegment(context, metadata.sessionId, logStore => {
      const identity = createRuntimeEventIdentity();

      logStore.appendRawEvent({
        ...identity,
        kind: 'session_continued',
        eventType: 'USER_MESSAGE',
        sessionContinuation: createSessionContinuationSnapshot({
          ...identity,
          sessionId: metadata.sessionId,
          continuedFrom: plan.continuedFrom,
          summary: plan.summary,
          summarizedTurnCount: plan.summarizedTurnCount,
          carriedTurns: plan.carriedTurns,
          summarizer: plan.summarizer,
        }),
      });
    });
  } catch (error: unknown) {
    try {
      await context.sessionStore.discardEmptySession(metadata.sessionId);
    } catch (discardError: unknown) {
      throw new AggregateError(
        [error],
        `Continued session ${metadata.sessionId} could not be opened, and the empty session could not be discarded.`,
        {cause: discardError},
      );
    }

    throw error;
  }
}

function readDurableConversationEvidence(
  logStore: RuntimeLogStore,
  boundCharacter: CharacterProfile,
  boundUserSpeaker?: SpeakerIdentity,
): LocalRuntimeSessionConversationEvidence {
  const evidence = logStore.readSessionEvidence();
  const recordedUserMessage = evidence.conversationMessages.find(
    message => message.role === 'user',
  );

  return Object.freeze({
    // Existing sessions keep their evidence-derived profiles; the bound
    // identities apply to evidence-empty sessions only.
    character: durableRuntimeSessionCharacterProfile(evidence, boundCharacter),
    userSpeaker:
      recordedUserMessage === undefined
        ? (boundUserSpeaker ?? createUserSpeaker())
        : Object.freeze({
            id: recordedUserMessage.speakerId,
            displayName: recordedUserMessage.speakerName,
          } satisfies SpeakerIdentity),
    messages: evidence.conversationMessages,
  } satisfies LocalRuntimeSessionConversationEvidence);
}
