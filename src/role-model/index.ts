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
  type DecisionRuntimeNote,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  roleModelDecisionRejectionReasons,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelCharacterRef,
  type RoleModelIOSnapshot,
  roleModelMalformedOutputRejectionReason,
  type RoleModelOutputContract,
  type RoleModelPluginToolDefinition,
  roleModelProviderErrorRejectionReason,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  type RoleModelToolDefinition,
  roleModelToolRoundsExhaustedRejectionReason,
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
} from './api/decision.ts';
export {
  createRoleModelAdapterRawOutput,
  type RoleModelAdapter,
  type RoleModelAdapterInvocation,
  type RoleModelReplyDelta,
  type RoleModelTextCompletionRequest,
  type RoleModelTextCompletionResult,
  type RoleModelAdapterRawOutput,
} from './api/adapter.ts';
export {
  freezeProviderMetadata,
  freezeRoleModelProviderExchangeSnapshot,
  parseRoleModelProviderExchangeSnapshot,
} from './api/provider-exchange.ts';
export {
  freezeRoleModelPromptSize,
  type RoleModelPromptFrameSize,
  type RoleModelPromptSize,
} from './api/prompt-size.ts';
export {measureRoleModelPromptSize} from './prompt/prompt-size.ts';
export {estimateTokensForChars} from './prompt/token-estimate.ts';
export {createRoleModelPluginToolDefinitions} from './api/plugin-tool-definitions.ts';
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
  type RoleModelRoundEvent,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolHost,
  type RoleModelPluginToolRoutingEvidence,
  type RoleModelReplyDeltaEvent,
  type RoleModelReplyWithdrawnEvent,
  runRoleModelLoop,
  type RunRoleModelLoopOptions,
} from './loop/loop.ts';
export {
  executableModelToolCalls,
  visibleReplyToolCalls,
  parseRoleModelDecision,
  parseRoleModelExecutionDecision,
} from './loop/decision-parser.ts';
export {isRoleModelRawOutputReplayableDecisionEvidence} from './loop/replay-evidence.ts';
export {
  defaultRoleModelProviderCapabilities,
  renderRoleModelTurnContext,
  type RoleModelTurnContext,
} from './prompt/render.ts';
export {
  createTodayRuntimeNote,
  summarizerInstructions,
} from './prompt/prompt-text.ts';
export {
  assertConversationHistoryMatchesWindow,
  conversationHistoryWindow,
  conversationTurnVisibleMessages,
  createConversationToolRound,
  type ConversationHistoryWindow,
  type ConversationToolCall,
  type ConversationToolCallResult,
  type ConversationToolRound,
  type ConversationTurn,
} from './api/conversation-history.ts';
export {
  conversationTurnToChatMessages,
  estimateConversationTurnTokens,
  selectConversationHistoryWindow,
  toolRoundToChatMessages,
} from './prompt/conversation-history-wire.ts';
export {
  createRoleModelProviderToolNameMappings,
  modelToolDefinitionToChatTool,
  providerToolNameForRuntimeToolName,
  runtimeToolNameForProviderToolName,
} from './prompt/tool-wire.ts';
export {createDeterministicCharacterAgent} from './providers/deterministic.ts';
export {
  createDeterministicTestRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent,
} from './providers/test-provider.ts';
export {
  createNvidiaRoleModelProviderAdapter,
  type CreateNvidiaRoleModelProviderAdapterOptions,
  defaultNvidiaRoleModelReasoningBudget,
  defaultNvidiaRoleModelRequestTimeoutMs,
  type NvidiaFetchClient,
  type NvidiaFetchRequest,
  nvidiaRoleModelProviderCapabilities,
  type NvidiaRoleModelProviderConfig,
} from './providers/nvidia.ts';
export {
  createRoleModelProviderAdapter,
  type RoleModelProviderSettings,
} from './providers/select.ts';
export * from './api/index.ts';
