/**
 * Public API of src/core.
 *
 * Cross-module imports of core must land here (arch:check rule 5).
 */
export {
  freezeCharacterProfile,
  localCharacterProfile,
  visibleMessageRoleValues,
  type CharacterProfile,
  type VisibleMessage,
  type VisibleMessageRole,
} from './message/message.ts';
export {
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
  CharacterInputError,
  CharacterReplyValidationError,
  ConversationRehydrationError,
  createConversationSession,
  defaultRecentVisibleMessageLimit,
  localUserSpeaker,
  normalizeCharacterAgentReply,
  rollbackLastCharacterTurn,
  runCharacterTurn,
  selectRecentVisibleMessages,
  validateCharacterAgentReply,
  validateRestoredVisibleTranscript,
  type CharacterAgent,
  type CharacterAgentInput,
  type CharacterAgentReply,
  type CharacterTurnOptions,
  type CharacterTurnResult,
  type ConversationSession,
  type ConversationSessionOptions,
  type RestoredVisibleTranscriptValidationOptions,
} from './conversation/session.ts';
