export {
  CharacterInputError,
  CharacterReplyValidationError,
  ConversationRehydrationError,
  createConversationSession,
  createDeterministicCharacterAgent,
  localCharacterProfile,
  defaultRecentVisibleMessageLimit,
  runCharacterTurn,
  selectRecentVisibleMessages,
  validateCharacterAgentReply,
  validateRestoredVisibleTranscript,
  type CharacterAgent,
  type CharacterAgentInput,
  type CharacterAgentReply,
  type CharacterProfile,
  type CharacterTurnOptions,
  type CharacterTurnResult,
  type ConversationSession,
  type ConversationSessionOptions,
  type RestoredVisibleTranscriptValidationOptions,
  type VisibleMessage,
  type VisibleMessageRole
} from './conversation.ts';

export {
  buildUserTurnDecisionContext,
  type BuildUserTurnDecisionContextOptions
} from './decision-context.ts';

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
  createAcceptedRoleModelDecisionResult,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createVisibleReplyCharacterDecision,
  getCharacterStatePatchToolCall,
  getRequiredVisibleReplyText,
  getVisibleReplyToolCall,
  roleModelAllowedActionNames,
  roleModelAllowedToolNames,
  roleModelCharacterStatePatchToolName,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  roleModelDecisionOutputContractText,
  roleModelDecisionRejectionReasons,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelUnknownToolRejectionReason,
  roleModelVisibleReplyActionName,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type CreateDecisionContextOptions,
  type CreateParsedRoleModelDecisionSnapshotOptions,
  type CreateRoleModelInputEnvelopeOptions,
  type CreateRoleModelIOSnapshotOptions,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelAllowedActionName,
  type RoleModelAllowedToolName,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelProviderMetadata,
  type RoleModelVisibleReplyAction
} from './role-model-contracts.ts';

export {
  builtInModelToolDefinitions,
  builtInModelToolDefinitionsForUserTurn,
  characterStatePatchModelToolName,
  createCharacterStatePatchModelToolCall,
  createVisibleReplyModelToolCall,
  findCharacterStatePatchModelToolCall,
  findVisibleReplyModelToolCall,
  requiredUserTurnBuiltInModelToolNames,
  userTurnBuiltInModelToolNames,
  visibleReplyModelToolName,
  type BuiltInModelToolCall,
  type BuiltInModelToolDefinition,
  type BuiltInModelToolName,
  type CharacterStatePatchModelToolCall,
  type CharacterStatePatchModelToolName,
  type CharacterStatePatchToolInput,
  type ModelToolInputContract,
  type ModelToolInputField,
  type VisibleReplyModelToolCall,
  type VisibleReplyModelToolName,
  type VisibleReplyToolInput
} from './model-tools.ts';

export {
  createRoleModelPromptPayload,
  renderRoleModelPromptMessages,
  roleModelPromptResponseExample,
  roleModelPromptSystemMessage,
  type RoleModelPromptMessage,
  type RoleModelPromptPayload
} from './role-model-prompt.ts';

export {
  characterAttentionValues,
  characterCurrentActivityValues,
  characterEnergyValues,
  characterMoodValues,
  characterRuntimeStateVersion,
  characterSocialOrientationValues,
  createCharacterStatePatchSnapshot,
  createDefaultCharacterRuntimeState,
  createInMemoryCharacterStateStore,
  createLivingStateBrief,
  decodeCharacterRuntimeState,
  encodeCharacterRuntimeState,
  freezeCharacterRuntimeState,
  freezeCharacterStatePatchResult,
  planCharacterStatePatch,
  type AcceptedCharacterStatePatchResult,
  type CharacterAttention,
  type CharacterCurrentActivity,
  type CharacterEnergy,
  type CharacterMood,
  type CharacterRuntimeState,
  type CharacterSocialOrientation,
  type CharacterStateAppliedChange,
  type CharacterStatePatch,
  type CharacterStatePatchRejection,
  type CharacterStatePatchRejectionReason,
  type CharacterStatePatchResult,
  type CharacterStatePatchSnapshot,
  type CharacterStateStore,
  type CreateCharacterStatePatchSnapshotOptions,
  type LivingStateBrief,
  type LivingStateCurrent,
  type RejectedCharacterStatePatchResult
} from './character-state.ts';

export { createFileCharacterStateStore } from './file-character-state-store.ts';

export type {
  CreateFileCharacterStateStoreOptions
} from './file-character-state-store.ts';

export {
  createDeterministicLocalRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent,
  parseRoleModelDecision,
  runRoleModelLoop,
  type AcceptedRoleModelLoopResult,
  type RejectedRoleModelLoopResult,
  type RoleModelAdapter,
  type RoleModelAdapterRawOutput,
  type RoleModelLoopResult,
  type RunRoleModelLoopOptions
} from './role-model-loop.ts';

export {
  createNvidiaRoleModelProviderAdapter,
  createNvidiaRoleModelProviderConfigFromEnv,
  defaultNvidiaChatCompletionsEndpoint,
  defaultNvidiaRoleModelName,
  nvidiaApiKeyEnvName,
  nvidiaRoleModelMaxTokens,
  nvidiaModelEnvName,
  nvidiaRoleModelReasoningBudget,
  nvidiaRoleModelTemperature,
  nvidiaRoleModelTopP,
  nvidiaRoleModelProviderName,
  renderNvidiaMessages,
  type CreateNvidiaRoleModelProviderAdapterOptions,
  type NvidiaChatCompletionMessage,
  type NvidiaFetchClient,
  type NvidiaFetchRequest,
  type NvidiaFetchResponse,
  type NvidiaRoleModelProviderConfig,
  type NvidiaRoleModelProviderEnvironment
} from './nvidia-role-model-provider.ts';

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

export {
  createRoleModelCommitValidationSnapshot,
  createRuntimeLogStore,
  isTerminalRawEventLogRecord,
  isTerminalRawEventLogRecordKind
} from './runtime-log.ts';

export type {
  AcceptedRoleModelCommitValidationResult,
  ConversationLogRecord,
  ConversationLogRecordInput,
  CreateRoleModelCommitValidationSnapshotOptions,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RawEventLogRecordKind,
  RawEventLogPayloadSummary,
  RejectedRoleModelCommitValidationResult,
  RoleModelCommitValidationResult,
  RoleModelCommitValidationSnapshot,
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
  LocalRuntimeSessionReadinessValidator,
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
