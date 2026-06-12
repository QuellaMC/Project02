import type { CharacterProfile, VisibleMessage } from './conversation.ts';
import {
  createLivingStateBrief,
  type LivingStateBrief
} from './character-state.ts';
import {
  createAgentCapabilityContextItem,
  createAgentCapabilityProvidedTool,
  type AgentCapabilityContextItem,
  type AgentCapabilityProvidedTool
} from './agent-capabilities.ts';
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
} from './runtime-event.ts';

export const roleModelDecisionContractVersion = 'mvp-006.tool_calls.v1';
export const roleModelLegacyDecisionContractVersion = 'mvp-005.visible_reply.v1';
export const roleModelVisibleReplyActionName = visibleReplyModelToolName;
export const roleModelCharacterStatePatchToolName =
  characterStatePatchModelToolName;
export const roleModelCapabilityListToolName = 'capability.list';

export type RoleModelAllowedToolName = string;
export type RoleModelAllowedActionName = RoleModelAllowedToolName;
export type RoleModelToolDefinition = ModelToolDefinition;

export type RoleModelCapabilityToolDefinition = AgentCapabilityProvidedTool & {
  readonly capabilityId: string;
};

export const roleModelAllowedToolNames = userTurnBuiltInModelToolNames;
export const roleModelAllowedActionNames = roleModelAllowedToolNames;

export function isRoleModelAllowedToolName(
  value: unknown
): value is RoleModelAllowedToolName {
  return typeof value === 'string' && isRoleModelToolNameSyntax(value);
}

export const isRoleModelAllowedActionName = isRoleModelAllowedToolName;

export const roleModelDecisionOutputContractText =
  'Return exactly one complete valid JSON CharacterDecision object with version "mvp-006.tool_calls.v1" and ordered toolCalls. Required call shape: {"name":"visible_reply","input":{"text":"one visible reply line"}}. Each toolCalls item must use string field "name", not "tool" or "type", and object field "input". For a user turn, include one visible_reply call with input.text. Include character_state.patch only when it is listed in allowedTools and toolDefinitions. Include capability tools only when their names are listed in both allowedTools and toolDefinitions.';

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
  readonly capabilityContextItems: readonly AgentCapabilityContextItem[];
  readonly livingStateBrief?: LivingStateBrief;
};

export type CreateDecisionContextOptions = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly recentVisibleMessages?: readonly VisibleMessage[];
  readonly runtimeNotes?: readonly string[];
  readonly capabilityContextItems?: readonly AgentCapabilityContextItem[];
  readonly livingStateBrief?: LivingStateBrief;
};

export type RoleModelInputEnvelope = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly toolDefinitions: readonly RoleModelToolDefinition[];
  readonly capabilityToolDefinitions: readonly RoleModelCapabilityToolDefinition[];
  readonly outputContract: RoleModelOutputContract;
};

export type CreateRoleModelInputEnvelopeOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly allowedActions?: readonly RoleModelAllowedActionName[];
  readonly capabilityToolDefinitions?: readonly RoleModelCapabilityToolDefinition[];
  readonly outputContract?: RoleModelOutputContract;
};

export type RoleModelVisibleReplyAction = {
  readonly type: typeof roleModelVisibleReplyActionName;
  readonly text: string;
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
export const roleModelInvalidCharacterStatePatchRejectionReason =
  'invalid_character_state_patch';
export const roleModelProviderErrorRejectionReason = 'provider_error';
export const roleModelCommitValidationFailureRejectionReason =
  'commit_validation_failure';
export const roleModelCapabilityToolRejectedRejectionReason =
  'capability_tool_rejected';
export const roleModelAdapterRawOutputMissingTextRejectionDetails =
  'Adapter raw output must include string rawOutputText.';
export const roleModelAdapterRejectionNotReplayableDetails =
  'Adapter rejection must be replayable from rawOutputText.';

export type RoleModelDecisionRejectionReason =
  | typeof roleModelMalformedOutputRejectionReason
  | typeof roleModelMalformedToolCallRejectionReason
  | typeof roleModelUnknownToolRejectionReason
  | typeof roleModelDisallowedToolRejectionReason
  | typeof roleModelDuplicateToolCallRejectionReason
  | typeof roleModelMissingRequiredToolCallRejectionReason
  | typeof roleModelUnsupportedEffectRejectionReason
  | typeof roleModelInvalidVisibleReplyRejectionReason
  | typeof roleModelInvalidCharacterStatePatchRejectionReason
  | typeof roleModelProviderErrorRejectionReason
  | typeof roleModelCommitValidationFailureRejectionReason
  | typeof roleModelCapabilityToolRejectedRejectionReason;

export const roleModelDecisionRejectionReasons = Object.freeze([
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelUnknownToolRejectionReason,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelCommitValidationFailureRejectionReason,
  roleModelCapabilityToolRejectedRejectionReason
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
    capabilityContextItems: freezeCapabilityContextItems(
      options.capabilityContextItems ?? []
    ),
    ...(options.livingStateBrief === undefined
      ? {}
      : { livingStateBrief: createLivingStateBriefFromBrief(options.livingStateBrief) })
  } satisfies DecisionContext);
}

