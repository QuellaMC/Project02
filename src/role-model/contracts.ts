import type { CharacterProfile, VisibleMessage } from '../core/conversation.ts';
import { firstPartyModelToolsProvidedTools } from '../plugins/builtin/model-tools.ts';
import {
  firstPartyModelToolsPluginId
} from '../plugins/contract.ts';
import { isApprovalGatedRuntimePluginTool } from '../plugins/tool-contract.ts';
import {
  createRuntimePluginContextItem,
  createRuntimePluginProvidedTool,
  redactRuntimePluginText,
  type RuntimePluginContextItem,
  type RuntimePluginJsonValue,
  type RuntimePluginProvidedTool
} from '../plugins/validation.ts';
import {
  createVisibleReplyModelToolCall,
  findVisibleReplyModelToolCall,
  freezeBuiltInModelToolCall,
  freezeModelToolCall,
  freezeModelToolCalls,
  freezeModelToolDefinition,
  isBuiltInModelToolName,
  isModelToolJsonSchemaType,
  userTurnBuiltInModelToolNames,
  validateModelToolInputAgainstContract,
  visibleReplyModelToolName,
  type BuiltInModelToolCall,
  type BuiltInModelToolName,
  type ModelToolCall,
  type ModelToolDefinition,
  type VisibleReplyModelToolCall
} from './model-tools.ts';
import type {
  RoleModelChatCompletionTool,
  RoleModelChatMessage,
  RoleModelProviderCapabilities,
  RoleModelProviderToolNameMapping
} from './prompt.ts';
import {
  assertCanonicalRuntimeTimestamp,
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent
} from '../runtime/event.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
  redactJsonBoundaryText,
  redactJsonTextPreservingStructure
} from '../shared/json-boundary.ts';
import { canonicalJsonValuesEqual } from '../shared/canonical-json.ts';
import { scrubReasoningBlocks } from './reasoning.ts';

export const roleModelDecisionContractVersion = 'mvp-006.tool_calls.v1';
export type RoleModelAllowedToolName = string;
export type RoleModelToolDefinition = ModelToolDefinition;

export type RoleModelPluginToolDefinition = RuntimePluginProvidedTool & {
  readonly pluginId: string;
};

export const roleModelAllowedToolNames = userTurnBuiltInModelToolNames;

export function isRoleModelAllowedToolName(
  value: unknown
): value is RoleModelAllowedToolName {
  return typeof value === 'string' && isRoleModelToolNameSyntax(value);
}

export function hasDuplicateRoleModelAllowedTools(
  values: readonly unknown[]
): boolean {
  return new Set(values).size !== values.length;
}

export const roleModelDecisionOutputContractText =
  'Return exactly one complete valid JSON CharacterDecision object with ordered toolCalls. The only allowed top-level response fields are "toolCalls" and optional "text". Do not include a version field; the runtime stamps the internal decision version after validation. Do not copy input envelope fields such as event, decisionContext, recentVisibleMessages, toolObservations, pluginContextItems, characterSnapshot, allowedTools, toolDefinitions, responseContract, or runtimeInput. Each toolCalls item must use string field "name", not "tool" or "type", and object field "input". visible_reply is the only non-executed output tool. Any other tool call is executed and fed back as a tool observation. If visible_reply appears with executable tools, it is interim visible output. A terminal response may use exactly one visible_reply, or may use top-level text only as folded model text with no visible final reply.';

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
  text: roleModelDecisionOutputContractText
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
export const roleModelDuplicateToolCallRejectionReason =
  'duplicate_tool_call';
export const roleModelMissingRequiredToolCallRejectionReason =
  'missing_required_tool_call';
export const roleModelUnsupportedEffectRejectionReason = 'unsupported_effect';
export const roleModelInvalidVisibleReplyRejectionReason = 'invalid_visible_reply';
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
  roleModelAdapterRejectionNotReplayableDetails
] as const);

export type RoleModelMalformedAdapterRawOutputDetails =
  (typeof roleModelMalformedAdapterRawOutputDetails)[number];

export function isRoleModelMalformedAdapterRawOutputDetails(
  value: unknown
): value is RoleModelMalformedAdapterRawOutputDetails {
  return roleModelMalformedAdapterRawOutputDetails.some(
    (details) => details === value
  );
}

export type RoleModelDecisionRejectionReason =
  | typeof roleModelMalformedOutputRejectionReason
  | typeof roleModelMalformedToolCallRejectionReason
  | typeof roleModelUnknownToolRejectionReason
  | typeof roleModelDisallowedToolRejectionReason
  | typeof roleModelDuplicateToolCallRejectionReason
  | typeof roleModelMissingRequiredToolCallRejectionReason
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
  roleModelDuplicateToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelCommitValidationFailureRejectionReason,
  roleModelPluginToolRejectedRejectionReason
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
  | AcceptedRoleModelDecisionResult
  | RejectedRoleModelDecisionResult;

export type RoleModelIOSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_io_snapshot';
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
};

export type CreateRoleModelIOSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
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

export function createDecisionContext(
  options: CreateDecisionContextOptions
): DecisionContext {
  return Object.freeze({
    sessionId: options.sessionId,
    characterSnapshot: freezeCharacterProfileSnapshot(options.characterSnapshot),
    recentVisibleMessages: freezeVisibleMessageSnapshots(
      options.recentVisibleMessages ?? []
    ),
    runtimeNotes: Object.freeze([...(options.runtimeNotes ?? [])]),
    pluginContextItems: freezePluginContextItems(
      options.pluginContextItems ?? []
    )
  } satisfies DecisionContext);
}

export function createRoleModelInputEnvelope(
  options: CreateRoleModelInputEnvelopeOptions
): RoleModelInputEnvelope {
  const pluginToolDefinitions = createRoleModelPluginToolDefinitions(
    options.pluginToolDefinitions
  );
  const modelToolDefinitions = modelToolDefinitionsForPluginToolDefinitions(
    pluginToolDefinitions
  );
  const allowedTools = freezeAllowedTools(
    options.allowedTools ??
      defaultAllowedToolsForPluginDefinitions(pluginToolDefinitions),
    modelToolDefinitions
  );

  return Object.freeze({
    event: freezeUserMessageRuntimeEventSnapshot(options.event),
    decisionContext: createDecisionContext(options.decisionContext),
    allowedTools,
    toolDefinitions: toolDefinitionsForAllowedTools({
      allowedTools,
      toolDefinitions: modelToolDefinitions
    }),
    pluginToolDefinitions,
    toolObservations: freezeRoleModelToolObservations(
      options.toolObservations ?? []
    ),
    outputContract: freezeRoleModelOutputContract(
      options.outputContract ?? roleModelDecisionOutputContract
    )
  } satisfies RoleModelInputEnvelope);
}

export function createRoleModelToolObservation(
  observation: RoleModelToolObservation
): RoleModelToolObservation {
  return freezeRoleModelToolObservation(observation);
}

