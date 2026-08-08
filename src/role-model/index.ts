/**
 * Cross-module imports of role-model land here (arch:check rule 5).
 * plugins/api files must import role-model/api/index.ts instead: cycle.
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
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelAdapterRejectionNotReplayableDetails,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  roleModelDecisionRejectionReasons,
  type RoleModelDecisionResult,
  roleModelDisallowedToolRejectionReason,
  type RoleModelInputEnvelope,
  roleModelInvalidVisibleReplyRejectionReason,
  type RoleModelCharacterRef,
  type RoleModelIOSnapshot,
  type RoleModelMalformedAdapterRawOutputDetails,
  roleModelMalformedAdapterRawOutputDetails,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  type RoleModelOutputContract,
  type RoleModelPluginToolDefinition,
  roleModelPluginToolRejectedRejectionReason,
  roleModelProviderErrorRejectionReason,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  roleModelTerminalEmptyOutputRejectionDetails,
  type RoleModelToolDefinition,
  type RoleModelToolObservation,
  type RoleModelToolObservationResult,
  roleModelUnsupportedEffectRejectionReason,
} from './api/contracts.ts';
export {
  assertRoleModelCharacterRefMatchesCharacter,
  createAcceptedRoleModelDecisionResult,
  createCharacterDecision,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelToolObservation,
  freezeAllowedTools,
} from './api/decision.ts';
export {
  buildUserTurnDecisionContext,
  type BuildUserTurnDecisionContextOptions,
} from './api/decision-context.ts';
export {
  createRoleModelAdapterRawOutput,
  type RoleModelAdapter,
  type RoleModelAdapterInvocation,
  type RoleModelAdapterRawOutput,
  type RoleModelNativeToolCallArgumentError,
} from './api/adapter.ts';
export {
  freezeProviderMetadata,
  freezeRoleModelProviderExchangeSnapshot,
  parseRoleModelProviderExchangeSnapshot,
} from './api/provider-exchange.ts';
export {
  createDefaultRoleModelPluginToolDefinitions,
  createRoleModelPluginToolDefinitions,
  defaultAllowedToolsForPluginDefinitions,
  modelToolDefinitionsForPluginToolDefinitions,
  toolDefinitionsForAllowedTools,
} from './api/plugin-tool-definitions.ts';
export {
  scrubReasoningBlocks,
  type ScrubReasoningBlocksResult,
} from './api/reasoning.ts';
export {
  type AcceptedRoleModelLoopResult,
  defaultRoleModelMaxToolRounds,
  executionVisibleReplyTexts,
  type RejectedRoleModelLoopResult,
  type RoleModelLoopResult,
  type RoleModelVisibleReplyEvent,
  type RoleModelLoopRound,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolHost,
  type RoleModelPluginToolRoutingEvidence,
  runRoleModelLoop,
  type RunRoleModelLoopOptions,
} from './loop/loop.ts';
export {
  getRequiredVisibleReplyText,
  visibleReplyToolCalls,
  parseRoleModelDecision,
  parseRoleModelExecutionDecision,
} from './loop/decision-parser.ts';
export {
  isRoleModelProviderErrorRawOutputEvidence,
  isRoleModelRawOutputReplayableDecisionEvidence,
  normalizeReplayableRejectedRoleModelDecisionResult,
} from './loop/replay-evidence.ts';
export {
  defaultRoleModelProviderCapabilities,
  renderRoleModelTurnContext,
  type RoleModelTurnContext,
} from './prompt/render.ts';
export {
  createRoleModelProviderToolNameMappings,
  modelToolDefinitionToChatTool,
  providerToolNameForRuntimeToolName,
  runtimeToolNameForProviderToolName,
} from './prompt/tool-wire.ts';
export {createDeterministicCharacterAgent} from './providers/deterministic.ts';
export {
  createDeterministicLocalRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent,
} from './providers/local.ts';
export {
  createNvidiaRoleModelProviderAdapter,
  type CreateNvidiaRoleModelProviderAdapterOptions,
  createNvidiaRoleModelProviderConfigFromEnv,
  defaultNvidiaRoleModelReasoningBudget,
  defaultNvidiaRoleModelRequestTimeoutMs,
  nvidiaApiKeyEnvName,
  type NvidiaFetchClient,
  type NvidiaFetchRequest,
  type NvidiaFetchResponse,
  nvidiaModelEnvName,
  nvidiaRoleModelProviderCapabilities,
  type NvidiaRoleModelProviderConfig,
} from './providers/nvidia.ts';
export {
  createSelectedRoleModelAdapter,
  parseProviderName,
  providerOption,
  RoleModelProviderSelectionError,
  selectChatProvider,
  type ChatProviderName,
} from './providers/select.ts';
export * from './api/index.ts';
