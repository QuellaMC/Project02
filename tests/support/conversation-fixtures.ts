import {join} from 'node:path';

import type {CharacterProfile, Conversation} from '../../src/core/index.ts';
import {
  openConversation,
  type ActiveConversation,
} from '../../src/runtime/index.ts';
import {
  createLocalRuntimeConversationStore,
  createLocalRuntimeSessionStore,
} from '../../src/runtime/storage/index.ts';
import {
  characterDataDirPath,
  createLocalRuntimeSessionPaths,
  type LocalRuntimeSessionMetadata,
  type LocalRuntimeSessionPaths,
} from '../../src/runtime/storage/layout-contract.ts';
import {testCharacterProfile} from './character-fixtures.ts';
import {createTestTempRoot} from './temp-root.ts';

export type CharacterConversationFixture = {
  readonly conversation: Conversation;
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
  readonly latestSessionId: string;
  readonly latestSessionPaths: LocalRuntimeSessionPaths;
};

/**
 * Resolves the one user-and-character conversation a chat run opened in
 * `homeRoot`, through the production readers, so tests can locate the
 * character's segments without pinning generated ids.
 */
export async function readCharacterConversation(
  homeRoot: string,
  characterId = testCharacterProfile.id,
): Promise<CharacterConversationFixture> {
  const conversations = await createLocalRuntimeConversationStore({
    homeRoot,
  }).listConversations();
  const conversation = conversations.find(candidate =>
    candidate.participants.some(
      participant =>
        participant.kind === 'character' && participant.id === characterId,
    ),
  );

  if (conversation === undefined) {
    throw new Error(
      `No conversation with character "${characterId}" exists in ${homeRoot}.`,
    );
  }

  const storeRoot = characterDataDirPath(homeRoot, characterId);
  const sessions = await createLocalRuntimeSessionStore({
    storeRoot,
    characterId,
  }).listSessions();
  const latest = sessions.at(-1);

  if (latest === undefined) {
    throw new Error(
      `Conversation "${conversation.id}" has no sessions for "${characterId}".`,
    );
  }

  return {
    conversation,
    sessions,
    latestSessionId: latest.sessionId,
    latestSessionPaths: createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: latest.sessionId,
    }),
  };
}

/** Opens a conversation in a temp home (or the given one), closing after. */
export async function withOpenConversation<T>(
  options: {
    readonly homeRoot?: string;
    readonly character?: CharacterProfile;
    readonly userDisplayName?: string;
  },
  run: (conversation: ActiveConversation, homeRoot: string) => Promise<T>,
): Promise<T> {
  const homeRoot =
    options.homeRoot ??
    join(createTestTempRoot('project02-conversation-'), 'home');
  const conversation = await openConversation({
    homeRoot,
    character: options.character ?? testCharacterProfile,
    ...(options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.userDisplayName}),
  });

  try {
    return await run(conversation, homeRoot);
  } finally {
    await conversation.close();
  }
}
