import {
  validateConversationParticipants,
  type Conversation,
} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {
  acquireLocalRuntimeConversationWriterLease,
  createLocalRuntimeConversationStore,
} from '../storage/conversation-store.ts';
import {ensureCharacterDataDir} from '../storage/character-data.ts';
import {normalizeLocalRuntimeCharacterId} from '../storage/layout-contract.ts';
import {
  createLocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLockLease,
} from '../storage/mutation-lock.ts';
import {createLocalRuntimeSessionStore} from '../storage/session-store.ts';
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
  closed: boolean;
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
    const context: SegmentContext = {
      storageOptions,
      sessionStore: createLocalRuntimeSessionStore(storageOptions),
      ownerToken,
      character,
      boundUserSpeaker: userSpeaker,
    };
    const metadata =
      (await context.sessionStore.latestSegment(conversation.id)) ??
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
      closed: false,
    });
  } catch (error: unknown) {
    await conversationLease.release();
    throw error;
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
      if (state.closed) {
        return;
      }

      state.closed = true;
      await state.queue.catch(() => undefined);
      await state.segment.writerLease.release();
      await state.conversationLease.release();
    },
  });

  activeConversations.set(active, state);

  return active;
}
