export {
  CharacterInputError,
  CharacterReplyValidationError,
  ConversationRehydrationError,
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
  type RuntimeEvent,
  type RuntimeEventIdentity,
  type RuntimeEventIdentityOptions,
  type RuntimeEventType,
  type UserMessageRuntimeEvent,
  type UserMessageRuntimeEventPayload
} from './runtime-event.ts';

export {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageCompletedResult,
  type LocalRuntimeUserMessageRejectedResult,
  type LocalRuntimeUserMessageRejectionReason,
  type LocalRuntimeUserMessageResult,
  type RunLocalUserMessageEventOptions,
  type RecordLocalUserMessageInputRejectionOptions
} from './local-runtime.ts';

export { createFileRuntimeLogStore } from './file-runtime-log-store.ts';

export type {
  CreateFileRuntimeLogStoreOptions
} from './file-runtime-log-store.ts';

export { createRuntimeLogStore } from './runtime-log.ts';

export type {
  ConversationLogRecord,
  ConversationLogRecordInput,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RawEventLogRecordKind,
  RawEventLogPayloadSummary,
  RuntimeLogStore,
  RuntimeTraceEntry,
  RuntimeTraceEntryInput,
  RuntimeTraceStepName,
  RuntimeTurnStatus
} from './runtime-log.ts';

export {
  createLocalRuntimeSessionMetadata,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  decodeConversationLogRecord,
  decodeRawEventLogRecord,
  decodeRuntimeTraceEntry,
  decodeStorageSchemaMarker,
  defaultLocalRuntimeSessionId,
  defaultLocalRuntimeStoreRoot,
  encodeConversationLogRecord,
  encodeRawEventLogRecord,
  encodeRuntimeTraceEntry,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  localRuntimeStorageSchemaVersion,
  normalizeLocalRuntimeSessionId
} from './local-storage.ts';

export type {
  CreateLocalRuntimeSessionMetadataOptions,
  CreateLocalRuntimeStorageSchemaMarkerOptions,
  LocalRuntimeSessionMetadata,
  LocalRuntimeSessionPaths,
  LocalRuntimeSessionPathsOptions,
  LocalRuntimeStorageContractErrorCode,
  LocalRuntimeStorageLayout,
  LocalRuntimeStorageLayoutOptions,
  LocalRuntimeStorageSchemaMarker
} from './local-storage.ts';

export {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError
} from './session-store.ts';

export type {
  CreateLocalRuntimeSessionOptions,
  CreateLocalRuntimeSessionStoreOptions,
  LocalRuntimeSessionConversationLogReader,
  LocalRuntimeSessionStore,
  LocalRuntimeSessionStoreErrorCode,
  RehydrateLocalRuntimeConversationSessionOptions,
  SelectLocalRuntimeSessionOptions
} from './session-store.ts';

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
