import {
  createRuntimeEventIdentity,
  createUserSpeaker,
  validateConversationParticipants,
  type CharacterProfile,
  type ConversationSession,
  type SpeakerIdentity,
} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {
  createSessionContinuationSnapshot,
  type SessionContinuationPlan,
} from '../evidence/records.ts';
import {durableRuntimeSessionCharacterProfile} from '../evidence/validation.ts';
import {createFileRuntimeLogStore} from './file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError,
  type LocalRuntimeSessionConversationEvidence,
} from './session-store.ts';
import {LocalRuntimeStorageContractError} from './layout-contract.ts';
import {ensureCharacterDataDir} from './character-data.ts';
import {
  createLocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLockLease,
  type LocalRuntimeMutationLockOwnerToken,
} from './mutation-lock.ts';
import {acquireLocalRuntimeSessionWriterLease} from './session-store.ts';
import {
  normalizeLocalRuntimeCharacterId,
  normalizeLocalRuntimeSessionId,
} from './layout-contract.ts';

export type DurableSessionSelection = {
  readonly homeRoot?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
  readonly character: CharacterProfile;
  readonly userDisplayName?: string;
};

export type DurableChatRuntime = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly writerLease: LocalRuntimeMutationLockLease;
  /** The session that continued this one, when it was opened by name anyway. */
  readonly continuedBy?: string;
  /**
   * Stamps the session as the one the conversation is in, so a flagless
   * launch resumes it ahead of a session that was merely written to later.
   */
  markActive(): Promise<void>;
};

export type DurableSessionContinuation = {
  readonly homeRoot?: string;
  readonly character: CharacterProfile;
  readonly userDisplayName?: string;
  readonly plan: SessionContinuationPlan;
};

export async function createDurableChatRuntime(
  args: DurableSessionSelection,
): Promise<DurableChatRuntime> {
  const store = await openDurableSessionStore(args);
  // No flag names a session: the conversation resumes where it was last
  // active, whichever segment of a chain that is; a fresh store starts one.
  const sessionId = normalizeLocalRuntimeSessionId(
    args.newSessionId ??
      args.sessionId ??
      (await store.sessionStore.newestSession())?.sessionId,
  );

  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    ...store.storageOptions,
    sessionId,
    ownerToken,
  });

  return await openDurableChatRuntime({
    store,
    sessionId,
    ownerToken,
    writerLease,
    prepare: async () => {
      if (args.newSessionId !== undefined) {
        await store.sessionStore.createSession({sessionId});
      } else if (args.sessionId !== undefined) {
        await store.sessionStore.selectSession(sessionId);
      } else {
        await selectOrCreateDefaultSession(store.sessionStore, sessionId);
      }
    },
  });
}

/**
 * Opens the session that continues the plan's source: a chain-named session
 * whose first record carries the summary and the turns brought along, ready
 * for the next turn to build on. Its writer lease is held from the moment the
 * catalog shows it, and a session that could not receive that record is
 * discarded again, so no launch ever resumes into an empty continuation.
 */
