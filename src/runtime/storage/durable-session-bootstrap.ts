import type {CharacterProfile, ConversationSession} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/records.ts';
import {
  createFileRuntimeLogStore,
  durableRuntimeSessionCharacterProfile,
} from './file-runtime-log-store.ts';
import {LocalRuntimeStorageContractError} from './layout-contract.ts';
import {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError,
  type LocalRuntimeSessionConversationEvidence,
} from './session-store.ts';
import type {LocalRuntimeSessionMetadata} from './layout-contract.ts';
import type {LocalRuntimeMutationLockLease} from './mutation-lock.ts';
import {createLocalRuntimeMutationLockOwnerToken} from './mutation-lock.ts';
import {reconcileCharacterBinding} from './character-binding.ts';
import {acquireLocalRuntimeSessionWriterLease} from './session-store.ts';
import {normalizeLocalRuntimeSessionId} from './layout-contract.ts';

export type DurableSessionSelection = {
  readonly storeRoot?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
  readonly character: CharacterProfile;
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
  const storageOptions =
    args.storeRoot === undefined ? {} : {storeRoot: args.storeRoot};
  const bindingResult = await reconcileCharacterBinding({
    storageOptions,
    configuredCharacterId: args.character.id,
    deriveStoreCharacterIds: () =>
      deriveDurableStoreCharacterIds(storageOptions),
  });

  if (bindingResult.status === 'rejected') {
    throw new LocalRuntimeStorageContractError(
      'character_binding_rejected',
      bindingResult.message,
    );
  }

  const sessionStore = createLocalRuntimeSessionStore({
    ...storageOptions,
    sessionReadinessValidator: {
      assertSessionReadable(selectedSessionId) {
        const logStore = createFileRuntimeLogStore({
          ...storageOptions,
          sessionId: selectedSessionId,
          boundCharacter: args.character,
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
    });
    logStore.recoverAbandonedWriterEvidence?.();

    return Object.freeze({
      session: await sessionStore.rehydrateConversationSession(sessionId, {
        conversationLogReader: {
          readConversationMessages() {
            return readDurableConversationEvidence(logStore, args.character)
              .messages;
          },
          readConversationEvidence() {
            return readDurableConversationEvidence(logStore, args.character);
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

/**
 * Distinct character ids recorded across the store's sessions; consulted
 * only while no binding exists, so legacy stores adopt their own history.
 */
async function deriveDurableStoreCharacterIds(storageOptions: {
  readonly storeRoot?: string;
}): Promise<readonly string[]> {
  let sessions: readonly LocalRuntimeSessionMetadata[];

  try {
    sessions = await createLocalRuntimeSessionStore({
      ...storageOptions,
    }).listSessions();
  } catch (error: unknown) {
    if (
      error instanceof LocalRuntimeStorageContractError &&
      error.code === 'missing_file'
    ) {
      // Uninitialized store: nothing to adopt yet.
      return Object.freeze([]);
    }

    throw error;
  }

  const characterIds = new Set<string>();

  for (const metadata of sessions) {
    const evidence = createFileRuntimeLogStore({
      ...storageOptions,
      sessionId: metadata.sessionId,
    }).readSessionEvidence().stored;

    for (const message of evidence.conversationMessages) {
      if (message.role === 'character') {
        characterIds.add(message.speakerId);
      }
    }
    for (const rawEvent of evidence.rawEvents) {
      const characterId =
        rawEvent.roleModelIOSnapshot?.inputEnvelope.decisionContext
          .characterSnapshot.id;

      if (characterId !== undefined) {
        characterIds.add(characterId);
      }
    }
  }

  return Object.freeze([...characterIds].sort());
}

export function readDurableConversationEvidence(
  logStore: RuntimeLogStore,
  boundCharacter: CharacterProfile,
): LocalRuntimeSessionConversationEvidence {
  const evidence = logStore.readSessionEvidence().stored;

  return Object.freeze({
    // Existing sessions keep their evidence-derived profile (historical
    // display name); the bound character applies to evidence-empty
    // sessions only.
    character: durableRuntimeSessionCharacterProfile(evidence, boundCharacter),
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