export function createCharacterDecision(
  toolCalls: readonly ModelToolCall[]
): CharacterDecision {
  assertVisibleReplyCardinality(toolCalls);

  return freezeCharacterDecision({
    version: roleModelDecisionContractVersion,
    toolCalls
  });
}

function assertVisibleReplyCardinality(toolCalls: readonly ModelToolCall[]): void {
  const visibleReplyCount = toolCalls.filter(
    (call) => call.name === visibleReplyModelToolName
  ).length;

  if (visibleReplyCount > 1) {
    throw new TypeError('Decision must not include duplicate visible_reply tool calls.');
  }
}

export function createVisibleReplyCharacterDecision(
  text: string
): CharacterDecision {
  return createCharacterDecision([createVisibleReplyModelToolCall(text)]);
}

export function createAcceptedRoleModelDecisionResult(
  decision: CharacterDecision,
  options: {
    readonly nonCommittedText?: string;
  } = {}
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: freezeCharacterDecision(decision),
    ...(options.nonCommittedText === undefined
      ? {}
      : { nonCommittedText: redactJsonBoundaryText(options.nonCommittedText) })
  } satisfies AcceptedRoleModelDecisionResult);
}

export function createRejectedRoleModelDecisionResult(
  reason: RoleModelDecisionRejectionReason,
  details?: string,
  options: {
    readonly requestedToolNames?: readonly RoleModelAllowedToolName[];
  } = {}
): RejectedRoleModelDecisionResult {
  return Object.freeze({
    status: 'rejected',
    rejection: freezeRoleModelDecisionRejection({
      reason,
      ...(details === undefined ? {} : { details })
    }),
    ...(options.requestedToolNames === undefined
      ? {}
      : {
          requestedToolNames: freezeRequestedToolNames(
            options.requestedToolNames
          )
        })
  } satisfies RejectedRoleModelDecisionResult);
}

function freezeRequestedToolNames(
  requestedToolNames: readonly RoleModelAllowedToolName[]
): readonly RoleModelAllowedToolName[] {
  if (!requestedToolNames.every(isRoleModelAllowedToolName)) {
    throw new TypeError(
      'Role-model requestedToolNames must contain only valid tool names.'
    );
  }

  return Object.freeze([...requestedToolNames]);
}

export function createRoleModelIOSnapshot(
  options: CreateRoleModelIOSnapshotOptions
): RoleModelIOSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);

  return Object.freeze({
    ...identity,
    kind: 'role_model_io_snapshot',
    sessionId: options.sessionId,
    inputEnvelope: createRoleModelInputEnvelope(options.inputEnvelope),
    rawOutputText: redactJsonTextPreservingStructure(
      options.rawOutputText,
      'Role-model adapter raw output'
    ),
    ...(options.providerMetadata === undefined
      ? {}
      : { providerMetadata: freezeProviderMetadata(options.providerMetadata) }),
    ...(options.providerExchange === undefined
      ? {}
      : {
          providerExchange: freezeRoleModelProviderExchangeSnapshot(
            options.providerExchange
          )
        })
  } satisfies RoleModelIOSnapshot);
}

export function createParsedRoleModelDecisionSnapshot(
  options: CreateParsedRoleModelDecisionSnapshotOptions
): ParsedRoleModelDecisionSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);

  return Object.freeze({
    ...identity,
    kind: 'role_model_decision_snapshot',
    sessionId: options.sessionId,
    result: freezeRoleModelDecisionResult(options.result)
  } satisfies ParsedRoleModelDecisionSnapshot);
}

export function parseRoleModelDecision(
  rawOutputText: string,
  allowedTools: readonly RoleModelAllowedToolName[] = roleModelAllowedToolNames,
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[] =
    createDefaultRoleModelPluginToolDefinitions(),
  toolObservations: readonly RoleModelToolObservation[] = []
): RoleModelDecisionResult {
  return parseRoleModelDecisionForBoundary(
    rawOutputText,
    allowedTools,
    pluginToolDefinitions,
    toolObservations,
    'public_snapshot'
  );
}

export function parseRoleModelExecutionDecision(
  rawOutputText: string,
  allowedTools: readonly RoleModelAllowedToolName[] = roleModelAllowedToolNames,
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[] =
    createDefaultRoleModelPluginToolDefinitions(),
  toolObservations: readonly RoleModelToolObservation[] = []
): RoleModelDecisionResult {
  return parseRoleModelDecisionForBoundary(
    rawOutputText,
    allowedTools,
    pluginToolDefinitions,
    toolObservations,
    'execution'
  );
}

type RoleModelDecisionBoundary = 'execution' | 'public_snapshot';

function parseRoleModelDecisionForBoundary(
  rawOutputText: string,
  allowedTools: readonly RoleModelAllowedToolName[],
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
  toolObservations: readonly RoleModelToolObservation[],
  boundary: RoleModelDecisionBoundary
): RoleModelDecisionResult {
  let parsedOutput: unknown;

  try {
    parsedOutput = JSON.parse(rawOutputText);
  } catch {
    return createMalformedOutputResult('Adapter output must be valid JSON.');
  }

  return parseRoleModelDecisionObject(
    parsedOutput,
    allowedTools,
    pluginToolDefinitions,
    toolObservations,
    boundary
  );
}

export function isRoleModelRawOutputReplayableDecisionEvidence(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RoleModelDecisionResult;
  readonly allowedTools?: readonly RoleModelAllowedToolName[] | undefined;
  readonly pluginToolDefinitions?:
    | readonly RoleModelPluginToolDefinition[]
    | undefined;
  readonly toolObservations?: readonly RoleModelToolObservation[] | undefined;
}): boolean {
  const parsedRawOutputDecision = parseRoleModelDecision(
    options.rawOutputText,
    options.allowedTools,
    options.pluginToolDefinitions,
    options.toolObservations
  );

  return (
    roleModelDecisionResultsMatch({
      actual: options.decisionResult,
      expected: parsedRawOutputDecision
    }) ||
    isRoleModelMalformedAdapterRawOutputEvidence({
      rawOutputText: options.rawOutputText,
      decisionResult: options.decisionResult
    }) ||
    isRoleModelTerminalEmptyOutputRejectionEvidence({
      parsedRawOutputDecision,
      decisionResult: options.decisionResult
    }) ||
    isRoleModelProviderErrorRawOutputEvidence({
      rawOutputText: options.rawOutputText,
      providerMetadata: options.providerMetadata,
      decisionResult: options.decisionResult
    })
  );
}

