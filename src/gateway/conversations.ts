import {
  createLocalRuntimeConversationStore,
  LocalRuntimeConversationStoreError,
  LocalRuntimeStorageContractError,
} from '../runtime/storage/index.ts';

/**
 * Which character a conversation belongs to, from the store's record of
 * it: found, with the character among its participants; unknown, when
 * the store holds no such conversation or the id could not name one; or
 * failed, when the record could not be read at all.
 */
export type ConversationCharacter =
  | {
      readonly status: 'found';
      readonly conversationId: string;
      readonly characterId: string;
    }
  | {readonly status: 'unknown'; readonly message: string}
  | {
      readonly status: 'failed';
      readonly error: LocalRuntimeStorageContractError;
    };

/**
 * The one lookup behind every verb that takes a conversation id from a
 * client: the history a stopped character's thread is read from, and a
 * delivery on a conversation this run of the daemon has not opened — a
 * tab that reconnected after a restart keeps its id, and the store, not
 * the client, says whose thread it is.
 */
export async function characterOfConversation(options: {
  readonly homeRoot: string;
  readonly conversationId: string;
}): Promise<ConversationCharacter> {
  let conversation;

  try {
    conversation = await createLocalRuntimeConversationStore({
      homeRoot: options.homeRoot,
    }).readConversation(options.conversationId);
  } catch (error: unknown) {
    if (
      error instanceof LocalRuntimeConversationStoreError &&
      error.code === 'conversation_not_found'
    ) {
      return {status: 'unknown', message: error.message};
    }

    if (error instanceof LocalRuntimeStorageContractError) {
      return error.code === 'invalid_conversation_id'
        ? {status: 'unknown', message: error.message}
        : {status: 'failed', error};
    }

    throw error;
  }

  const character = conversation.participants.find(
    participant => participant.kind === 'character',
  );

  return character === undefined
    ? {
        status: 'unknown',
        message: `Conversation "${conversation.id}" has no character to answer it.`,
      }
    : {
        status: 'found',
        conversationId: conversation.id,
        characterId: character.id,
      };
}
