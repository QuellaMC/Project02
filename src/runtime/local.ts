import type { ConversationSession } from '../core/conversation.ts';
import { LocalRuntimeStorageContractError } from './storage/layout.ts';
import { acquireLocalRuntimeSessionWriterLease } from './storage/session-store.ts';
import { runSerializedLocalUserMessageEvent } from './turn/model.ts';
import type {
  LocalRuntimeUserMessageResult,
  RunLocalUserMessageEventOptions
} from './turn/contracts.ts';

export { recordLocalUserMessageInputRejection } from './turn/input.ts';
export type {
  LocalRuntimeTurnProgressEvent,
  LocalRuntimeUserMessageCompletedResult,
  LocalRuntimeUserMessageInputRejectedResult,
  LocalRuntimeUserMessageRejectedResult,
  LocalRuntimeUserMessageRejectionReason,
  LocalRuntimeUserMessageResult,
  RecordLocalUserMessageInputRejectionOptions,
  RunLocalUserMessageEventOptions
} from './turn/contracts.ts';

const localRuntimeTurnQueues = new WeakMap<ConversationSession, Promise<void>>();

export async function runLocalUserMessageEvent(
  options: RunLocalUserMessageEventOptions
): Promise<LocalRuntimeUserMessageResult> {
  return await enqueueLocalRuntimeTurn(options.session, async () => {
    return await runLocalUserMessageEventWithWriterLease(options);
  });
}

async function runLocalUserMessageEventWithWriterLease(
  options: RunLocalUserMessageEventOptions
): Promise<LocalRuntimeUserMessageResult> {
  const sessionPaths = options.logStore.localRuntimeSessionPaths;

  if (sessionPaths === undefined) {
    return await runSerializedLocalUserMessageEvent(options);
  }

  const lease = await acquireLocalRuntimeSessionWriterLease({
    storeRoot: sessionPaths.storeRoot,
    sessionId: sessionPaths.sessionId,
    ...(options.logStore.localRuntimeWriterLockOwnerToken === undefined
      ? {}
      : { ownerToken: options.logStore.localRuntimeWriterLockOwnerToken })
  });

  try {
    options.logStore.recoverAbandonedWriterEvidence?.();
    assertDurableTranscriptIsCurrent(options);
    return await runSerializedLocalUserMessageEvent(options);
  } finally {
    try {
      options.logStore.checkpointWriterEvidence?.();
    } finally {
      await lease.release();
    }
  }
}

function assertDurableTranscriptIsCurrent(
  options: RunLocalUserMessageEventOptions
): void {
  const sessionPaths = options.logStore.localRuntimeSessionPaths;

  if (sessionPaths === undefined) {
    return;
  }

  const durableMessages = options.logStore.conversationMessages();
  const transcript = options.session.visibleTranscript;

  if (
    options.session.id !== sessionPaths.sessionId ||
    durableMessages.length !== transcript.length ||
    durableMessages.some((stored, index) => {
      const current = transcript[index];

      return (
        current === undefined ||
        stored.id !== current.id ||
        stored.role !== current.role ||
        stored.speakerId !== current.speakerId ||
        stored.speakerName !== current.speakerName ||
        stored.text !== current.text
      );
    })
  ) {
    throw new LocalRuntimeStorageContractError(
      'stale_session',
      `Conversation session "${options.session.id}" is stale relative to durable session "${sessionPaths.sessionId}".`
    );
  }
}

async function enqueueLocalRuntimeTurn<T>(
  session: ConversationSession,
  operation: () => Promise<T>
): Promise<T> {
  const previousTurn = localRuntimeTurnQueues.get(session) ?? Promise.resolve();
  const currentTurn = previousTurn.then(operation, operation);

  localRuntimeTurnQueues.set(
    session,
    currentTurn.then(
      () => undefined,
      () => undefined
    )
  );

  return await currentTurn;
}