export function normalizeReplayableRejectedRoleModelDecisionResult(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly pluginToolDefinitions?: readonly RoleModelPluginToolDefinition[];
  readonly toolObservations?: readonly RoleModelToolObservation[];
}): RejectedRoleModelDecisionResult | undefined {
  if (
    isRoleModelRawOutputReplayableDecisionEvidence({
      rawOutputText: options.rawOutputText,
      providerMetadata: options.providerMetadata,
      decisionResult: options.decisionResult,
      ...(options.allowedTools === undefined
        ? {}
        : { allowedTools: options.allowedTools }),
      ...(options.pluginToolDefinitions === undefined
        ? {}
        : { pluginToolDefinitions: options.pluginToolDefinitions }),
      ...(options.toolObservations === undefined
        ? {}
        : { toolObservations: options.toolObservations })
    })
  ) {
    return options.decisionResult;
  }

  if (options.decisionResult.requestedToolNames !== undefined) {
    return undefined;
  }

  const canonicalResult = parseRoleModelDecision(
    options.rawOutputText,
    options.allowedTools,
    options.pluginToolDefinitions,
    options.toolObservations
  );

  if (
    canonicalResult.status !== 'rejected' ||
    canonicalResult.requestedToolNames === undefined
  ) {
    return undefined;
  }

  const normalizedResult = createRejectedRoleModelDecisionResult(
    options.decisionResult.rejection.reason,
    options.decisionResult.rejection.details,
    {
      requestedToolNames: canonicalResult.requestedToolNames
    }
  );

  return isRoleModelRawOutputReplayableDecisionEvidence({
    rawOutputText: options.rawOutputText,
    providerMetadata: options.providerMetadata,
    decisionResult: normalizedResult,
    ...(options.allowedTools === undefined
      ? {}
      : { allowedTools: options.allowedTools }),
    ...(options.pluginToolDefinitions === undefined
      ? {}
      : { pluginToolDefinitions: options.pluginToolDefinitions }),
    ...(options.toolObservations === undefined
      ? {}
      : { toolObservations: options.toolObservations })
  })
    ? normalizedResult
    : undefined;
}

function isRoleModelTerminalEmptyOutputRejectionEvidence(options: {
  readonly parsedRawOutputDecision: RoleModelDecisionResult;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  return (
    options.parsedRawOutputDecision.status === 'accepted' &&
    options.parsedRawOutputDecision.decision.toolCalls.length === 0 &&
    options.parsedRawOutputDecision.nonCommittedText === undefined &&
    options.decisionResult.status === 'rejected' &&
    options.decisionResult.rejection.reason ===
      roleModelMalformedOutputRejectionReason &&
    options.decisionResult.rejection.details ===
      roleModelTerminalEmptyOutputRejectionDetails
  );
}

export function isRoleModelProviderErrorRawOutputEvidence(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  const providerError = options.providerMetadata?.error;

  return (
    options.rawOutputText.length === 0 &&
    providerError !== undefined &&
    options.decisionResult.status === 'rejected' &&
    options.decisionResult.rejection.reason ===
      roleModelProviderErrorRejectionReason &&
    options.decisionResult.rejection.details === providerError.message
  );
}

function roleModelDecisionResultsMatch(options: {
  readonly actual: RoleModelDecisionResult;
  readonly expected: RoleModelDecisionResult;
}): boolean {
  if (options.actual.status !== options.expected.status) {
    return false;
  }

  if (options.actual.status === 'accepted') {
    return (
      options.expected.status === 'accepted' &&
      options.actual.nonCommittedText === options.expected.nonCommittedText &&
      canonicalJsonValuesEqual(
        options.actual.decision,
        options.expected.decision
      )
    );
  }

  return (
    options.expected.status === 'rejected' &&
    options.actual.rejection.reason === options.expected.rejection.reason &&
    options.actual.rejection.details === options.expected.rejection.details &&
    isDeepEqualStringArray(
      options.actual.requestedToolNames,
      options.expected.requestedToolNames
    )
  );
}

function isDeepEqualStringArray(
  actual: readonly string[] | undefined,
  expected: readonly string[] | undefined
): boolean {
  return (
    actual === expected ||
    (actual !== undefined &&
      expected !== undefined &&
      actual.length === expected.length &&
      actual.every((item, index) => item === expected[index]))
  );
}

function isRoleModelMalformedAdapterRawOutputEvidence(options: {
  readonly rawOutputText: string;
  readonly decisionResult: RoleModelDecisionResult;
}): boolean {
  return (
    options.rawOutputText.length === 0 &&
    options.decisionResult.status === 'rejected' &&
    options.decisionResult.rejection.reason ===
      roleModelMalformedOutputRejectionReason &&
    isRoleModelMalformedAdapterRawOutputDetails(
      options.decisionResult.rejection.details
    )
  );
}

export function getRequiredVisibleReplyText(
  decision: CharacterDecision
): string {
  const visibleReply = getVisibleReplyToolCall(decision);

  if (visibleReply === undefined) {
    throw new TypeError('CharacterDecision must include visible_reply.');
  }

  return visibleReply.input.text;
}

export function getVisibleReplyToolCall(
  decision: CharacterDecision
): VisibleReplyModelToolCall | undefined {
  return findVisibleReplyModelToolCall(decision.toolCalls);
}

function parseRoleModelDecisionObject(
  parsedOutput: unknown,
  allowedTools: readonly RoleModelAllowedToolName[],
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
  toolObservations: readonly RoleModelToolObservation[],
  boundary: RoleModelDecisionBoundary
): RoleModelDecisionResult {
  const frozenPluginToolDefinitions = createRoleModelPluginToolDefinitions(
    pluginToolDefinitions
  );
  const modelToolDefinitions = modelToolDefinitionsForPluginToolDefinitions(
    frozenPluginToolDefinitions
  );
  const frozenAllowedTools = freezeAllowedTools(
    allowedTools,
    modelToolDefinitions
  );
  const allowedModelToolDefinitions = toolDefinitionsForAllowedTools({
    allowedTools: frozenAllowedTools,
    toolDefinitions: modelToolDefinitions
  });

  if (!isJsonRecord(parsedOutput)) {
    return createMalformedOutputResult(
      'Adapter output must be a CharacterDecision JSON object.'
    );
  }

  if (hasEffectShape(parsedOutput)) {
    return createUnsupportedOutputResult(
      'Decision includes unsupported effect fields.'
    );
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, [
    'version',
    'toolCalls',
    'text'
  ]);

  if (unsupportedTopLevelKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision includes unsupported fields: ${unsupportedTopLevelKeys.join(', ')}.`
    );
  }

  const rawToolCalls = parsedOutput['toolCalls'];

  if (!Array.isArray(rawToolCalls)) {
    return createMalformedOutputResult('Decision toolCalls must be an array.');
  }

  const toolCalls: ModelToolCall[] = [];

  for (const [index, rawToolCall] of rawToolCalls.entries()) {
    const parsedToolCall = parseModelToolCall({
      index,
      rawToolCall,
      boundary
    });

    if (parsedToolCall.status === 'rejected') {
      return parsedToolCall.result;
    }

    toolCalls.push(parsedToolCall.toolCall);
  }

  const availabilityResult = validateToolCallAvailability({
    toolCalls,
    allowedTools: frozenAllowedTools
  });

  if (availabilityResult !== undefined) {
    return availabilityResult;
  }

  const cardinalityResult = validateUserTurnToolCallCardinality(
    toolCalls,
    allowedModelToolDefinitions,
    toolObservations
  );

  if (cardinalityResult !== undefined) {
    return cardinalityResult;
  }

  const topLevelText = parsedOutput['text'];

  if (topLevelText !== undefined && typeof topLevelText !== 'string') {
    return createMalformedOutputResult('Decision text must be a string.');
  }

  if (
    topLevelText !== undefined &&
    toolCalls.length === 0 &&
    topLevelText.trim().length === 0
  ) {
    return createMalformedOutputResult(
      roleModelTerminalEmptyOutputRejectionDetails
    );
  }

  if (topLevelText !== undefined && toolCalls.length > 0) {
    return createMalformedOutputResult(
      'Decision text is only allowed when toolCalls is empty.'
    );
  }

  return boundary === 'execution'
    ? createExecutionRoleModelDecisionResult(toolCalls, topLevelText)
    : createAcceptedRoleModelDecisionResult(createCharacterDecision(toolCalls), {
        ...(topLevelText === undefined ? {} : { nonCommittedText: topLevelText })
      });
}

type ParsedToolCallResult =
  | {
      readonly status: 'accepted';
      readonly toolCall: ModelToolCall;
    }
  | {
      readonly status: 'rejected';
      readonly result: RejectedRoleModelDecisionResult;
    };

function parseModelToolCall(options: {
  readonly boundary: RoleModelDecisionBoundary;
  readonly index: number;
  readonly rawToolCall: unknown;
}): ParsedToolCallResult {
  if (!isJsonRecord(options.rawToolCall)) {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}] must be an object.`
    );
  }

  const unsupportedToolCallKeys = findUnsupportedKeys(options.rawToolCall, [
    'name',
    'input'
  ]);

  if (unsupportedToolCallKeys.length > 0) {
    return {
      status: 'rejected',
      result: createUnsupportedOutputResult(
        `Decision toolCalls[${String(
          options.index
        )}] includes unsupported fields: ${unsupportedToolCallKeys.join(', ')}.`
      )
    };
  }

  const name = options.rawToolCall['name'];

  if (typeof name !== 'string') {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}].name must be a string.`
    );
  }

  if (!isRoleModelToolNameSyntax(name)) {
    return rejectToolCall(
      `Decision toolCalls[${String(
        options.index
      )}].name must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`
    );
  }

  const input = options.rawToolCall['input'];

  if (!isJsonRecord(input)) {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}].input must be an object.`
    );
  }

  if (name === visibleReplyModelToolName) {
    return parseVisibleReplyToolCallInput(
      input,
      options.index,
      options.boundary
    );
  }

  const jsonInputValidation = validateModelToolInputAgainstContract({
    toolName: name,
    input,
    inputContract: {
      type: 'object',
      fields: [],
      additionalFields: true
    }
  });

  if (jsonInputValidation.status === 'rejected') {
    return rejectToolCall(jsonInputValidation.details);
  }

  return {
    status: 'accepted',
    toolCall:
      options.boundary === 'execution'
        ? freezeExecutionModelToolCall({
            name,
            input: jsonInputValidation.input
          })
        : freezeModelToolCall({
            name,
            input: jsonInputValidation.input
          })
  };
}

