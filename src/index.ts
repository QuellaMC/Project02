export * from './core/conversation.ts';
export * from './core/message-validation.ts';
export * from './plugins/index.ts';
export * from './plugins/builtin/character-state/schema.ts';
export * from './role-model/decision-context.ts';
export * from './role-model/model-tools.ts';
export * from './role-model/prompt.ts';
export {
  createAcceptedRoleModelDecisionResult,
  createCharacterDecision,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelPluginToolDefinitions,
  createRoleModelToolObservation,
  createVisibleReplyCharacterDecision,
  getCharacterStatePatchToolCall,
  getRequiredVisibleReplyText,
  getVisibleReplyToolCall,
  isRoleModelAllowedToolName,
  isRoleModelProviderErrorRawOutputEvidence,
  isRoleModelRawOutputReplayableDecisionEvidence,
  parseRoleModelDecision,
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelAdapterRejectionNotReplayableDetails,
  roleModelAllowedToolNames,
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
  roleModelPluginListToolName,
  roleModelPluginToolRejectedRejectionReason,
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
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelPluginToolDefinition,
  type RoleModelProviderMetadata,
  type RoleModelToolDefinition,
  type RoleModelToolObservation,
  type RoleModelToolObservationResult
} from './role-model/contracts.ts';
export {
  createDeterministicLocalRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent,
  defaultRoleModelMaxPluginToolRounds,
  defaultRoleModelMaxToolRounds,
  runRoleModelLoop,
  type AcceptedRoleModelLoopResult,
  type RejectedRoleModelLoopResult,
  type RoleModelAdapter,
  type RoleModelAdapterInvocation,
  type RoleModelAdapterRawOutput,
  type RoleModelInterimVisibleReplyEvent,
  type RoleModelLoopResult,
  type RoleModelLoopRound,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolCallsRequestedEvent,
  type RoleModelPluginToolHost,
  type RoleModelPluginToolRoutingEvidence,
  type RunRoleModelLoopOptions
} from './role-model/loop.ts';
export {
  createNvidiaRoleModelProviderAdapter,
  createNvidiaRoleModelProviderConfigFromEnv,
  defaultNvidiaChatCompletionsEndpoint,
  defaultNvidiaRoleModelReasoningBudget,
  defaultNvidiaRoleModelName,
  nvidiaApiKeyEnvName,
  nvidiaModelEnvName,
  nvidiaRoleModelMaxTokens,
  nvidiaRoleModelProviderName,
  nvidiaRoleModelTemperature,
  nvidiaRoleModelTopP,
  renderNvidiaMessages,
  renderNvidiaTools,
  type CreateNvidiaRoleModelProviderAdapterOptions,
  type NvidiaChatCompletionMessage,
  type NvidiaChatCompletionTool,
  type NvidiaFetchClient,
  type NvidiaFetchRequest,
  type NvidiaFetchResponse,
  type NvidiaRoleModelProviderConfig,
  type NvidiaRoleModelProviderEnvironment
} from './role-model/providers/nvidia.ts';
export * from './runtime/event.ts';
export * from './runtime/local.ts';
export * from './runtime/log.ts';
export * from './runtime/storage/file-runtime-log-store.ts';
export * from './runtime/storage/layout.ts';
export * from './runtime/storage/session-store.ts';

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
