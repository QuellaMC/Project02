import type {
  CharacterProfile,
  RuntimeEventIdentity,
  UserMessageRuntimeEvent,
  VisibleMessage,
} from '../../core/index.ts';
import type {
  RuntimePluginContextItem,
  RuntimePluginJsonValue,
  RuntimePluginProvidedTool,
} from '../../plugins/api/index.ts';
import type {ModelToolCall, ModelToolDefinition} from './model-tools.ts';
import type {RoleModelAllowedToolName} from './tool-names.ts';
import type {
  RoleModelChatCompletionTool,
  RoleModelChatMessage,
  RoleModelProviderCapabilities,
  RoleModelProviderToolNameMapping,
} from './chat-wire.ts';

export const roleModelDecisionContractVersion = 'mvp-006.tool_calls.v1';

export type RoleModelToolDefinition = ModelToolDefinition;

export type RoleModelPluginToolDefinition = RuntimePluginProvidedTool & {
  readonly pluginId: string;
};

export const roleModelDecisionOutputContractText =
  'Return exactly one complete valid JSON CharacterDecision object with ordered toolCalls. The only allowed top-level response fields are "toolCalls" and optional "text". Do not include a version field; the runtime stamps the internal decision version after validation. Do not copy input envelope fields such as event, decisionContext, recentVisibleMessages, toolObservations, pluginContextItems, characterSnapshot, allowedTools, toolDefinitions, responseContract, or runtimeInput. Each toolCalls item must use string field "name", not "tool" or "type", and object field "input". visible_reply is the only non-executed output tool. Any other tool call is executed and fed back as a tool observation. If visible_reply appears with executable tools, it is interim visible output. A response may use as many visible_reply calls as it has messages to send; each commits as its own message, in the order listed. A terminal response may end with visible_reply calls, or may use top-level text only as folded model text with no visible final reply.';

export type RoleModelOutputContract = {
  readonly version: string;
  readonly text: string;
};

export type RoleModelProviderMetadata = {
  readonly provider: 'local' | 'nvidia';
  readonly model?: string;
  readonly request?: {
    readonly endpoint?: string;
    readonly messageCount?: number;
    readonly stream: false;
  };
  readonly response?: {
    readonly status?: number;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
};

export type RoleModelThinkingMode =
  | {
      readonly mode: 'none';
    }
  | {
      readonly mode: 'enabled';
      readonly budgetTokens: number;
    };

export type RoleModelProviderExchangeSnapshot = {
  readonly provider: {
    readonly name: 'local' | 'nvidia';
    readonly model?: string;
    readonly endpoint?: string;
  };
  readonly capabilities: RoleModelProviderCapabilities;
  readonly reasoning: {
    readonly mode: RoleModelThinkingMode['mode'];
    readonly params: RuntimePluginJsonValue;
  };
  readonly renderedMessages: readonly RoleModelChatMessage[];
  readonly renderedTools: readonly RoleModelChatCompletionTool[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
  readonly toolChoice?: RuntimePluginJsonValue;
  readonly parallelToolCalls?: boolean;
  readonly requestBody: RuntimePluginJsonValue;
  readonly rawFinishReason?: RuntimePluginJsonValue;
  readonly finishReason?: string;
  readonly usage?: RuntimePluginJsonValue;
  readonly nativeAssistantMessage?: RoleModelChatMessage;
  readonly nativeToolResultMessages: readonly RoleModelChatMessage[];
  readonly responseBody?: RuntimePluginJsonValue;
  readonly outputNormalization?: {
    readonly source: 'terminal_assistant_content' | 'native_tool_calls';
    readonly committed: false;
  };
};

export const roleModelDecisionOutputContract = Object.freeze({
  version: roleModelDecisionContractVersion,
  text: roleModelDecisionOutputContractText,
} satisfies RoleModelOutputContract);

export type DecisionContext = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly recentVisibleMessages: readonly VisibleMessage[];
  readonly runtimeNotes: readonly string[];
  readonly pluginContextItems: readonly RuntimePluginContextItem[];
};

export type CreateDecisionContextOptions = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly recentVisibleMessages?: readonly VisibleMessage[];
  readonly runtimeNotes?: readonly string[];
  readonly pluginContextItems?: readonly RuntimePluginContextItem[];
};

export type RoleModelInputEnvelope = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly toolDefinitions: readonly RoleModelToolDefinition[];
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly toolObservations: readonly RoleModelToolObservation[];
  readonly outputContract: RoleModelOutputContract;
};

export type CreateRoleModelInputEnvelopeOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly toolObservations?: readonly RoleModelToolObservation[];
  readonly outputContract?: RoleModelOutputContract;
};

export type RoleModelToolObservation = {
  readonly round: number;
  readonly pluginId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, RuntimePluginJsonValue>>;
  readonly result: RoleModelToolObservationResult;
};

export type RoleModelToolObservationResult =
  | {
      readonly status: 'accepted';
      readonly output: RuntimePluginJsonValue;
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly message: string;
    };

