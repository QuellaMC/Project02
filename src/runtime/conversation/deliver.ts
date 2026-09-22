import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
} from '../../core/index.ts';
import {sameTraceIdentity} from '../evidence/trace-summary.ts';
import {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
} from '../turn/local.ts';
import {planSessionContinuation} from '../turn/session-continuation.ts';
import type {ActiveConversationState} from './open.ts';
import {activeConversationState} from './open.ts';
import type {
  DeliverUserMessageOptions,
  SegmentRotation,
  UserMessageDelivery,
} from './contracts.ts';
import {openContinuedSegment, userLinesOf} from './segment.ts';
import {endSession} from './session-end.ts';
import {parseSegmentSessionId} from '../storage/layout-contract.ts';
import {takenLine, writeTakenLines} from '../storage/taken-lines.ts';

/**
 * One user message through the character's turn, serialized per
 * conversation: record the input, run the model, and — after a completed
 * turn — rotate the segment when its history has outgrown the window.
 */
export async function deliverUserMessage(
  options: DeliverUserMessageOptions,
): Promise<UserMessageDelivery> {
  const state = activeConversationState(options.conversation);

  if (state.closing !== undefined) {
    throw new TypeError('Cannot deliver into a closed conversation.');
  }

  const delivery = state.queue.then(
    () => deliverThroughSegment(state, options),
    () => deliverThroughSegment(state, options),
  );

  state.queue = delivery.then(
    () => undefined,
    () => undefined,
  );

  return await delivery;
}

async function deliverThroughSegment(
  state: ActiveConversationState,
  options: DeliverUserMessageOptions,
): Promise<UserMessageDelivery> {
  const {session, logStore} = state.segment;
  const {clientMessageId} = options;
  // A run before this one may have taken the line — the daemon can go
  // down after committing it and before answering — and the segment's
  // own record, or the conversation's record of every segment before it,
  // says so at no cost. Nothing runs twice for one id.
  const earlier =
    clientMessageId === undefined
      ? undefined
      : (logStore
          .conversationMessages()
          .find(
            record =>
              record.role === 'user' &&
              record.clientMessageId === clientMessageId,
          )?.id ?? takenLine(state.takenLines, clientMessageId));

  if (earlier !== undefined && clientMessageId !== undefined) {
    return {status: 'duplicate', clientMessageId, messageId: earlier};
  }

  const identity = createRuntimeEventIdentity();

  try {
    const event = createUserMessageRuntimeEvent(options.line, identity);

    try {
      const turn = await runLocalUserMessageEvent({
        event,
        session,
        logStore,
        rawInput: options.line,
        ...(options.roleModelAdapter === undefined
          ? {}
          : {roleModelAdapter: options.roleModelAdapter}),
        ...(options.characterPersonaSections === undefined
          ? {}
          : {characterPersonaSections: options.characterPersonaSections}),
        ...(options.characterRef === undefined
          ? {}
          : {characterRef: options.characterRef}),
        ...(options.contextWindowTokens === undefined
          ? {}
          : {contextWindowTokens: options.contextWindowTokens}),
        pluginHost: options.pluginHost,
        ...(options.source === undefined ? {} : {source: options.source}),
        ...(options.clientMessageId === undefined
          ? {}
          : {clientMessageId: options.clientMessageId}),
        ...(options.onProgress === undefined
          ? {}
          : {onProgress: options.onProgress}),
      });

      if (turn.status !== 'completed') {
        return {status: 'rejected', turn};
      }

      const rotation = await rotateIfNeeded(state, options);

      return {
        status: 'completed',
        turn,
        ...(rotation === undefined ? {} : {rotation}),
      };
    } catch (error: unknown) {
      const evidence = logStore.readSessionEvidence();

      return {
        status: 'failed',
        identity,
        error,
        traceEntries: logStore
          .traceEntries()
          .filter(traceEntry => sameTraceIdentity(traceEntry, identity)),
        rawEvents: evidence.rawEvents.filter(rawEvent =>
          sameTraceIdentity(rawEvent, identity),
        ),
      };
    }
  } catch (error: unknown) {
    if (error instanceof RuntimeEventInputError) {
      return {
        status: 'input_rejected',
        turn: recordLocalUserMessageInputRejection({
          identity: error.identity,
          logStore,
          message: error.message,
          rawInput: options.line,
        }),
      };
    }

    throw error;
  }
}

/**
 * After a completed turn: if the segment's history has outgrown its window,
 * open the next segment, end this one, and swap. A failure leaves the
 * current segment in place — the plan is simply made again next turn.
 */
async function rotateIfNeeded(
  state: ActiveConversationState,
  options: DeliverUserMessageOptions,
): Promise<SegmentRotation | undefined> {
  const {session, logStore} = state.segment;
  const plan = await planSessionContinuation({
    sessionId: session.id,
    logStore,
    ...(options.roleModelAdapter === undefined
      ? {}
      : {roleModelAdapter: options.roleModelAdapter}),
    ...(options.contextWindowTokens === undefined
      ? {}
      : {contextWindowTokens: options.contextWindowTokens}),
    characterName: session.character.displayName,
    userDisplayName: session.userSpeaker.displayName,
  });

  if (plan === undefined) {
    return undefined;
  }

  let next;

  try {
    // The next segment keeps the identities this segment really has: a
    // rehydrated session keeps its recorded character and speaker even when
    // the configuration has since changed, and its continuation must too.
    next = await openContinuedSegment(
      {
        ...state.context,
        character: session.character,
        boundUserSpeaker: session.userSpeaker,
      },
      plan,
    );
  } catch (error: unknown) {
    return {
      status: 'failed',
      from: session.id,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // The continuation is committed: the conversation is in the new segment
  // from here on, however closing the old one goes; the old one's lines
  // stay known to the new one, and to every run after this one.
  const previous = state.segment;
  const closed = parseSegmentSessionId(previous.session.id);

  state.takenLines = new Map([
    ...state.takenLines,
    [closed.segment, userLinesOf(previous.logStore.conversationMessages())],
  ]);
  state.segment = next;

  let endFailure: string | undefined;
  const closingFailed = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);

    endFailure =
      endFailure === undefined ? message : `${endFailure}; ${message}`;
  };

  try {
    writeTakenLines(
      {
        storeRoot: state.context.storageOptions.storeRoot,
        conversationId: closed.conversationId,
      },
      state.takenLines,
    );
  } catch (error: unknown) {
    closingFailed(error);
  }

  try {
    await endSession({session, logStore, pluginHost: options.pluginHost});
  } catch (error: unknown) {
    closingFailed(error);
  }

  try {
    await previous.writerLease.release();
  } catch (error: unknown) {
    closingFailed(error);
  }

  return {
    status: 'rotated',
    from: session.id,
    to: next.session.id,
    summarizedTurnCount: plan.summarizedTurnCount,
    summarizer: plan.summarizer,
    ...(endFailure === undefined ? {} : {endFailure}),
  };
}