export function createRoleModelInputEnvelope(
  options: CreateRoleModelInputEnvelopeOptions
): RoleModelInputEnvelope {
  const capabilityToolDefinitions = freezeCapabilityToolDefinitions(
    options.capabilityToolDefinitions ?? []
  );
  const modelToolDefinitions = modelToolDefinitionsForCapabilityToolDefinitions(
    capabilityToolDefinitions
  );
  const allowedTools = freezeAllowedTools(
    options.allowedTools ??
      options.allowedActions ??
      defaultAllowedToolsForCapabilityDefinitions(capabilityToolDefinitions),
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
    capabilityToolDefinitions,
    outputContract: freezeRoleModelOutputContract(
      options.outputContract ?? roleModelDecisionOutputContract
    )
  } satisfies RoleModelInputEnvelope);
}

export function createCharacterDecision(
  toolCalls: readonly ModelToolCall[]
): CharacterDecision {
  assertUserTurnToolCallCardinality(toolCalls, builtInModelToolDefinitionsForUserTurn());

  return freezeCharacterDecision({
    version: roleModelDecisionContractVersion,
    toolCalls
  });
}

export function createVisibleReplyCharacterDecision(
  text: string
): CharacterDecision {
  return createCharacterDecision([createVisibleReplyModelToolCall(text)]);
}

export function createAcceptedRoleModelDecisionResult(
  decision: CharacterDecision
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: freezeCharacterDecision(decision)
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
  capabilityToolDefinitions: readonly RoleModelCapabilityToolDefinition[] = []
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
    capabilityToolDefinitions
  );
}