function parseVisibleReplyToolCallInput(
  input: Readonly<Record<string, unknown>>,
  index: number,
  boundary: RoleModelDecisionBoundary
): ParsedToolCallResult {
  const text = input['text'];

  if (typeof text !== 'string') {
    return rejectToolCall(
      `Decision toolCalls[${String(index)}].input.text must be a string.`
    );
  }

  const unsupportedInputKeys = findUnsupportedKeys(input, ['text']);

  if (unsupportedInputKeys.length > 0) {
    return {
      status: 'rejected',
      result: createRejectedRoleModelDecisionResult(
        roleModelUnsupportedEffectRejectionReason,
        `visible_reply input includes unsupported fields: ${unsupportedInputKeys.join(
          ', '
        )}.`
      )
    };
  }

  const scrubbedText = scrubReasoningBlocks(text);

  if (scrubbedText.status === 'rejected') {
    return rejectToolCall(
      'visible_reply text contains an unterminated reasoning block.'
    );
  }

  return {
    status: 'accepted',
    toolCall:
      boundary === 'execution'
        ? createExecutionVisibleReplyModelToolCall(scrubbedText.text)
        : createVisibleReplyModelToolCall(scrubbedText.text)
  };
}

function createExecutionRoleModelDecisionResult(
  toolCalls: readonly ModelToolCall[],
  nonCommittedText: string | undefined
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: Object.freeze({
      version: roleModelDecisionContractVersion,
      toolCalls: Object.freeze(toolCalls.map(freezeExecutionModelToolCall))
    } satisfies CharacterDecision),
    ...(nonCommittedText === undefined ? {} : { nonCommittedText })
  } satisfies AcceptedRoleModelDecisionResult);
}

function createExecutionVisibleReplyModelToolCall(
  text: string
): VisibleReplyModelToolCall {
  return Object.freeze({
    name: visibleReplyModelToolName,
    input: Object.freeze({ text })
  } satisfies VisibleReplyModelToolCall);
}

function freezeExecutionModelToolCall(call: ModelToolCall): ModelToolCall {
  if (call.name === visibleReplyModelToolName) {
    const text = call.input['text'];

    return createExecutionVisibleReplyModelToolCall(
      typeof text === 'string' ? text : ''
    );
  }

  return Object.freeze({
    name: call.name,
    input: createJsonBoundaryObjectSnapshot(call.input, {
      field: `Model tool "${call.name}" execution input`
    })
  } satisfies ModelToolCall);
}

function rejectToolCall(details: string): ParsedToolCallResult {
  return {
    status: 'rejected',
    result: createRejectedRoleModelDecisionResult(
      roleModelMalformedToolCallRejectionReason,
      details
    )
  };
}

function validateToolCallAvailability(options: {
  readonly toolCalls: readonly ModelToolCall[];
  readonly allowedTools: readonly RoleModelAllowedToolName[];
}): RejectedRoleModelDecisionResult | undefined {
  const disallowedToolCall = options.toolCalls.find(
    (call) => !options.allowedTools.includes(call.name)
  );

  if (disallowedToolCall !== undefined) {
    return createRejectedRoleModelDecisionResult(
      roleModelDisallowedToolRejectionReason,
      `Decision requested disallowed tool ${disallowedToolCall.name}.`,
      {
        requestedToolNames: options.toolCalls.map((call) => call.name)
      }
    );
  }

  return undefined;
}

