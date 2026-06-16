import type { CharacterProfile, VisibleMessage } from '../core/conversation.ts';
import {
  createRuntimePluginContextItem,
  createRuntimePluginProvidedTool,
  type RuntimePluginContextItem,
  type RuntimePluginJsonValue,
  type RuntimePluginProvidedTool
} from '../plugins/types.ts';
import {
  builtInModelToolDefinitionsForUserTurn,
  characterStatePatchModelToolName,
  createCharacterStatePatchModelToolCall,
  createVisibleReplyModelToolCall,
  findCharacterStatePatchModelToolCall,
  findVisibleReplyModelToolCall,
  freezeBuiltInModelToolCall,
  freezeModelToolCall,
  freezeModelToolCalls,
  freezeModelToolDefinition,
  validateModelToolInputAgainstContract,
  isBuiltInModelToolName,
  userTurnBuiltInModelToolNames,
  visibleReplyModelToolName,
  type BuiltInModelToolCall,
  type BuiltInModelToolName,
  type CharacterStatePatchModelToolCall,
  type ModelToolCall,
  type ModelToolDefinition,
  type VisibleReplyModelToolCall
} from './model-tools.ts';
import type {
  RuntimeEventIdentity,
  UserMessageRuntimeEvent
} from '../runtime/event.ts';

export const roleModelDecisionContractVersion = 'mvp-006.tool_calls.v1';
export const roleModelCharacterStatePatchToolName =
  characterStatePatchModelToolName;
export const roleModelPluginListToolName = 'plugin.list';

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
  readonly pluginToolDefinitions?: readonly RoleModelPluginToolDefinition[];
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
export const roleModelAdapterRejectionNotReplayableDetails =
  'Adapter rejection must be replayable from rawOutputText.';
export const roleModelTerminalEmptyOutputRejectionDetails =
  'Terminal model output must include visible_reply or top-level text.';

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
};

export type CreateRoleModelIOSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
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
    options.pluginToolDefinitions ?? []
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
      : { nonCommittedText: options.nonCommittedText })
  } satisfies AcceptedRoleModelDecisionResult);
}

export function createRejectedRoleModelDecisionResult(
  reason: RoleModelDecisionRejectionReason,
  details?: string
): RejectedRoleModelDecisionResult {
  return Object.freeze({
    status: 'rejected',
    rejection: freezeRoleModelDecisionRejection({
      reason,
      ...(details === undefined ? {} : { details })
    })
  } satisfies RejectedRoleModelDecisionResult);
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
    rawOutputText: options.rawOutputText,
    ...(options.providerMetadata === undefined
      ? {}
      : { providerMetadata: freezeProviderMetadata(options.providerMetadata) })
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
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[] = [],
  toolObservations: readonly RoleModelToolObservation[] = []
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
    toolObservations
  );
}

