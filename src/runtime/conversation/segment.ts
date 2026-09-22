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
import type {ConversationLogRecord} from '../evidence/records.ts';
import {createFileRuntimeLogStore} from '../storage/file-runtime-log-store.ts';
import {
  LocalRuntimeStorageContractError,
  parseSegmentSessionId,
  segmentSessionId,
} from '../storage/layout-contract.ts';
import {readCommittedConversationMessages} from '../storage/session-history-feed.ts';
import {readTakenLines, type TakenLines} from '../storage/taken-lines.ts';
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
 * carries the summary and the turns brought along. That record is the
 * commit point and the last thing that can fail — the segment is fully
 * open before it lands — so a failure always rolls back to an uncommitted
 * segment, and a committed continuation is always the one handed back.
 */
export async function openContinuedSegment(
  context: SegmentContext,
  plan: SessionContinuationPlan,
): Promise<ConversationSegment> {
  const metadata = await context.sessionStore.createContinuedSession({
    continuedFrom: plan.continuedFrom.sessionId,
  });

  try {
    const segment = await openSegment(context, metadata.sessionId);

    try {
      const identity = createRuntimeEventIdentity();

      segment.logStore.appendRawEvent({
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
    } catch (error: unknown) {
      await segment.writerLease.release();
      throw error;
    }

    return segment;
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

/** The client ids of the user lines among these records, each with its message id. */
export function userLinesOf(
  records: readonly ConversationLogRecord[],
): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();

  for (const record of records) {
    if (record.role === 'user' && record.clientMessageId !== undefined) {
      lines.set(record.clientMessageId, record.id);
    }
  }

  return lines;
}

/**
 * The user lines of every segment before this one, so a line an earlier
 * run committed — just before a rotation, or long ago — is refused rather
 * than run again. The conversation's record of them is read once and
 * completed from the segments it does not cover, which is every one of
 * them for a conversation older than the record; the next rotation
 * writes the whole of it, so an open never depends on a write. The
 * segment before this one must be whole, as the current one must: a
 * daemon can go down between a rotation and its answer, before the record
 * has that segment. An older segment that cannot be read gives up its
 * lines, as history gives up its page, rather than closing the
 * conversation.
 */
export function takenLinesBefore(
  context: SegmentContext,
  sessionId: string,
): TakenLines {
  const {conversationId, segment} = parseSegmentSessionId(sessionId);
  const taken = new Map(
    readTakenLines({
      storeRoot: context.storageOptions.storeRoot,
      conversationId,
    }),
  );

  for (let earlier = 1; earlier < segment; earlier += 1) {
    if (taken.has(earlier)) {
      continue;
    }

    try {
      taken.set(
        earlier,
        userLinesOf(
          readCommittedConversationMessages({
            ...context.storageOptions,
            sessionId: segmentSessionId(conversationId, earlier),
            onMissing: 'reject',
          }),
        ),
      );
    } catch (error: unknown) {
      if (
        earlier === segment - 1 ||
        !(error instanceof LocalRuntimeStorageContractError)
      ) {
        throw error;
      }
    }
  }

  return taken;
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