function validateUserTurnToolCallCardinality(
  toolCalls: readonly ModelToolCall[],
  modelToolDefinitions: readonly RoleModelToolDefinition[],
  toolObservations: readonly RoleModelToolObservation[]
): RejectedRoleModelDecisionResult | undefined {
  const isTerminalDecision = toolCalls.every(
    (call) => call.name === visibleReplyModelToolName
  );
  const visibleReplyCount = toolCalls.filter(
    (call) => call.name === visibleReplyModelToolName
  ).length;
  if (visibleReplyCount > 1) {
    return createRejectedRoleModelDecisionResult(
      roleModelDuplicateToolCallRejectionReason,
      'Decision must not include duplicate visible_reply tool calls.',
      {
        requestedToolNames: toolCalls.map((call) => call.name)
      }
    );
  }

  for (const definition of modelToolDefinitions) {
    const currentDecisionCount = toolCalls.filter(
      (call) => call.name === definition.name
    ).length;
    const previousTurnAttemptCount =
      definition.callLimit.scope === 'user_turn'
        ? toolObservations.filter(
            (observation) => observation.toolName === definition.name
          ).length
        : 0;
    const count = previousTurnAttemptCount + currentDecisionCount;
    const successfulRequiredCallCount = toolObservations.filter(
      (observation) =>
        observation.toolName === definition.name &&
        observation.result.status === 'accepted'
    ).length;

    if (
      isTerminalDecision &&
      definition.requiredForUserTurn &&
      successfulRequiredCallCount === 0
    ) {
      return createRejectedRoleModelDecisionResult(
        roleModelMissingRequiredToolCallRejectionReason,
        `Decision must include required ${definition.name} tool call.`,
        {
          requestedToolNames: toolCalls.map((call) => call.name)
        }
      );
    }

    if (count > definition.callLimit.maxCalls) {
      return createRejectedRoleModelDecisionResult(
        roleModelDuplicateToolCallRejectionReason,
        `Decision requested ${definition.name} ${String(
          count
        )} times; ${definition.callLimit.scope} maxCalls is ${String(
          definition.callLimit.maxCalls
        )}.`,
        {
          requestedToolNames: toolCalls.map((call) => call.name)
        }
      );
    }
  }

  return undefined;
}

function createMalformedOutputResult(
  details: string
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelMalformedOutputRejectionReason,
    details
  );
}

function createUnsupportedOutputResult(
  details: string
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelUnsupportedEffectRejectionReason,
    details
  );
}

function freezeRuntimeEventIdentitySnapshot(
  identity: RuntimeEventIdentity
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: assertCanonicalRuntimeTimestamp(
      identity.createdAt,
      'Role-model evidence createdAt'
    )
  } satisfies RuntimeEventIdentity);
}

function freezeUserMessageRuntimeEventSnapshot(
  event: UserMessageRuntimeEvent
): UserMessageRuntimeEvent {
  const identity = freezeRuntimeEventIdentitySnapshot(event);

  return Object.freeze({
    ...identity,
    type: event.type,
    payload: Object.freeze({
      currentUserMessage: event.payload.currentUserMessage
    })
  } satisfies UserMessageRuntimeEvent);
}

function freezeCharacterProfileSnapshot(
  character: CharacterProfile
): CharacterProfile {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName
  } satisfies CharacterProfile);
}

function freezeVisibleMessageSnapshots(
  visibleMessages: readonly VisibleMessage[]
): readonly VisibleMessage[] {
  return Object.freeze(visibleMessages.map(freezeVisibleMessageSnapshot));
}

function freezeVisibleMessageSnapshot(message: VisibleMessage): VisibleMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    speakerId: message.speakerId,
    speakerName: message.speakerName,
    text: message.text
  } satisfies VisibleMessage);
}

function freezePluginContextItems(
  contextItems: readonly RuntimePluginContextItem[]
): readonly RuntimePluginContextItem[] {
  return Object.freeze(contextItems.map(createRuntimePluginContextItem));
}

export function createDefaultRoleModelPluginToolDefinitions(): readonly RoleModelPluginToolDefinition[] {
  return Object.freeze(
    firstPartyModelToolsProvidedTools.map((tool) =>
      Object.freeze({
        pluginId: firstPartyModelToolsPluginId,
        ...tool
      } satisfies RoleModelPluginToolDefinition)
    )
  );
}

export function createRoleModelPluginToolDefinitions(
  definitions: readonly RoleModelPluginToolDefinition[]
): readonly RoleModelPluginToolDefinition[] {
  const frozenDefinitions: RoleModelPluginToolDefinition[] = [];
  const seenNames = new Set<string>();

  for (const definition of definitions) {
    const pluginId = requiredRoleModelIdentifier(
      definition.pluginId,
      'pluginId'
    );
    const providedTool = createRuntimePluginProvidedTool(definition);

    if (seenNames.has(providedTool.name)) {
      throw new TypeError(
        `Plugin tool "${providedTool.name}" is declared more than once.`
      );
    }

    assertRoleModelPluginToolPolicy(pluginId, providedTool);

    seenNames.add(providedTool.name);
    frozenDefinitions.push(
      Object.freeze({
        pluginId,
        ...providedTool
      } satisfies RoleModelPluginToolDefinition)
    );
  }

  return Object.freeze(frozenDefinitions);
}

function assertRoleModelPluginToolPolicy(
  pluginId: string,
  providedTool: RuntimePluginProvidedTool
): void {
  if (isBuiltInModelToolName(providedTool.name)) {
    assertBuiltInRoleModelToolPolicy(pluginId, providedTool);
    return;
  }

  assertHostRoleModelToolPolicy(providedTool);
}

function assertBuiltInRoleModelToolPolicy(
  pluginId: string,
  providedTool: RuntimePluginProvidedTool
): void {
  if (
    pluginId !== firstPartyModelToolsPluginId ||
    providedTool.validationOwner !== 'built_in_model_tools' ||
    providedTool.sideEffectLevel !== 'none' ||
    providedTool.requiresConfirmation ||
    providedTool.callLimit.scope !== 'model_response' ||
    providedTool.callLimit.maxCalls !== 1
  ) {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" must be provided by ${firstPartyModelToolsPluginId}.`
    );
  }
}

function assertHostRoleModelToolPolicy(
  providedTool: RuntimePluginProvidedTool
): void {
  if (providedTool.validationOwner !== 'plugin_host') {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" must be validated by plugin_host.`
    );
  }

  if (providedTool.callLimit.scope !== 'user_turn') {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" must use a user_turn call limit.`
    );
  }

  const approvalGatedRuntimeConfigWrite =
    isApprovalGatedRuntimePluginTool(providedTool);

  if (
    providedTool.requiresConfirmation &&
    !approvalGatedRuntimeConfigWrite
  ) {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" requires confirmation and cannot be model-facing in CT-03.`
    );
  }

  if (
    providedTool.sideEffectLevel !== 'none' &&
    providedTool.sideEffectLevel !== 'runtime_read' &&
    providedTool.sideEffectLevel !== 'local_memory_write' &&
    !approvalGatedRuntimeConfigWrite
  ) {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" must be read-only or local-memory-only for CT-03.`
    );
  }
}

