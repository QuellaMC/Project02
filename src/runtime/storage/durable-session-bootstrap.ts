import type {ConversationSession} from '../../core/index.ts';
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
import type {LocalRuntimeMutationLockLease} from './mutation-lock.ts';
import {createLocalRuntimeMutationLockOwnerToken} from './mutation-lock.ts';
import {acquireLocalRuntimeSessionWriterLease} from './session-store.ts';
import {normalizeLocalRuntimeSessionId} from './layout-contract.ts';

export type DurableSessionSelection = {
  readonly storeRoot?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
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
  const sessionStore = createLocalRuntimeSessionStore({
    ...storageOptions,
    sessionReadinessValidator: {
      assertSessionReadable(selectedSessionId) {
        const logStore = createFileRuntimeLogStore({
          ...storageOptions,
          sessionId: selectedSessionId,
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
    });
    logStore.recoverAbandonedWriterEvidence?.();

    return Object.freeze({
      session: await sessionStore.rehydrateConversationSession(sessionId, {
        conversationLogReader: {
          readConversationMessages() {
            return readDurableConversationEvidence(logStore).messages;
          },
          readConversationEvidence() {
            return readDurableConversationEvidence(logStore);
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
): LocalRuntimeSessionConversationEvidence {
  const evidence = logStore.readSessionEvidence().stored;

  return Object.freeze({
    character: durableRuntimeSessionCharacterProfile(evidence),
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
