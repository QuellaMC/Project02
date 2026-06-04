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

export {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
  type RuntimeEventIdentity,
  type RuntimeEventIdentityOptions,
  type RuntimeEventType,
  type UserMessageRuntimeEvent
} from './runtime-event.ts';

export type {
  ConversationLogRecord,
  ConversationLogRecordInput,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RawEventLogRecordKind,
  RuntimeLogStore,
  RuntimeTraceEntry,
  RuntimeTraceEntryInput,
  RuntimeTraceStepName,
  RuntimeTurnStatus
} from './runtime-log.ts';

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