function modelToolDefinitionsForPluginToolDefinitions(
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[]
): readonly RoleModelToolDefinition[] {
  return Object.freeze(
    pluginToolDefinitions.map((definition) =>
      freezeModelToolDefinition(definition)
    )
  );
}

function defaultAllowedToolsForPluginDefinitions(
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[]
): readonly RoleModelAllowedToolName[] {
  return Object.freeze(
    pluginToolDefinitions.map((definition) => definition.name)
  );
}

function toolDefinitionsForAllowedTools(options: {
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly toolDefinitions: readonly RoleModelToolDefinition[];
}): readonly RoleModelToolDefinition[] {
  return Object.freeze(
    options.toolDefinitions
      .filter((definition) => options.allowedTools.includes(definition.name))
      .map(freezeModelToolDefinition)
  );
}

function requiredRoleModelIdentifier(value: string, field: string): string {
  if (!isRoleModelToolNameSyntax(value)) {
    throw new TypeError(
      `Role-model ${field} must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`
    );
  }

  return value;
}

function isRoleModelToolNameSyntax(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function freezeAllowedTools(
  allowedTools: readonly unknown[],
  modelToolDefinitions: readonly RoleModelToolDefinition[]
): readonly RoleModelAllowedToolName[] {
  if (hasDuplicateRoleModelAllowedTools(allowedTools)) {
    throw new TypeError(
      'Role-model allowedTools must not contain duplicates.'
    );
  }

  const validatedTools: RoleModelAllowedToolName[] = [];
  const supportedToolNames = new Set(
    modelToolDefinitions.map((definition) => definition.name)
  );

  for (const tool of allowedTools) {
    if (
      typeof tool !== 'string' ||
      !isRoleModelToolNameSyntax(tool) ||
      !supportedToolNames.has(tool)
    ) {
      throw new TypeError(
        'Role-model allowedTools must contain only supported tools.'
      );
    }

    validatedTools.push(tool);
  }

  return Object.freeze(validatedTools);
}

function freezeRoleModelOutputContract(
  outputContract: RoleModelOutputContract
): RoleModelOutputContract {
  return Object.freeze({
    version: outputContract.version,
    text: outputContract.text
  } satisfies RoleModelOutputContract);
}

function freezeRoleModelToolObservations(
  observations: readonly RoleModelToolObservation[]
): readonly RoleModelToolObservation[] {
  return Object.freeze(observations.map(freezeRoleModelToolObservation));
}

function freezeRoleModelToolObservation(
  observation: RoleModelToolObservation
): RoleModelToolObservation {
  if (!Number.isInteger(observation.round) || observation.round < 1) {
    throw new TypeError('Role-model tool observation round must be a positive integer.');
  }

  return Object.freeze({
    round: observation.round,
    pluginId: requiredRoleModelIdentifier(
      observation.pluginId,
      'tool observation pluginId'
    ),
    toolName: requiredRoleModelIdentifier(
      observation.toolName,
      'tool observation toolName'
    ),
    input: createJsonBoundaryObjectSnapshot(observation.input, {
      field: 'Role-model tool observation input',
      redact: true
    }),
    result: freezeRoleModelToolObservationResult(observation.result)
  } satisfies RoleModelToolObservation);
}

function freezeRoleModelToolObservationResult(
  result: RoleModelToolObservationResult
): RoleModelToolObservationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: createJsonBoundarySnapshot(result.output, {
        field: 'Role-model tool observation output',
        redact: true
      })
    } satisfies RoleModelToolObservationResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: redactRuntimePluginText(result.reason),
    message: redactRuntimePluginText(result.message)
  } satisfies RoleModelToolObservationResult);
}

function freezeRuntimePluginJsonObject(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, RuntimePluginJsonValue>> {
  const snapshot: Record<string, RuntimePluginJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    snapshot[key] = freezeRuntimePluginJsonValue(item);
  }

  return Object.freeze(snapshot);
}

function freezeRuntimePluginJsonValue(
  value: unknown
): RuntimePluginJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeRuntimePluginJsonValue));
  }

  if (isJsonRecord(value)) {
    return freezeRuntimePluginJsonObject(value);
  }

  throw new TypeError('Role-model tool observation values must be JSON-compatible.');
}

export function parseRoleModelProviderExchangeSnapshot(
  value: unknown
): RoleModelProviderExchangeSnapshot | undefined {
  if (!isRoleModelProviderExchangeSnapshot(value)) {
    return undefined;
  }

  return freezeRoleModelProviderExchangeSnapshot(value);
}

function freezeRoleModelProviderExchangeSnapshot(
  snapshot: RoleModelProviderExchangeSnapshot
): RoleModelProviderExchangeSnapshot {
  const boundedSnapshot = createJsonBoundarySnapshot(snapshot, {
    field: 'Role-model provider exchange',
    redact: true
  });

  if (!isRoleModelProviderExchangeSnapshot(boundedSnapshot)) {
    throw new TypeError('Role-model provider exchange is malformed.');
  }

  snapshot = boundedSnapshot;

  return Object.freeze({
    provider: Object.freeze({
      name: snapshot.provider.name,
      ...(snapshot.provider.model === undefined
        ? {}
        : { model: snapshot.provider.model }),
      ...(snapshot.provider.endpoint === undefined
        ? {}
        : { endpoint: snapshot.provider.endpoint })
    }),
    capabilities: Object.freeze({ ...snapshot.capabilities }),
    reasoning: Object.freeze({
      mode: snapshot.reasoning.mode,
      params: freezeRuntimePluginJsonValue(snapshot.reasoning.params)
    }),
    renderedMessages: Object.freeze(
      snapshot.renderedMessages.map(freezeProviderExchangeChatMessage)
    ),
    renderedTools: Object.freeze(
      snapshot.renderedTools.map(freezeProviderExchangeTool)
    ),
    toolNameMappings: Object.freeze(
      snapshot.toolNameMappings.map((mapping) =>
        Object.freeze({
          runtimeName: mapping.runtimeName,
          providerName: mapping.providerName
        } satisfies RoleModelProviderToolNameMapping)
      )
    ),
    ...(snapshot.toolChoice === undefined
      ? {}
      : { toolChoice: freezeRuntimePluginJsonValue(snapshot.toolChoice) }),
    ...(snapshot.parallelToolCalls === undefined
      ? {}
      : { parallelToolCalls: snapshot.parallelToolCalls }),
    requestBody: freezeRuntimePluginJsonValue(snapshot.requestBody),
    ...(snapshot.rawFinishReason === undefined
      ? {}
      : {
          rawFinishReason: freezeRuntimePluginJsonValue(
            snapshot.rawFinishReason
          )
        }),
    ...(snapshot.finishReason === undefined
      ? {}
      : { finishReason: snapshot.finishReason }),
    ...(snapshot.usage === undefined
      ? {}
      : { usage: freezeRuntimePluginJsonValue(snapshot.usage) }),
    ...(snapshot.nativeAssistantMessage === undefined
      ? {}
      : {
          nativeAssistantMessage: freezeProviderExchangeChatMessage(
            snapshot.nativeAssistantMessage
          )
        }),
    nativeToolResultMessages: Object.freeze(
      snapshot.nativeToolResultMessages.map(freezeProviderExchangeChatMessage)
    ),
    ...(snapshot.responseBody === undefined
      ? {}
      : { responseBody: freezeRuntimePluginJsonValue(snapshot.responseBody) }),
    ...(snapshot.outputNormalization === undefined
      ? {}
      : {
          outputNormalization: Object.freeze({
            source: snapshot.outputNormalization.source,
            committed: false
          })
        })
  } satisfies RoleModelProviderExchangeSnapshot);
}

