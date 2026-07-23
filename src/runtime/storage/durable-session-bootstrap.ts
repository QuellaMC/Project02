import {
  createUserSpeaker,
  type CharacterProfile,
  type ConversationSession,
  type SpeakerIdentity,
} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/records.ts';
import {
  createFileRuntimeLogStore,
  durableRuntimeSessionCharacterProfile,
} from './file-runtime-log-store.ts';
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
import {normalizeLocalRuntimeSessionId} from './layout-contract.ts';

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
  const sessionId = normalizeLocalRuntimeSessionId(
    args.newSessionId ?? args.sessionId,
  );
  const dataRoot = await ensureCharacterDataDir({
    ...(args.homeRoot === undefined ? {} : {homeRoot: args.homeRoot}),
    characterId: args.character.id,
  });
  const storageOptions = {
    storeRoot: dataRoot,
    characterId: args.character.id,
  };
  const boundUserSpeaker = createUserSpeaker(args.userDisplayName);

  const sessionStore = createLocalRuntimeSessionStore({
    ...storageOptions,
    sessionReadinessValidator: {
      assertSessionReadable(selectedSessionId) {
        const logStore = createFileRuntimeLogStore({
          ...storageOptions,
          sessionId: selectedSessionId,
          boundCharacter: args.character,
          boundUserSpeaker,
        });

        logStore.readSessionEvidence();
      },
    },
  });
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
      boundCharacter: args.character,
      boundUserSpeaker,
    });
    logStore.recoverAbandonedWriterEvidence?.();

    return Object.freeze({
      session: await sessionStore.rehydrateConversationSession(sessionId, {
        conversationLogReader: {
          readConversationMessages() {
            return readDurableConversationEvidence(
              logStore,
              args.character,
              boundUserSpeaker,
            ).messages;
          },
          readConversationEvidence() {
            return readDurableConversationEvidence(
              logStore,
              args.character,
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

export function readDurableConversationEvidence(
  logStore: RuntimeLogStore,
  boundCharacter: CharacterProfile,
  boundUserSpeaker?: SpeakerIdentity,
): LocalRuntimeSessionConversationEvidence {
  const evidence = logStore.readSessionEvidence().stored;
  const recordedUserMessage = evidence.conversationMessages.find(
    message => message.role === 'user',
  );

  return Object.freeze({
    // Existing sessions keep their evidence-derived profiles (historical
    // display names); the bound character and user speaker apply to
    // evidence-empty sessions only.
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

export async function selectOrCreateDefaultSession(
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

export function isMissingDefaultSessionStore(error: unknown): boolean {
  return (
    (error instanceof LocalRuntimeStorageContractError &&
      error.code === 'missing_file') ||
    (error instanceof LocalRuntimeSessionStoreError &&
      error.code === 'session_not_found')
  );
}
