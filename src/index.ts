export {
  CharacterInputError,
  CharacterReplyValidationError,
  createConversationSession,
  createDeterministicCharacterAgent,
  localCharacterProfile,
  runCharacterTurn,
  type CharacterAgent,
  type CharacterAgentInput,
  type CharacterAgentReply,
  type CharacterProfile,
  type CharacterTurnOptions,
  type CharacterTurnResult,
  type ConversationSession,
  type ConversationSessionOptions,
  type VisibleMessage,
  type VisibleMessageRole
} from './conversation.ts';

export type ProjectHealth = {
  readonly status: 'ok';
  readonly runtime: 'typescript';
};

export function projectHealth(): ProjectHealth {
  return {
    status: 'ok',
    runtime: 'typescript'
  };
}
