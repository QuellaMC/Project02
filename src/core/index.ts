/** Cross-module imports of core must land here (arch:check rule 5). */
export {
  freezeCharacterProfile,
  visibleMessageRoleValues,
  type CharacterProfile,
  type SpeakerIdentity,
  type VisibleMessage,
  type VisibleMessageRole,
} from './message/message.ts';
export {
  characterLength,
  isValidSpeakerDisplayName,
  clientStampPattern,
  isValidClientStamp,
  maxSpeakerDisplayNameLength,
  normalizeOneLineMessage,
  normalizeVisibleMessageText,
  oneLineMessageMissingErrorMessage,
  oneLineMessageMultilineErrorMessage,
  OneLineMessageValidationError,
  VisibleMessageTextValidationError,
  type OneLineMessageValidationReason,
} from './message/validation.ts';
export {
  assertCanonicalRuntimeTimestamp,
  createRuntimeEventIdentity,
  createRuntimeEventIdentitySnapshot,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
  runtimeEventIdentityKey,
  runtimeEventTypeValues,
  type RuntimeEventIdentity,
  type RuntimeEventType,
  type UserMessageRuntimeEvent,
} from './message/event.ts';
export {
  conversationParticipantKindValues,
  ConversationValidationError,
  createConversation,
  sameConversationParticipants,
  type Conversation,
  type ConversationParticipant,
  type ConversationParticipantKind,
} from './conversation/conversation.ts';
export {
  appendCommittedMessage,
  createCharacterMessage,
  createUserMessage,
  messageNumberFromId,
  sessionIdFromMessageId,
  CharacterInputError,
  CharacterReplyValidationError,
  ConversationRehydrationError,
  createSession,
  createUserSpeaker,
  localUserSpeaker,
  normalizeCharacterAgentReply,
  validateCharacterAgentReply,
  validateConversationParticipants,
  type CharacterAgent,
  type Session,
} from './conversation/session.ts';
export {
  selectCharacterId,
  type CharacterSelection,
} from './character/selection.ts';
