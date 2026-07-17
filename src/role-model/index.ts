/**
 * Public API of src/role-model.
 *
 * Cross-module imports of role-model land here (arch:check rule 5).
 * plugins/api files must NOT import this barrel (cycle) — they use the
 * plugin-independent role-model/api/index.ts instead.
 */
export {
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type CreateDecisionContextOptions,
  type CreateParsedRoleModelDecisionSnapshotOptions,
  type CreateRoleModelInputEnvelopeOptions,
  type CreateRoleModelIOSnapshotOptions,
  type DecisionContext,
  isRoleModelMalformedAdapterRawOutputDetails,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  roleModelAdapterNativeToolCallArgumentErrorsMalformedDetails,
  roleModelAdapterProviderExchangeMalformedDetails,
  roleModelAdapterProviderRequestMessageCountNonFiniteDetails,
  roleModelAdapterProviderResponseStatusNonFiniteDetails,
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelAdapterRejectionNotReplayableDetails,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  roleModelDecisionOutputContractText,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  roleModelDecisionRejectionReasons,
  type RoleModelDecisionResult,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  type RoleModelInputEnvelope,
  roleModelInvalidVisibleReplyRejectionReason,
  type RoleModelIOSnapshot,
  type RoleModelMalformedAdapterRawOutputDetails,
  roleModelMalformedAdapterRawOutputDetails,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  type RoleModelOutputContract,
  type RoleModelPluginToolDefinition,
  roleModelPluginToolRejectedRejectionReason,
  roleModelProviderErrorRejectionReason,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  roleModelTerminalEmptyOutputRejectionDetails,
  type RoleModelThinkingMode,
  type RoleModelToolDefinition,
  type RoleModelToolObservation,
  type RoleModelToolObservationResult,
  roleModelUnknownToolRejectionReason,
  roleModelUnsupportedEffectRejectionReason
} from './api/contracts.ts';
export {
  createAcceptedRoleModelDecisionResult,
  createCharacterDecision,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelToolObservation,
  createVisibleReplyCharacterDecision,
  freezeAllowedTools
} from './api/decision.ts';
export {
  buildUserTurnDecisionContext,
  type BuildUserTurnDecisionContextOptions
} from './api/decision-context.ts';
export {
  createRoleModelAdapterRawOutput,
  type RoleModelAdapter,
  type RoleModelAdapterInvocation,
  type RoleModelAdapterRawOutput,
  type RoleModelNativeToolCallArgumentError
} from './api/adapter.ts';
export {
  freezeProviderMetadata,
  freezeRoleModelProviderExchangeSnapshot,
  freezeRuntimePluginJsonObject,
  freezeRuntimePluginJsonValue,
  isJsonRecord,
  parseRoleModelProviderExchangeSnapshot
} from './api/provider-exchange.ts';
export {
  createDefaultRoleModelPluginToolDefinitions,
  createRoleModelPluginToolDefinitions,
  defaultAllowedToolsForPluginDefinitions,
  modelToolDefinitionsForPluginToolDefinitions,
  toolDefinitionsForAllowedTools
} from './api/plugin-tool-definitions.ts';
export {
  scrubReasoningBlocks,
  type ScrubReasoningBlocksResult
} from './api/reasoning.ts';
export {
  type AcceptedRoleModelLoopResult,
  defaultRoleModelMaxToolRounds,
  type RejectedRoleModelLoopResult,
  type RoleModelInterimVisibleReplyEvent,
  type RoleModelLoopExecutionResult,
  type RoleModelLoopResult,
  type RoleModelLoopRound,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolHost,
  type RoleModelPluginToolRoutingEvidence,
  runRoleModelLoop,
  type RunRoleModelLoopOptions
} from './loop/loop.ts';
export {
  getRequiredVisibleReplyText,
  getVisibleReplyToolCall,
  isRoleModelProviderErrorRawOutputEvidence,
  isRoleModelRawOutputReplayableDecisionEvidence,
  normalizeReplayableRejectedRoleModelDecisionResult,
  parseRoleModelDecision,
  parseRoleModelExecutionDecision
} from './loop/decision-parser.ts';
export {
  createRoleModelProviderToolNameMappings,
  defaultRoleModelProviderCapabilities,
  modelToolDefinitionToChatTool,
  prepareRoleModelRequest,
  providerToolNameForRuntimeToolName,
  renderRoleModelTurnContext,
  type RenderRoleModelTurnContextOptions,
  type RoleModelPreparedRequest,
  type RoleModelPromptFragment,
  type RoleModelPromptFragmentKind,
  type RoleModelPromptFragmentSlot,
  type RoleModelPromptFrame,
  type RoleModelPromptFrameKind,
  roleModelStableSystemPromptText,
  type RoleModelTurnContext,
  runtimeToolNameForProviderToolName
} from './prompt/render.ts';
export {
  createDeterministicCharacterAgent
} from './providers/deterministic.ts';
export {
  createDeterministicLocalRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent
} from './providers/local.ts';
export {
  createNvidiaRoleModelProviderAdapter,
  type CreateNvidiaRoleModelProviderAdapterOptions,
  createNvidiaRoleModelProviderConfigFromEnv,
  defaultNvidiaChatCompletionsEndpoint,
  defaultNvidiaRoleModelName,
  defaultNvidiaRoleModelReasoningBudget,
  defaultNvidiaRoleModelRequestTimeoutMs,
  nvidiaApiKeyEnvName,
  type NvidiaChatCompletionMessage,
  type NvidiaChatCompletionTool,
  type NvidiaFetchClient,
  type NvidiaFetchRequest,
  type NvidiaFetchResponse,
  nvidiaModelEnvName,
  nvidiaRoleModelMaxTokens,
  nvidiaRoleModelProviderCapabilities,
  type NvidiaRoleModelProviderConfig,
  type NvidiaRoleModelProviderEnvironment,
  nvidiaRoleModelProviderName,
  nvidiaRoleModelTemperature,
  type NvidiaRoleModelThinkingMode,
  nvidiaRoleModelTopP,
  renderNvidiaMessages,
  renderNvidiaTools
} from './providers/nvidia.ts';
export {
  createSelectedRoleModelAdapter,
  parseProviderName,
  providerOption,
  RoleModelProviderSelectionError,
  selectChatProvider,
  type ChatProviderName
} from './providers/select.ts';
export * from './api/index.ts';