export function isRoleModelRawOutputReplayableDecisionEvidence(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RoleModelDecisionResult;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly pluginToolDefinitions?: readonly RoleModelPluginToolDefinition[];
  readonly toolObservations?: readonly RoleModelToolObservation[];
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
      JSON.stringify(options.actual.decision) ===
        JSON.stringify(options.expected.decision)
    );
  }

  return (
    options.expected.status === 'rejected' &&
    options.actual.rejection.reason === options.expected.rejection.reason &&
    options.actual.rejection.details === options.expected.rejection.details
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
    (options.decisionResult.rejection.details ===
      roleModelAdapterRawOutputMissingTextRejectionDetails ||
      options.decisionResult.rejection.details ===
        roleModelAdapterRejectionNotReplayableDetails)
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

export function getCharacterStatePatchToolCall(
  decision: CharacterDecision
): CharacterStatePatchModelToolCall | undefined {
  return findCharacterStatePatchModelToolCall(decision.toolCalls);
}

function parseRoleModelDecisionObject(
  parsedOutput: unknown,
  allowedTools: readonly RoleModelAllowedToolName[],
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
  toolObservations: readonly RoleModelToolObservation[]
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
      rawToolCall
    });

    if (parsedToolCall.status === 'rejected') {
      return parsedToolCall.result;
    }

    toolCalls.push(parsedToolCall.toolCall);
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

  return createAcceptedRoleModelDecisionResult(createCharacterDecision(toolCalls), {
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
    return parseVisibleReplyToolCallInput(input, options.index);
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

  if (name === characterStatePatchModelToolName) {
    return {
      status: 'accepted',
      toolCall: createCharacterStatePatchModelToolCall(jsonInputValidation.input)
    };
  }

  return {
    status: 'accepted',
    toolCall: freezeModelToolCall({
      name,
      input: jsonInputValidation.input
    })
  };
}

function parseVisibleReplyToolCallInput(
  input: Readonly<Record<string, unknown>>,
  index: number
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

  return {
    status: 'accepted',
    toolCall: createVisibleReplyModelToolCall(text)
  };
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

function validateUserTurnToolCallCardinality(
  toolCalls: readonly ModelToolCall[],
  modelToolDefinitions: readonly RoleModelToolDefinition[],
  toolObservations: readonly RoleModelToolObservation[]
): RejectedRoleModelDecisionResult | undefined {
  const visibleReplyCount = toolCalls.filter(
    (call) => call.name === visibleReplyModelToolName
  ).length;
  if (visibleReplyCount > 1) {
    return createRejectedRoleModelDecisionResult(
      roleModelDuplicateToolCallRejectionReason,
      'Decision must not include duplicate visible_reply tool calls.'
    );
  }

  for (const call of toolCalls) {
    const definition = modelToolDefinitions.find(
      (candidate) => candidate.name === call.name
    );

    if (definition === undefined) {
      return createRejectedRoleModelDecisionResult(
        roleModelUnknownToolRejectionReason,
        `Decision requested unsupported tool "${call.name}".`
      );
    }
  }

  for (const definition of modelToolDefinitions) {
    if (isBuiltInModelToolName(definition.name)) {
      continue;
    }

    const currentDecisionCount = toolCalls.filter(
      (call) => call.name === definition.name
    ).length;
    const previousTurnCount = toolObservations.filter(
      (observation) => observation.toolName === definition.name
    ).length;
    const successfulPreviousTurnCount = toolObservations.filter(
      (observation) =>
        observation.toolName === definition.name &&
        observation.result.status === 'accepted'
    ).length;
    const count = previousTurnCount + currentDecisionCount;
    const requiredCount = successfulPreviousTurnCount + currentDecisionCount;

    if (definition.requiredForUserTurn && requiredCount === 0) {
      return createRejectedRoleModelDecisionResult(
        roleModelMissingRequiredToolCallRejectionReason,
        `Decision must include required ${definition.name} tool call.`
      );
    }

    if (count > definition.maxCallsPerUserTurn) {
      return createRejectedRoleModelDecisionResult(
        roleModelDuplicateToolCallRejectionReason,
        `Decision requested ${definition.name} ${String(
          count
        )} times; maxCallsPerUserTurn is ${String(
          definition.maxCallsPerUserTurn
        )}.`
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
    createdAt: identity.createdAt
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

    if (isBuiltInModelToolName(providedTool.name)) {
      throw new TypeError(
        `Plugin tool "${providedTool.name}" must not duplicate a built-in model tool.`
      );
    }

    if (seenNames.has(providedTool.name)) {
      throw new TypeError(
        `Plugin tool "${providedTool.name}" is declared more than once.`
      );
    }

    if (providedTool.validationOwner !== 'plugin_host') {
      throw new TypeError(
        `Plugin tool "${providedTool.name}" must be validated by plugin_host.`
      );
    }

    if (providedTool.requiresConfirmation) {
      throw new TypeError(
        `Plugin tool "${providedTool.name}" requires confirmation and cannot be model-facing in CT-03.`
      );
    }

    if (
      providedTool.sideEffectLevel !== 'none' &&
      providedTool.sideEffectLevel !== 'runtime_read' &&
      providedTool.sideEffectLevel !== 'local_memory_write'
    ) {
      throw new TypeError(
        `Plugin tool "${providedTool.name}" must be read-only or local-memory-only for CT-03.`
      );
    }

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

function modelToolDefinitionsForPluginToolDefinitions(
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[]
): readonly RoleModelToolDefinition[] {
  return Object.freeze([
    ...builtInModelToolDefinitionsForUserTurn(),
    ...pluginToolDefinitions.map((definition) =>
      freezeModelToolDefinition(definition)
    )
  ]);
}

function defaultAllowedToolsForPluginDefinitions(
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[]
): readonly RoleModelAllowedToolName[] {
  return Object.freeze([
    ...roleModelAllowedToolNames,
    ...pluginToolDefinitions.map((definition) => definition.name)
  ]);
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
    input: freezeRuntimePluginJsonObject(observation.input),
    result: freezeRoleModelToolObservationResult(observation.result)
  } satisfies RoleModelToolObservation);
}

function freezeRoleModelToolObservationResult(
  result: RoleModelToolObservationResult
): RoleModelToolObservationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: freezeRuntimePluginJsonValue(result.output)
    } satisfies RoleModelToolObservationResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message
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
    ...(metadata.model === undefined ? {} : { model: metadata.model }),
    ...(metadata.request === undefined
      ? {}
      : {
          request: Object.freeze({
            ...(metadata.request.endpoint === undefined
              ? {}
              : { endpoint: metadata.request.endpoint }),
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
            code: metadata.error.code,
            message: metadata.error.message
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
    ...(rejection.details === undefined ? {} : { details: rejection.details })
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
    result.rejection.details
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
  CharacterStatePatchModelToolCall,
  VisibleReplyModelToolCall
};