function isRoleModelProviderExchangeSnapshot(
  value: unknown
): value is RoleModelProviderExchangeSnapshot {
  if (!isJsonRecord(value)) {
    return false;
  }

  return (
    isRequiredRoleModelProviderExchangeSnapshot(value) &&
    isOptionalRoleModelProviderExchangeSnapshot(value)
  );
}

function isRequiredRoleModelProviderExchangeSnapshot(
  value: Readonly<Record<string, unknown>>
): boolean {
  const renderedMessages = value['renderedMessages'];
  const renderedTools = value['renderedTools'];
  const toolNameMappings = value['toolNameMappings'];
  const nativeToolResultMessages = value['nativeToolResultMessages'];

  return (
    isRoleModelProviderExchangeProvider(value['provider']) &&
    isRoleModelProviderCapabilities(value['capabilities']) &&
    isRoleModelProviderExchangeReasoning(value['reasoning']) &&
    Array.isArray(renderedMessages) &&
    renderedMessages.every(isRoleModelProviderExchangeChatMessage) &&
    Array.isArray(renderedTools) &&
    renderedTools.every(isRoleModelProviderExchangeTool) &&
    Array.isArray(toolNameMappings) &&
    toolNameMappings.every(isRoleModelProviderToolNameMapping) &&
    isRuntimePluginJsonValue(value['requestBody']) &&
    Array.isArray(nativeToolResultMessages) &&
    nativeToolResultMessages.every(isRoleModelProviderExchangeChatMessage)
  );
}

function isOptionalRoleModelProviderExchangeSnapshot(
  value: Readonly<Record<string, unknown>>
): boolean {
  return (
    isOptionalRuntimePluginJsonValue(value['toolChoice']) &&
    (value['parallelToolCalls'] === undefined ||
      typeof value['parallelToolCalls'] === 'boolean') &&
    isOptionalRuntimePluginJsonValue(value['rawFinishReason']) &&
    isOptionalString(value['finishReason']) &&
    isOptionalRuntimePluginJsonValue(value['usage']) &&
    (value['nativeAssistantMessage'] === undefined ||
      isRoleModelProviderExchangeChatMessage(
        value['nativeAssistantMessage']
      )) &&
    isOptionalRuntimePluginJsonValue(value['responseBody']) &&
    (value['outputNormalization'] === undefined ||
      isRoleModelProviderExchangeOutputNormalization(
        value['outputNormalization']
      ))
  );
}

function isRoleModelProviderExchangeProvider(value: unknown): boolean {
  if (!isJsonRecord(value)) {
    return false;
  }

  return (
    (value['name'] === 'local' || value['name'] === 'nvidia') &&
    isOptionalString(value['model']) &&
    isOptionalString(value['endpoint'])
  );
}

function isRoleModelProviderCapabilities(value: unknown): boolean {
  if (!isJsonRecord(value)) {
    return false;
  }

  return (
    typeof value['supportsNativeTools'] === 'boolean' &&
    typeof value['supportsDeveloperOrSystemContext'] === 'boolean' &&
    (value['preferredModelContextRole'] === 'developer' ||
      value['preferredModelContextRole'] === 'system') &&
    typeof value['supportsStrictToolSchema'] === 'boolean' &&
    typeof value['supportsReasoning'] === 'boolean' &&
    (value['reasoningParameterStyle'] === 'none' ||
      value['reasoningParameterStyle'] === 'nvidia') &&
    typeof value['requiresReasoningBlockRoundTrip'] === 'boolean' &&
    typeof value['supportsToolChoice'] === 'boolean' &&
    typeof value['supportsParallelToolCalls'] === 'boolean'
  );
}

function isRoleModelProviderExchangeReasoning(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    (value['mode'] === 'none' || value['mode'] === 'enabled') &&
    isRuntimePluginJsonValue(value['params'])
  );
}

function isRoleModelProviderExchangeChatMessage(
  value: unknown
): value is RoleModelChatMessage {
  if (!isJsonRecord(value)) {
    return false;
  }

  if (
    value['role'] === 'system' ||
    value['role'] === 'developer' ||
    value['role'] === 'user'
  ) {
    return typeof value['content'] === 'string';
  }

  if (value['role'] === 'assistant') {
    return (
      (typeof value['content'] === 'string' || value['content'] === null) &&
      (value['tool_calls'] === undefined ||
        (Array.isArray(value['tool_calls']) &&
          value['tool_calls'].every(isRoleModelProviderExchangeChatToolCall)))
    );
  }

  return (
    value['role'] === 'tool' &&
    typeof value['content'] === 'string' &&
    typeof value['tool_call_id'] === 'string'
  );
}

function isRoleModelProviderExchangeChatToolCall(value: unknown): boolean {
  if (!isJsonRecord(value) || value['type'] !== 'function') {
    return false;
  }

  const functionCall = value['function'];

  return (
    typeof value['id'] === 'string' &&
    isJsonRecord(functionCall) &&
    typeof functionCall['name'] === 'string' &&
    typeof functionCall['arguments'] === 'string'
  );
}

function isRoleModelProviderExchangeTool(
  value: unknown
): value is RoleModelChatCompletionTool {
  if (!isJsonRecord(value) || value['type'] !== 'function') {
    return false;
  }

  const toolFunction = value['function'];

  return (
    isJsonRecord(toolFunction) &&
    typeof toolFunction['name'] === 'string' &&
    typeof toolFunction['description'] === 'string' &&
    isRoleModelObjectJsonSchema(toolFunction['parameters']) &&
    (toolFunction['strict'] === undefined || toolFunction['strict'] === true)
  );
}

function isRoleModelObjectJsonSchema(value: unknown): boolean {
  return (
    isRoleModelJsonSchema(value) &&
    value['type'] === 'object' &&
    isJsonRecord(value['properties']) &&
    isStringArray(value['required']) &&
    typeof value['additionalProperties'] === 'boolean'
  );
}

