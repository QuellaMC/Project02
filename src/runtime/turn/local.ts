import type {Session} from '../../core/index.ts';
import {acquireLocalRuntimeSessionWriterLease} from '../storage/session-store.ts';
import {runSerializedLocalUserMessageEvent} from './model.ts';
import type {
  LocalRuntimeUserMessageResult,
  RunLocalUserMessageEventOptions,
} from './contracts.ts';

export {recordLocalUserMessageInputRejection} from './input.ts';
export type {
  LocalRuntimeTurnProgressEvent,
  LocalRuntimeUserMessageCompletedResult,
  LocalRuntimeUserMessageInputRejectedResult,
  LocalRuntimeUserMessageRejectedResult,
  LocalRuntimeUserMessageRejectionReason,
  LocalRuntimeUserMessageResult,
  RecordLocalUserMessageInputRejectionOptions,
  RunLocalUserMessageEventOptions,
} from './contracts.ts';

const localRuntimeTurnQueues = new WeakMap<Session, Promise<void>>();

export async function runLocalUserMessageEvent(
  options: RunLocalUserMessageEventOptions,
): Promise<LocalRuntimeUserMessageResult> {
  return await enqueueLocalRuntimeTurn(options.session, async () => {
    return await runLocalUserMessageEventWithWriterLease(options);
  });
}

async function runLocalUserMessageEventWithWriterLease(
  options: RunLocalUserMessageEventOptions,
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
      : {ownerToken: options.logStore.localRuntimeWriterLockOwnerToken}),
  });

  try {
    return await runSerializedLocalUserMessageEvent(options);
  } finally {
    await lease.release();
  }
}

async function enqueueLocalRuntimeTurn<T>(
  session: Session,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTurn = localRuntimeTurnQueues.get(session) ?? Promise.resolve();
  const currentTurn = previousTurn.then(operation, operation);

  localRuntimeTurnQueues.set(
    session,
    currentTurn.then(
      () => undefined,
      () => undefined,
    ),
  );

  return await currentTurn;
}
