import type {
  CharacterProfile,
  RuntimeEventIdentity,
  UserMessageRuntimeEvent,
  VisibleMessage,
} from '../../core/index.ts';

import type {
  RuntimePluginContextItem,
  RuntimePluginCuratedContextSection,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginProvidedTool,
} from '../../plugins/api/index.ts';
import type {ModelToolCall, ModelToolDefinition} from './model-tools.ts';
import type {RoleModelPromptSize} from './prompt-size.ts';
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

export type RoleModelOutputContract = {
  readonly version: string;
  readonly text: string;
};

export type RoleModelProviderMetadata = {
  readonly provider: 'nvidia';
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

export type RoleModelProviderExchangeSnapshot = {
  readonly provider: {
    readonly name: 'nvidia';
    readonly model?: string;
    readonly endpoint?: string;
  };
  readonly capabilities: RoleModelProviderCapabilities;
  readonly reasoning: {
    readonly mode: 'enabled';
    readonly params: RuntimePluginJsonValue;
  };
  readonly renderedMessages: readonly RoleModelChatMessage[];
  readonly renderedTools: readonly RoleModelChatCompletionTool[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
  readonly requestBody: RuntimePluginJsonValue;
  readonly finishReason?: string;
  readonly usage?: RuntimePluginJsonValue;
  /** The response message as the provider returned it; the runtime replays its own rendering. */
  readonly nativeAssistantMessage?: RoleModelChatMessage;
};

export const roleModelDecisionOutputContract = Object.freeze({
  version: roleModelDecisionContractVersion,
  text: 'Return exactly one complete valid JSON CharacterDecision object. The only top-level fields are "toolCalls" (required, non-empty, in order) and optional "text". Do not include a version field; the runtime stamps the internal decision version after validation. Do not copy input envelope fields such as event, decisionContext, historyWindow, toolRounds, pluginContextItems, characterSnapshot, allowedTools, toolDefinitions, responseContract, or runtimeInput. Each toolCalls item must use string field "name", not "tool" or "type", and object field "input". visible_reply is how you speak: each visible_reply commits as its own message, in the order listed; any other tool call is executed and fed back as a tool observation; a visible_reply alongside executable calls is interim output, and the turn ends on a response whose calls are all visible_reply. A response must reply or call a tool. "text" is your own note next to your calls: it is kept with the decision and shown to you again, never to the person.',
} satisfies RoleModelOutputContract);

/**
 * What a model turn persists about its history: which turns were replayed,
 * oldest first. The turns themselves are already durable in the session log.
 */
export type ConversationHistoryWindow = {
  readonly turnEventIds: readonly string[];
};

/** A trusted per-turn note; the runtime authors it when no plugin id is set. */
export type DecisionRuntimeNote = {
  readonly id: string;
  readonly text: string;
  readonly pluginId?: string;
};

export type DecisionContext = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  /** The prior turns replayed to the model, by identity; bodies live in the log. */
  readonly historyWindow: ConversationHistoryWindow;
  /** The condensed earlier conversation a continued session opens with. */
  readonly contextSummary?: string;
  readonly runtimeNotes: readonly DecisionRuntimeNote[];
  readonly pluginContextItems: readonly RuntimePluginContextItem[];
  readonly curatedContextSections: readonly RuntimePluginCuratedContextSection[];
};

export type CreateDecisionContextOptions = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly historyWindow?: ConversationHistoryWindow;
  readonly contextSummary?: string;
  readonly runtimeNotes?: readonly DecisionRuntimeNote[];
  readonly pluginContextItems?: readonly RuntimePluginContextItem[];
  readonly curatedContextSections?: readonly RuntimePluginCuratedContextSection[];
};

export type RoleModelInputEnvelope = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly toolDefinitions: readonly RoleModelToolDefinition[];
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  /** This turn's finished tool rounds so far, rendered to the model after its message. */
  readonly toolRounds: readonly ConversationToolRound[];
  readonly outputContract: RoleModelOutputContract;
};

export type CreateRoleModelInputEnvelopeOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly toolRounds?: readonly ConversationToolRound[];
  readonly outputContract?: RoleModelOutputContract;
};

export type ConversationToolCallResult =
  | {
      readonly status: 'accepted';
      readonly output: RuntimePluginJsonValue;
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly message: string;
    };

/** One completed tool call of a round: what the model asked and what came back. */
export type ConversationToolCall = {
  readonly toolCallId: string;
  readonly pluginId: string;
  readonly toolName: string;
  readonly input: RuntimePluginJsonObject;
  readonly result: ConversationToolCallResult;
};

/**
 * One executable round, of this turn or a prior one — the one shape the
 * model is shown a tool round in.
 */
export type ConversationToolRound = {
  readonly round: number;
  /** What the model wrote besides its calls this round, when it wrote anything. */
  readonly text?: string;
  /** visible_reply texts the model committed in this round, commit order. */
  readonly interimReplies: readonly VisibleMessage[];
  readonly toolCalls: readonly ConversationToolCall[];
};

/**
 * A completed turn as the model replays it: the person's message, every tool
 * round with its results, then the character's final replies. Turn identity
 * is the runtime event that opened it.
 */
export type ConversationTurn = RuntimeEventIdentity & {
  readonly userMessage: VisibleMessage;
  readonly toolRounds: readonly ConversationToolRound[];
  readonly finalReplies: readonly VisibleMessage[];
};

export type CharacterDecision = {
  readonly version: typeof roleModelDecisionContractVersion;
  readonly toolCalls: readonly ModelToolCall[];
  /**
   * What the model wrote besides its tool calls. Kept with the decision and
   * replayed to the model; never shown to the person.
   */
  readonly text?: string;
};

/**
 * Who refuses a round: the parser owns malformed_output (any shape the
 * decision contract does not allow); the provider adapters own
 * provider_error (nothing usable arrived, the turn ends); the loop owns
 * tool_rounds_exhausted and the runtime commit_validation_failure, both
 * recorded in commit validation while the parsed snapshot stays accepted.
 */
export const roleModelMalformedOutputRejectionReason = 'malformed_output';
export const roleModelProviderErrorRejectionReason = 'provider_error';
export const roleModelToolRoundsExhaustedRejectionReason =
  'tool_rounds_exhausted';
export const roleModelCommitValidationFailureRejectionReason =
  'commit_validation_failure';

export type RoleModelDecisionRejectionReason =
  | typeof roleModelMalformedOutputRejectionReason
  | typeof roleModelProviderErrorRejectionReason
  | typeof roleModelToolRoundsExhaustedRejectionReason
  | typeof roleModelCommitValidationFailureRejectionReason;

export const roleModelDecisionRejectionReasons = Object.freeze([
  roleModelMalformedOutputRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelToolRoundsExhaustedRejectionReason,
  roleModelCommitValidationFailureRejectionReason,
] satisfies readonly RoleModelDecisionRejectionReason[]);

export type RoleModelDecisionRejection = {
  readonly reason: RoleModelDecisionRejectionReason;
  readonly details?: string;
};

export type AcceptedRoleModelDecisionResult = {
  readonly status: 'accepted';
  readonly decision: CharacterDecision;
};

export type RejectedRoleModelDecisionResult = {
  readonly status: 'rejected';
  readonly rejection: RoleModelDecisionRejection;
};

export type RoleModelDecisionResult =
  AcceptedRoleModelDecisionResult | RejectedRoleModelDecisionResult;

// Optional so records written before it decode unchanged.
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
  readonly promptSize?: RoleModelPromptSize;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
};

export type CreateRoleModelIOSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
  readonly characterRef?: RoleModelCharacterRef;
  readonly promptSize?: RoleModelPromptSize;
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