export function isRoleModelRawOutputReplayableDecisionEvidence(options: {
  readonly rawOutputText: string;
  readonly providerMetadata: RoleModelProviderMetadata | undefined;
  readonly decisionResult: RoleModelDecisionResult;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly capabilityToolDefinitions?: readonly RoleModelCapabilityToolDefinition[];
}): boolean {
  const parsedRawOutputDecision = parseRoleModelDecision(
    options.rawOutputText,
    options.allowedTools,
    options.capabilityToolDefinitions
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
    isRoleModelProviderErrorRawOutputEvidence({
      rawOutputText: options.rawOutputText,
      providerMetadata: options.providerMetadata,
      decisionResult: options.decisionResult
    })
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
  capabilityToolDefinitions: readonly RoleModelCapabilityToolDefinition[]
): RoleModelDecisionResult {
  const frozenCapabilityToolDefinitions = freezeCapabilityToolDefinitions(
    capabilityToolDefinitions
  );
  const modelToolDefinitions = modelToolDefinitionsForCapabilityToolDefinitions(
    frozenCapabilityToolDefinitions
  );
  const frozenAllowedTools = freezeAllowedTools(
    allowedTools,
    modelToolDefinitions
  );

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

  if (parsedOutput['action'] !== undefined) {
    return parseLegacyVisibleReplyDecision(parsedOutput, frozenAllowedTools);
  }

  const version = parsedOutput['version'];

  if (version !== roleModelDecisionContractVersion) {
    return createMalformedOutputResult(
      `Decision version must be "${roleModelDecisionContractVersion}".`
    );
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, [
    'version',
    'toolCalls'
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
      allowedTools: frozenAllowedTools,
      modelToolDefinitions,
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
    modelToolDefinitions
  );

  if (cardinalityResult !== undefined) {
    return cardinalityResult;
  }

  return createAcceptedRoleModelDecisionResult(createCharacterDecision(toolCalls));
}

function parseLegacyVisibleReplyDecision(
  parsedOutput: Readonly<Record<string, unknown>>,
  allowedTools: readonly RoleModelAllowedToolName[]
): RoleModelDecisionResult {
  const action = parsedOutput['action'];

  if (!isJsonRecord(action)) {
    return createMalformedOutputResult('Decision action must be an object.');
  }

  const actionType = action['type'];

  if (typeof actionType !== 'string') {
    return createMalformedOutputResult('Decision action.type must be a string.');
  }

  if (actionType !== roleModelVisibleReplyActionName) {
    return createUnsupportedOutputResult(
      `Decision action.type "${actionType}" is not supported.`
    );
  }

  if (!allowedTools.includes(roleModelVisibleReplyActionName)) {
    return createRejectedRoleModelDecisionResult(
      roleModelDisallowedToolRejectionReason,
      `Decision requested disallowed tool "${roleModelVisibleReplyActionName}".`
    );
  }

  const replyText = action['text'];

  if (typeof replyText !== 'string') {
    return createMalformedOutputResult('Decision action.text must be a string.');
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, ['action']);

  if (unsupportedTopLevelKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision includes unsupported fields: ${unsupportedTopLevelKeys.join(', ')}.`
    );
  }

  const unsupportedActionKeys = findUnsupportedKeys(action, ['type', 'text']);

  if (unsupportedActionKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision action includes unsupported fields: ${unsupportedActionKeys.join(
        ', '
      )}.`
    );
  }

  return createAcceptedRoleModelDecisionResult(
    createVisibleReplyCharacterDecision(replyText)
  );
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
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly modelToolDefinitions: readonly RoleModelToolDefinition[];
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

  const modelToolDefinition = findModelToolDefinition(
    options.modelToolDefinitions,
    name
  );

  if (modelToolDefinition === undefined) {
    return {
      status: 'rejected',
      result: createRejectedRoleModelDecisionResult(
        roleModelUnknownToolRejectionReason,
        `Decision requested unknown tool "${name}".`
      )
    };
  }

  if (!options.allowedTools.includes(name)) {
    return {
      status: 'rejected',
      result: createRejectedRoleModelDecisionResult(
        roleModelDisallowedToolRejectionReason,
        `Decision requested disallowed tool "${name}".`
      )
    };
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

  if (name === characterStatePatchModelToolName) {
    return {
      status: 'accepted',
      toolCall: createCharacterStatePatchModelToolCall(input)
    };
  }

  const inputValidation = validateModelToolInputAgainstContract({
    toolName: name,
    input,
    inputContract: modelToolDefinition.inputContract
  });

  if (inputValidation.status === 'rejected') {
    return rejectToolCall(inputValidation.details);
  }

  return {
    status: 'accepted',
    toolCall: freezeModelToolCall({
      name,
      input: inputValidation.input
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

function assertUserTurnToolCallCardinality(
  toolCalls: readonly ModelToolCall[],
  modelToolDefinitions: readonly RoleModelToolDefinition[]
): void {
  const result = validateUserTurnToolCallCardinality(
    toolCalls,
    modelToolDefinitions
  );

  if (result !== undefined) {
    throw new TypeError(result.rejection.details ?? result.rejection.reason);
  }
}

function validateUserTurnToolCallCardinality(
  toolCalls: readonly ModelToolCall[],
  modelToolDefinitions: readonly RoleModelToolDefinition[]
): RejectedRoleModelDecisionResult | undefined {
  const visibleReplyCount = toolCalls.filter(
    (call) => call.name === visibleReplyModelToolName
  ).length;
  const characterStatePatchCount = toolCalls.filter(
    (call) => call.name === characterStatePatchModelToolName
  ).length;

  if (visibleReplyCount === 0) {
    return createRejectedRoleModelDecisionResult(
      roleModelMissingRequiredToolCallRejectionReason,
      'Decision must include exactly one visible_reply tool call.'
    );
  }

  if (visibleReplyCount > 1) {
    return createRejectedRoleModelDecisionResult(
      roleModelDuplicateToolCallRejectionReason,
      'Decision must not include duplicate visible_reply tool calls.'
    );
  }

  if (characterStatePatchCount > 1) {
    return createRejectedRoleModelDecisionResult(
      roleModelDuplicateToolCallRejectionReason,
      'Decision must not include duplicate character_state.patch tool calls.'
    );
  }

  for (const definition of modelToolDefinitions) {
    if (isBuiltInModelToolName(definition.name)) {
      continue;
    }

    const count = toolCalls.filter((call) => call.name === definition.name).length;

    if (definition.requiredForUserTurn && count === 0) {
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

function createLivingStateBriefFromBrief(
  brief: LivingStateBrief
): LivingStateBrief {
  return createLivingStateBrief({
    version: 'mvp-006.character_state.v1',
    current: brief.current
  });
}

function freezeCapabilityContextItems(
  contextItems: readonly AgentCapabilityContextItem[]
): readonly AgentCapabilityContextItem[] {
  return Object.freeze(contextItems.map(createAgentCapabilityContextItem));
}

function freezeCapabilityToolDefinitions(
  definitions: readonly RoleModelCapabilityToolDefinition[]
): readonly RoleModelCapabilityToolDefinition[] {
  const frozenDefinitions: RoleModelCapabilityToolDefinition[] = [];
  const seenNames = new Set<string>();

  for (const definition of definitions) {
    const capabilityId = requiredRoleModelIdentifier(
      definition.capabilityId,
      'capabilityId'
    );
    const providedTool = createAgentCapabilityProvidedTool(definition);

    if (isBuiltInModelToolName(providedTool.name)) {
      throw new TypeError(
        `Capability tool "${providedTool.name}" must not duplicate a built-in model tool.`
      );
    }

    if (seenNames.has(providedTool.name)) {
      throw new TypeError(
        `Capability tool "${providedTool.name}" is declared more than once.`
      );
    }

    if (providedTool.validationOwner !== 'capability_host') {
      throw new TypeError(
        `Capability tool "${providedTool.name}" must be validated by capability_host.`
      );
    }

    if (providedTool.requiresConfirmation) {
      throw new TypeError(
        `Capability tool "${providedTool.name}" requires confirmation and cannot be model-facing in CT-03.`
      );
    }

    if (
      providedTool.sideEffectLevel !== 'none' &&
      providedTool.sideEffectLevel !== 'runtime_read'
    ) {
      throw new TypeError(
        `Capability tool "${providedTool.name}" must be read-only for CT-03.`
      );
    }

    seenNames.add(providedTool.name);
    frozenDefinitions.push(
      Object.freeze({
        capabilityId,
        ...providedTool
      } satisfies RoleModelCapabilityToolDefinition)
    );
  }

  return Object.freeze(frozenDefinitions);
}

function modelToolDefinitionsForCapabilityToolDefinitions(
  capabilityToolDefinitions: readonly RoleModelCapabilityToolDefinition[]
): readonly RoleModelToolDefinition[] {
  return Object.freeze([
    ...builtInModelToolDefinitionsForUserTurn(),
    ...capabilityToolDefinitions.map((definition) =>
      freezeModelToolDefinition(definition)
    )
  ]);
}

function defaultAllowedToolsForCapabilityDefinitions(
  capabilityToolDefinitions: readonly RoleModelCapabilityToolDefinition[]
): readonly RoleModelAllowedToolName[] {
  return Object.freeze([
    ...roleModelAllowedToolNames,
    ...capabilityToolDefinitions.map((definition) => definition.name)
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

function findModelToolDefinition(
  definitions: readonly RoleModelToolDefinition[],
  name: string
): RoleModelToolDefinition | undefined {
  return definitions.find((definition) => definition.name === name);
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

function freezeProviderMetadata(
  metadata: RoleModelProviderMetadata
): RoleModelProviderMetadata {
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
            ...(metadata.request.messageCount === undefined
              ? {}
              : { messageCount: metadata.request.messageCount }),
            stream: false
          })
        }),
    ...(metadata.response === undefined
      ? {}
      : {
          response: Object.freeze({
            ...(metadata.response.status === undefined
              ? {}
              : { status: metadata.response.status })
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
    return createAcceptedRoleModelDecisionResult(result.decision);
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