function isRoleModelJsonSchema(value: unknown, depth = 0): value is Readonly<Record<string, unknown>> {
  if (!isJsonRecord(value) || depth > 64) {
    return false;
  }

  const type = value['type'];
  const properties = value['properties'];
  const required = value['required'];

  return (
    isRoleModelJsonSchemaTypeDeclaration(type) &&
    isOptionalString(value['description']) &&
    (value['enum'] === undefined || isStringArray(value['enum'])) &&
    isRoleModelJsonSchemaProperties(properties, depth) &&
    areRoleModelJsonSchemaRequiredNamesValid(properties, required) &&
    (value['additionalProperties'] === undefined ||
      typeof value['additionalProperties'] === 'boolean') &&
    isOptionalRoleModelJsonSchema(value['items'], depth)
  );
}

function isRoleModelJsonSchemaTypeDeclaration(value: unknown): boolean {
  return (
    value === undefined ||
    isModelToolJsonSchemaType(value) ||
    (Array.isArray(value) && value.every(isModelToolJsonSchemaType))
  );
}

function isRoleModelJsonSchemaProperties(
  value: unknown,
  depth: number
): boolean {
  return (
    value === undefined ||
    (isJsonRecord(value) &&
      Object.values(value).every((property) =>
        isRoleModelJsonSchema(property, depth + 1)
      ))
  );
}

function areRoleModelJsonSchemaRequiredNamesValid(
  properties: unknown,
  required: unknown
): boolean {
  return (
    required === undefined ||
    (isStringArray(required) &&
      new Set(required).size === required.length &&
      required.every(
        (name) => isJsonRecord(properties) && Object.hasOwn(properties, name)
      ))
  );
}

function isOptionalRoleModelJsonSchema(
  value: unknown,
  depth: number
): boolean {
  return value === undefined || isRoleModelJsonSchema(value, depth + 1);
}

function isRoleModelProviderToolNameMapping(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    typeof value['runtimeName'] === 'string' &&
    typeof value['providerName'] === 'string'
  );
}

function isRoleModelProviderExchangeOutputNormalization(
  value: unknown
): boolean {
  return (
    isJsonRecord(value) &&
    (value['source'] === 'terminal_assistant_content' ||
      value['source'] === 'native_tool_calls') &&
    value['committed'] === false
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalRuntimePluginJsonValue(value: unknown): boolean {
  return value === undefined || isRuntimePluginJsonValue(value);
}

function isRuntimePluginJsonValue(value: unknown, depth = 0): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (depth > 64) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isRuntimePluginJsonValue(item, depth + 1));
  }

  return (
    isJsonRecord(value) &&
    Object.values(value).every((item) =>
      isRuntimePluginJsonValue(item, depth + 1)
    )
  );
}

function freezeProviderExchangeChatMessage(
  message: RoleModelChatMessage
): RoleModelChatMessage {
  if (message.role === 'assistant') {
    return Object.freeze({
      role: 'assistant',
      content: message.content,
      ...(message.tool_calls === undefined
        ? {}
        : {
            tool_calls: Object.freeze(
              message.tool_calls.map((toolCall) =>
                Object.freeze({
                  id: toolCall.id,
                  type: 'function',
                  function: Object.freeze({
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments
                  })
                })
              )
            )
          })
    } satisfies RoleModelChatMessage);
  }

  if (message.role === 'tool') {
    return Object.freeze({
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id
    } satisfies RoleModelChatMessage);
  }

  return Object.freeze({
    role: message.role,
    content: message.content
  } satisfies RoleModelChatMessage);
}

function freezeProviderExchangeTool(
  tool: RoleModelChatCompletionTool
): RoleModelChatCompletionTool {
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: tool.function.name,
      description: tool.function.description,
      parameters: freezeRuntimePluginJsonValue(
        tool.function.parameters
      ) as RoleModelChatCompletionTool['function']['parameters'],
      ...(tool.function.strict === undefined ? {} : { strict: true })
    })
  } satisfies RoleModelChatCompletionTool);
}

function freezeProviderMetadata(
  metadata: RoleModelProviderMetadata
): RoleModelProviderMetadata {
  const messageCount =
    metadata.request?.messageCount === undefined
      ? undefined
      : finiteProviderMetadataNumber(
          metadata.request.messageCount,
          'providerMetadata.request.messageCount'
        );
  const status =
    metadata.response?.status === undefined
      ? undefined
      : finiteProviderMetadataNumber(
          metadata.response.status,
          'providerMetadata.response.status'
        );

  return Object.freeze({
    provider: metadata.provider,
    ...(metadata.model === undefined
      ? {}
      : { model: redactRuntimePluginText(metadata.model) }),
    ...(metadata.request === undefined
      ? {}
      : {
          request: Object.freeze({
            ...(metadata.request.endpoint === undefined
              ? {}
              : { endpoint: redactRuntimePluginText(metadata.request.endpoint) }),
            ...(messageCount === undefined ? {} : { messageCount }),
            stream: false
          })
        }),
    ...(metadata.response === undefined
      ? {}
      : {
          response: Object.freeze({
            ...(status === undefined ? {} : { status })
          })
        }),
    ...(metadata.error === undefined
      ? {}
      : {
          error: Object.freeze({
            code: redactRuntimePluginText(metadata.error.code),
            message: redactRuntimePluginText(metadata.error.message)
          })
        })
  } satisfies RoleModelProviderMetadata);
}

function finiteProviderMetadataNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite JSON.`);
  }

  return value;
}

function freezeCharacterDecision(decision: CharacterDecision): CharacterDecision {
  return Object.freeze({
    version: roleModelDecisionContractVersion,
    toolCalls: freezeModelToolCalls(decision.toolCalls)
  } satisfies CharacterDecision);
}

function freezeRoleModelDecisionRejection(
  rejection: RoleModelDecisionRejection
): RoleModelDecisionRejection {
  return Object.freeze({
    reason: rejection.reason,
    ...(rejection.details === undefined
      ? {}
      : { details: redactRuntimePluginText(rejection.details) })
  } satisfies RoleModelDecisionRejection);
}

function freezeRoleModelDecisionResult(
  result: RoleModelDecisionResult
): RoleModelDecisionResult {
  if (result.status === 'accepted') {
    return createAcceptedRoleModelDecisionResult(result.decision, {
      ...(result.nonCommittedText === undefined
        ? {}
        : { nonCommittedText: result.nonCommittedText })
    });
  }

  return createRejectedRoleModelDecisionResult(
    result.rejection.reason,
    result.rejection.details,
    {
      ...(result.requestedToolNames === undefined
        ? {}
        : { requestedToolNames: result.requestedToolNames })
    }
  );
}

function isJsonRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasEffectShape(record: Readonly<Record<string, unknown>>): boolean {
  return record['effect'] !== undefined || record['effects'] !== undefined;
}

function findUnsupportedKeys(
  record: Readonly<Record<string, unknown>>,
  supportedKeys: readonly string[]
): readonly string[] {
  return Object.keys(record).filter((key) => !supportedKeys.includes(key));
}

export { freezeBuiltInModelToolCall };
export type {
  BuiltInModelToolCall,
  BuiltInModelToolName,
  VisibleReplyModelToolCall
};
