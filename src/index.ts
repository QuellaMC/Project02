export {
  CharacterInputError,
  CharacterReplyValidationError,
  ConversationRehydrationError,
  appendCharacterVisibleMessage,
  createConversationSession,
  createDeterministicCharacterAgent,
  localCharacterProfile,
  defaultRecentVisibleMessageLimit,
  normalizeCharacterAgentReply,
  runCharacterTurn,
  selectRecentVisibleMessages,
  validateCharacterAgentReply,
  validateRestoredVisibleTranscript,
  type CharacterAgent,
  type CharacterAgentInput,
  type CharacterMessageAppendResult,
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
  createRoleModelPluginToolDefinitions,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelToolObservation,
  createVisibleReplyCharacterDecision,
  getCharacterStatePatchToolCall,
  getRequiredVisibleReplyText,
  getVisibleReplyToolCall,
  roleModelAllowedToolNames,
  roleModelAdapterRejectionNotReplayableDetails,
  roleModelPluginListToolName,
  roleModelPluginToolRejectedRejectionReason,
  roleModelCharacterStatePatchToolName,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  roleModelDecisionOutputContractText,
  roleModelDecisionRejectionReasons,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelUnknownToolRejectionReason,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type CreateDecisionContextOptions,
  type CreateParsedRoleModelDecisionSnapshotOptions,
  type CreateRoleModelInputEnvelopeOptions,
  type CreateRoleModelIOSnapshotOptions,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelAllowedToolName,
  type RoleModelPluginToolDefinition,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelProviderMetadata,
  type RoleModelToolDefinition,
  type RoleModelToolObservation,
  type RoleModelToolObservationResult
} from './role-model-contracts.ts';

export {
  builtInModelToolDefinitions,
  builtInModelToolDefinitionsForUserTurn,
  characterStatePatchModelToolName,
  createCharacterStatePatchModelToolCall,
  createVisibleReplyModelToolCall,
  findCharacterStatePatchModelToolCall,
  findVisibleReplyModelToolCall,
  freezeModelToolCall,
  freezeModelToolDefinition,
  validateModelToolInputAgainstContract,
  requiredUserTurnBuiltInModelToolNames,
  userTurnBuiltInModelToolNames,
  visibleReplyModelToolName,
  type BuiltInModelToolCall,
  type BuiltInModelToolDefinition,
  type BuiltInModelToolName,
  type CharacterStatePatchModelToolCall,
  type CharacterStatePatchModelToolName,
  type CharacterStatePatchToolInput,
  type PluginModelToolCall,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelToolInputContract,
  type ModelToolInputField,
  type ModelToolInputFieldValueType,
  type ModelToolInputValidationResult,
  type VisibleReplyModelToolCall,
  type VisibleReplyModelToolName,
  type VisibleReplyToolInput
} from './model-tools.ts';

export {
  runtimePluginContractVersion,
  createRuntimePlugin,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginListingSnapshot,
  createRuntimePluginManifest,
  createRuntimePluginProvidedTool,
  createRuntimePluginRegistrySnapshot,
  createRuntimePluginTurnEvidenceSnapshot,
  createFirstPartyModelToolsPlugin,
  createRuntimePluginContext,
  firstPartyModelToolsPluginId,
  validateRuntimePluginContextItem,
  validateRuntimePluginManifest,
  validateRuntimePluginProvidedTool,
  type RuntimePluginApiGrant,
  type RuntimePlugin,
  type RuntimePluginActivationMetadata,
  type RuntimePluginAfterTurnCommittedFailureBehavior,
  type RuntimePluginBeforeRoleModelCallResult,
  type RuntimePluginBeforeRoleModelFailureBehavior,
  type RuntimePluginConfigField,
  type RuntimePluginConfigMetadata,
  type RuntimePluginConfirmationRequirement,
  type RuntimePluginContextBudget,
  type RuntimePluginContextItem,
  type RuntimePluginContextItemKind,
  type RuntimePluginDeclaration,
  type RuntimePluginEvidenceKind,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginEvidenceStatus,
  type RuntimePluginFileStore,
  type RuntimePluginHandleToolCallFailureBehavior,
  type RuntimePluginHealthFailureBehavior,
  type RuntimePluginHealthSnapshot,
  type RuntimePluginHealthStatus,
  type RuntimePluginHookResult,
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
  type RuntimePluginKind,
  type RuntimePluginLifecycleHooks,
  type RuntimePluginListingSnapshot,
  type RuntimePluginManifest,
  type RuntimePluginPolicyOutcome,
  type RuntimePluginProvidedTool,
  type RuntimePluginRegistrySnapshot,
  type RuntimePluginRegistrationSnapshot,
  type RuntimePluginRuntimePolicy,
  type RuntimePluginSideEffectLevel,
  type RuntimePluginSourceKind,
  type RuntimePluginSourceReference,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
  type RuntimePluginToolValidationOwner,
  type RuntimePluginTrustLevel,
  type RuntimePluginTurnEvidenceSnapshot,
  type RuntimePluginValidationFailureReason,
  type RuntimePluginValidationResult,
  type CreateRuntimePluginContextOptions,
  type CreateRuntimePluginAfterTurnCommittedContextOptions,
  type RuntimePluginAfterTurnCommittedContext,
  type RuntimePluginCommittedTurnSnapshot,
  type RuntimePluginContext
} from './plugins/types.ts';

export {
  createDefaultProject02PluginHost,
  createRuntimePluginHost,
  runtimePluginBeforeRoleModelCallRejectionReason,
  runtimePluginDiscoveryPluginId,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginBeforeRoleModelCallCompletedResult,
  type RuntimePluginBeforeRoleModelCallHostResult,
  type RuntimePluginBeforeRoleModelCallRejectedResult,
  type RuntimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginHealthHostResult,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost
} from './plugins/host.ts';

export {
  mapFirstPartyModelToolsPlugin,
  mapHermesMemoryProviderFixture,
  mapMcpToolsResourcesFixture,
  mapOpenClawMemoryPluginFixture,
  mapTencentDbMemoryGatewayFixture,
  type RuntimePluginAdapterCompatibilityDisposition,
  type RuntimePluginAdapterCompatibilityNote,
  type RuntimePluginAdapterMapping
} from './plugins/adapters/index.ts';

export {
  createRoleModelPromptPayload,
  renderRoleModelPromptMessages,
  roleModelPromptResponseExample,
  roleModelPromptSystemMessage,
  type RoleModelPromptMessage,
  type RoleModelPromptPayload
} from './role-model-prompt.ts';

export {
  createDeterministicLocalRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent,
  defaultRoleModelMaxPluginToolRounds,
  parseRoleModelDecision,
  runRoleModelLoop,
  type AcceptedRoleModelLoopResult,
  type RejectedRoleModelLoopResult,
  type RoleModelAdapter,
  type RoleModelAdapterRawOutput,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolHost,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolRoutingEvidence,
  type RoleModelInterimVisibleReplyEvent,
  type RoleModelLoopRound,
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
  type LocalRuntimeTurnProgressEvent,
  type RunLocalUserMessageEventOptions,
  type RecordLocalUserMessageInputRejectionOptions
} from './local-runtime.ts';

export { createFileRuntimeLogStore } from './file-runtime-log-store.ts';

export type {
  CreateFileRuntimeLogStoreOptions
} from './file-runtime-log-store.ts';

export {
  characterStatePluginId,
  createCharacterStatePlugin,
  createRuntimePluginFileStore
} from './plugins/index.ts';

export type {
  CreateRuntimePluginFileStoreOptions
} from './plugins/index.ts';

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