export type CharacterDecision = {
  readonly version: typeof roleModelDecisionContractVersion;
  readonly toolCalls: readonly ModelToolCall[];
};

export const roleModelMalformedOutputRejectionReason = 'malformed_output';
export const roleModelMalformedToolCallRejectionReason = 'malformed_tool_call';
export const roleModelUnknownToolRejectionReason = 'unknown_tool';
export const roleModelDisallowedToolRejectionReason = 'disallowed_tool';
export const roleModelUnsupportedEffectRejectionReason = 'unsupported_effect';
export const roleModelInvalidVisibleReplyRejectionReason =
  'invalid_visible_reply';
export const roleModelProviderErrorRejectionReason = 'provider_error';
export const roleModelCommitValidationFailureRejectionReason =
  'commit_validation_failure';
export const roleModelPluginToolRejectedRejectionReason =
  'plugin_tool_rejected';
export const roleModelAdapterRawOutputMissingTextRejectionDetails =
  'Adapter raw output must include string rawOutputText.';
export const roleModelAdapterProviderExchangeMalformedDetails =
  'Role-model adapter provider exchange is malformed.';
export const roleModelAdapterNativeToolCallArgumentErrorsMalformedDetails =
  'Role-model adapter native tool-call argument errors are malformed.';
export const roleModelAdapterProviderRequestMessageCountNonFiniteDetails =
  'providerMetadata.request.messageCount must be finite JSON.';
export const roleModelAdapterProviderResponseStatusNonFiniteDetails =
  'providerMetadata.response.status must be finite JSON.';
export const roleModelAdapterRejectionNotReplayableDetails =
  'Adapter rejection must be replayable from rawOutputText.';
export const roleModelTerminalEmptyOutputRejectionDetails =
  'Terminal model output must include visible_reply or top-level text.';

export const roleModelMalformedAdapterRawOutputDetails = Object.freeze([
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelAdapterProviderExchangeMalformedDetails,
  roleModelAdapterNativeToolCallArgumentErrorsMalformedDetails,
  roleModelAdapterProviderRequestMessageCountNonFiniteDetails,
  roleModelAdapterProviderResponseStatusNonFiniteDetails,
  roleModelAdapterRejectionNotReplayableDetails,
] as const);

export type RoleModelMalformedAdapterRawOutputDetails =
  (typeof roleModelMalformedAdapterRawOutputDetails)[number];

export function isRoleModelMalformedAdapterRawOutputDetails(
  value: unknown,
): value is RoleModelMalformedAdapterRawOutputDetails {
  return roleModelMalformedAdapterRawOutputDetails.some(
    details => details === value,
  );
}

export type RoleModelDecisionRejectionReason =
  | typeof roleModelMalformedOutputRejectionReason
  | typeof roleModelMalformedToolCallRejectionReason
  | typeof roleModelUnknownToolRejectionReason
  | typeof roleModelDisallowedToolRejectionReason
  | typeof roleModelUnsupportedEffectRejectionReason
  | typeof roleModelInvalidVisibleReplyRejectionReason
  | typeof roleModelProviderErrorRejectionReason
  | typeof roleModelCommitValidationFailureRejectionReason
  | typeof roleModelPluginToolRejectedRejectionReason;

export const roleModelDecisionRejectionReasons = Object.freeze([
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelUnknownToolRejectionReason,
  roleModelDisallowedToolRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelCommitValidationFailureRejectionReason,
  roleModelPluginToolRejectedRejectionReason,
] satisfies readonly RoleModelDecisionRejectionReason[]);

export type RoleModelDecisionRejection = {
  readonly reason: RoleModelDecisionRejectionReason;
  readonly details?: string;
};

export type AcceptedRoleModelDecisionResult = {
  readonly status: 'accepted';
  readonly decision: CharacterDecision;
  readonly nonCommittedText?: string;
};

export type RejectedRoleModelDecisionResult = {
  readonly status: 'rejected';
  readonly rejection: RoleModelDecisionRejection;
  readonly requestedToolNames?: readonly RoleModelAllowedToolName[];
};

export type RoleModelDecisionResult =
  AcceptedRoleModelDecisionResult | RejectedRoleModelDecisionResult;

// Provider-independent per-turn character identification: which character
// definition (content revision included) produced this turn. Additive and
// optional so records written before it decode unchanged.
export type RoleModelCharacterRef = {
  readonly id: string;
  readonly version: string;
  readonly personaFingerprint: string;
};

export type RoleModelIOSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_io_snapshot';
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
  readonly characterRef?: RoleModelCharacterRef;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
};

export type CreateRoleModelIOSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
  readonly characterRef?: RoleModelCharacterRef;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
};

export type ParsedRoleModelDecisionSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_decision_snapshot';
  readonly sessionId: string;
  readonly result: RoleModelDecisionResult;
};

export type CreateParsedRoleModelDecisionSnapshotOptions =
  RuntimeEventIdentity & {
    readonly sessionId: string;
    readonly result: RoleModelDecisionResult;
  };
