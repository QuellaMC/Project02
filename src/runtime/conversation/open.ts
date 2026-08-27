import {
  validateConversationParticipants,
  type Conversation,
  type ConversationParticipant,
} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {
  acquireLocalRuntimeConversationWriterLease,
  createLocalRuntimeConversationStore,
} from '../storage/conversation-store.ts';
import {ensureCharacterDataDir} from '../storage/character-data.ts';
import {
  normalizeLocalRuntimeCharacterId,
  parseSegmentSessionId,
  type LocalRuntimeSessionMetadata,
} from '../storage/layout-contract.ts';
import {
  createLocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLockLease,
} from '../storage/mutation-lock.ts';
import {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError,
  type LocalRuntimeSessionStore,
} from '../storage/session-store.ts';
import type {ActiveConversation, OpenConversationOptions} from './contracts.ts';
import {
  openSegment,
  type ConversationSegment,
  type SegmentContext,
} from './segment.ts';

export type ActiveConversationState = {
  readonly conversation: Conversation;
  readonly context: SegmentContext;
  readonly conversationLease: LocalRuntimeMutationLockLease;
  segment: ConversationSegment;
  queue: Promise<void>;
  closing: Promise<void> | undefined;
};

const activeConversations = new WeakMap<
  ActiveConversation,
  ActiveConversationState
>();

export function activeConversationState(
  conversation: ActiveConversation,
): ActiveConversationState {
  const state = activeConversations.get(conversation);

  if (state === undefined) {
    throw new TypeError('Unknown active conversation.');
  }

  return state;
}

/**
 * Opens the one thread between the local user and this character, resuming
 * the character's latest segment or starting its first. This runtime hosts
 * exactly one user and one character per conversation; wider participant
 * sets are the model's capability, not yet this driver's.
 */
export async function openConversation(
  options: OpenConversationOptions,
): Promise<ActiveConversation> {
  const characterId = normalizeLocalRuntimeCharacterId(options.character.id);
  const {character, userSpeaker} = validateConversationParticipants({
    character: {id: characterId, displayName: options.character.displayName},
    ...(options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.userDisplayName}),
  });
  const dataRoot = await ensureCharacterDataDir({
    ...(options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot}),
    characterId,
  });
  const conversationStore = createLocalRuntimeConversationStore(
    options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot},
  );
  const conversation = await conversationStore.ensureConversationWith([
    {kind: 'user', id: userSpeaker.id, displayName: userSpeaker.displayName},
    {kind: 'character', id: character.id, displayName: character.displayName},
  ]);
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const conversationLease = await acquireLocalRuntimeConversationWriterLease({
    ...(options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot}),
    conversationId: conversation.id,
    ownerToken,
  });

  try {
    const storageOptions = {storeRoot: dataRoot, characterId};
    // The thread's identities were recorded when it began: segments bind to
    // the conversation's participants, so a configured rename never renames
    // an existing conversation — not even an evidence-empty continuation.
    const context: SegmentContext = {
      storageOptions,
      sessionStore: createLocalRuntimeSessionStore(storageOptions),
      ownerToken,
      character: conversationParticipantIdentity(conversation, 'character'),
      boundUserSpeaker: conversationParticipantIdentity(conversation, 'user'),
    };
    const metadata =
      (await resumableSegment(context.sessionStore, conversation.id)) ??
      (await context.sessionStore.createSession({
        conversationId: conversation.id,
      }));
    const segment = await openSegment(context, metadata.sessionId);

    return createActiveConversation({
      conversation,
      context,
      conversationLease,
      segment,
      queue: Promise.resolve(),
      closing: undefined,
    });
  } catch (error: unknown) {
    await conversationLease.release();
    throw error;
  }
}

function conversationParticipantIdentity(
  conversation: Conversation,
  kind: ConversationParticipant['kind'],
): {readonly id: string; readonly displayName: string} {
  const participant = conversation.participants.find(
    candidate => candidate.kind === kind,
  );

  if (participant === undefined) {
    throw new TypeError(
      `Conversation "${conversation.id}" has no ${kind} participant.`,
    );
  }

  return Object.freeze({
    id: participant.id,
    displayName: participant.displayName,
  });
}

/**
 * A continued segment opens with its continuation record, so an empty one is
 * the leftover of a rotation interrupted between publishing the segment and
 * writing that record. Discard it and resume its predecessor, exactly as an
 * in-process rotation failure would have.
 */
async function resumableSegment(
  sessionStore: LocalRuntimeSessionStore,
  conversationId: string,
): Promise<LocalRuntimeSessionMetadata | undefined> {
  for (;;) {
    const latest = await sessionStore.latestSegment(conversationId);

    if (
      latest === undefined ||
      parseSegmentSessionId(latest.sessionId).segment === 1
    ) {
      return latest;
    }

    try {
      await sessionStore.discardEmptySession(latest.sessionId);
    } catch (error: unknown) {
      if (
        error instanceof LocalRuntimeSessionStoreError &&
        error.code === 'session_not_empty'
      ) {
        return latest;
      }

      throw error;
    }
  }
}

function createActiveConversation(
  state: ActiveConversationState,
): ActiveConversation {
  const active: ActiveConversation = Object.freeze({
    conversation: state.conversation,
    get session() {
      return state.segment.session;
    },
    get logStore(): RuntimeLogStore {
      return state.segment.logStore;
    },
    async close(): Promise<void> {
      state.closing ??= closeActiveConversation(state);
      await state.closing;
    },
  });

  activeConversations.set(active, state);

  return active;
}

async function closeActiveConversation(
  state: ActiveConversationState,
): Promise<void> {
  await state.queue.catch(() => undefined);
  await state.segment.writerLease.release();
  await state.conversationLease.release();
}
