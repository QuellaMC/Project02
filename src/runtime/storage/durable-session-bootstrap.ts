import {
  createUserSpeaker,
  validateConversationParticipants,
  type CharacterProfile,
  type ConversationSession,
  type SpeakerIdentity,
} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {durableRuntimeSessionCharacterProfile} from '../evidence/validation.ts';
import {createFileRuntimeLogStore} from './file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError,
  type LocalRuntimeSessionConversationEvidence,
} from './session-store.ts';
import {LocalRuntimeStorageContractError} from './layout-contract.ts';
import {ensureCharacterDataDir} from './character-data.ts';
import type {LocalRuntimeMutationLockLease} from './mutation-lock.ts';
import {createLocalRuntimeMutationLockOwnerToken} from './mutation-lock.ts';
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
};

export async function createDurableChatRuntime(
  args: DurableSessionSelection,
): Promise<DurableChatRuntime> {
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

  const sessionStore = createLocalRuntimeSessionStore({
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
  });
  // No flag names a session: the conversation resumes where it was last
  // active, whichever segment of a chain that is; a fresh store starts one.
  const sessionId = normalizeLocalRuntimeSessionId(
    args.newSessionId ??
      args.sessionId ??
      (await sessionStore.newestSession())?.sessionId,
  );
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    ...storageOptions,
    sessionId,
    ownerToken,
  });

  try {
    if (args.newSessionId !== undefined) {
      await sessionStore.createSession({sessionId});
    } else if (args.sessionId !== undefined) {
      await sessionStore.selectSession(sessionId);
    } else {
      await selectOrCreateDefaultSession(sessionStore, sessionId);
    }

    const logStore = createFileRuntimeLogStore({
      ...storageOptions,
      sessionId,
      writerLockOwnerToken: ownerToken,
      boundCharacter: character,
      boundUserSpeaker,
    });

    return Object.freeze({
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