export async function createContinuedDurableChatRuntime(
  args: DurableSessionContinuation,
): Promise<DurableChatRuntime> {
  const store = await openDurableSessionStore(args);
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const {metadata, writerLease} =
    await store.sessionStore.createContinuedSession({
      continuedFrom: args.plan.continuedFrom.sessionId,
      writerOwnerToken: ownerToken,
    });

  try {
    return await openDurableChatRuntime({
      store,
      sessionId: metadata.sessionId,
      ownerToken,
      writerLease,
      prepare: logStore => {
        const identity = createRuntimeEventIdentity();

        logStore.appendRawEvent({
          ...identity,
          kind: 'session_continued',
          eventType: 'USER_MESSAGE',
          sessionContinuation: createSessionContinuationSnapshot({
            ...identity,
            sessionId: metadata.sessionId,
            continuedFrom: args.plan.continuedFrom,
            summary: args.plan.summary,
            summarizedTurnCount: args.plan.summarizedTurnCount,
            carriedTurns: args.plan.carriedTurns,
            summarizer: args.plan.summarizer,
          }),
        });
      },
    });
  } catch (error: unknown) {
    try {
      await store.sessionStore.discardEmptySession(metadata.sessionId);
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

type DurableSessionStore = {
  readonly character: CharacterProfile;
  readonly boundUserSpeaker: SpeakerIdentity;
  readonly storageOptions: {
    readonly storeRoot: string;
    readonly characterId: string;
  };
  readonly sessionStore: ReturnType<typeof createLocalRuntimeSessionStore>;
};

async function openDurableSessionStore(args: {
  readonly homeRoot?: string;
  readonly character: CharacterProfile;
  readonly userDisplayName?: string;
}): Promise<DurableSessionStore> {
  // Canonicalized before the first directory exists, so the data directory,
  // the marker, the log store, and the session all bind the same spelling.
  const characterId = normalizeLocalRuntimeCharacterId(args.character.id);
  const {character, userSpeaker: boundUserSpeaker} =
    validateConversationParticipants({
      character: {id: characterId, displayName: args.character.displayName},
      ...(args.userDisplayName === undefined
        ? {}
        : {userDisplayName: args.userDisplayName}),
    });
  const dataRoot = await ensureCharacterDataDir({
    ...(args.homeRoot === undefined ? {} : {homeRoot: args.homeRoot}),
    characterId,
  });
  const storageOptions = {
    storeRoot: dataRoot,
    characterId,
  };

  return {
    character,
    boundUserSpeaker,
    storageOptions,
    sessionStore: createLocalRuntimeSessionStore({
      ...storageOptions,
      sessionReadinessValidator: {
        assertSessionReadable(selectedSessionId) {
          const logStore = createFileRuntimeLogStore({
            ...storageOptions,
            sessionId: selectedSessionId,
            boundCharacter: character,
            boundUserSpeaker,
          });

          logStore.readSessionEvidence();
        },
      },
    }),
  };
}

/** Takes ownership of an already-held writer lease: released on any failure. */
async function openDurableChatRuntime(options: {
  readonly store: DurableSessionStore;
  readonly sessionId: string;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly writerLease: LocalRuntimeMutationLockLease;
  readonly prepare: (logStore: RuntimeLogStore) => Promise<void> | void;
}): Promise<DurableChatRuntime> {
  const {store, sessionId, ownerToken, writerLease} = options;
  const {character, boundUserSpeaker, storageOptions, sessionStore} = store;

  try {
    const logStore = createFileRuntimeLogStore({
      ...storageOptions,
      sessionId,
      writerLockOwnerToken: ownerToken,
      boundCharacter: character,
      boundUserSpeaker,
    });

    await options.prepare(logStore);
    const successor = await sessionStore.successorOf(sessionId);

    return Object.freeze({
      ...(successor === undefined ? {} : {continuedBy: successor.sessionId}),
      session: await sessionStore.rehydrateConversationSession(sessionId, {
        conversationLogReader: {
          readConversationEvidence() {
            return readDurableConversationEvidence(
              logStore,
              character,
              boundUserSpeaker,
            );
          },
        },
      }),
      logStore,
      writerLease,
      async markActive() {
        await sessionStore.selectSession(sessionId);
      },
    } satisfies DurableChatRuntime);
  } catch (error: unknown) {
    await writerLease.release();
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

async function selectOrCreateDefaultSession(
  sessionStore: ReturnType<typeof createLocalRuntimeSessionStore>,
  sessionId: string,
): Promise<void> {
  try {
    await sessionStore.readSession(sessionId);
  } catch (error: unknown) {
    if (isMissingDefaultSessionStore(error)) {
      await sessionStore.createSession({sessionId});
      return;
    }

    throw error;
  }

  await sessionStore.selectSession(sessionId);
}

function isMissingDefaultSessionStore(error: unknown): boolean {
  return (
    (error instanceof LocalRuntimeStorageContractError &&
      error.code === 'missing_file') ||
    (error instanceof LocalRuntimeSessionStoreError &&
      error.code === 'session_not_found')
  );
}
