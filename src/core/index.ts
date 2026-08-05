/**
 * Public API of src/core.
 *
 * Cross-module imports of core must land here (arch:check rule 5).
 */
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
  maxSpeakerDisplayNameLength,
  normalizeOneLineMessage,
  normalizeVisibleMessageText,
  oneLineMessageMissingErrorMessage,
  oneLineMessageMultilineErrorMessage,
  OneLineMessageValidationError,
  VisibleMessageTextValidationError,
  type OneLineMessageValidationReason,
  type VisibleMessageTextValidationReason,
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
  type RuntimeEventIdentityOptions,
  type RuntimeEventType,
  type UserMessageRuntimeEvent,
  type UserMessageRuntimeEventPayload,
} from './message/event.ts';
export {
  appendCommittedMessage,
  createCharacterMessage,
  createMessageIdForSessionId,
  createUserMessage,
  messageNumberFromId,
  nextMessageNumber,
  sessionIdFromMessageId,
  CharacterInputError,
  CharacterReplyValidationError,
  ConversationRehydrationError,
  createConversationSession,
  createUserSpeaker,
  defaultRecentVisibleMessageLimit,
  localUserSpeaker,
  normalizeCharacterAgentReply,
  selectRecentVisibleMessages,
  validateCharacterAgentReply,
  validateConversationParticipants,
  validateRestoredVisibleTranscript,
  type CharacterAgent,
  type CharacterAgentInput,
  type CharacterAgentReply,
  type ConversationSession,
  type ConversationSessionOptions,
  type RestoredVisibleTranscriptValidationOptions,
} from './conversation/session.ts';
