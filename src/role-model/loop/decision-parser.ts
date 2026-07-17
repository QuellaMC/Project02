import {
  createJsonBoundaryObjectSnapshot
} from '../../shared/json-boundary.ts';
import { canonicalJsonValuesEqual } from '../../shared/canonical-json.ts';
import {
  freezeBuiltInModelToolCall,
  freezeModelToolCall,
  validateModelToolInputAgainstContract,
  visibleReplyModelToolName,
  createVisibleReplyModelToolCall,
  findVisibleReplyModelToolCall,
  type BuiltInModelToolCall,
  type BuiltInModelToolName,
  type ModelToolCall,
  type VisibleReplyModelToolCall
} from '../api/model-tools.ts';
import { isRoleModelToolNameSyntax, roleModelAllowedToolNames, type RoleModelAllowedToolName } from '../api/tool-names.ts';
import { scrubReasoningBlocks } from '../api/reasoning.ts';
import {
  createDefaultRoleModelPluginToolDefinitions,
  createRoleModelPluginToolDefinitions,
  modelToolDefinitionsForPluginToolDefinitions,
  toolDefinitionsForAllowedTools
} from '../api/plugin-tool-definitions.ts';
import {
  isJsonRecord
} from '../api/provider-exchange.ts';
import {
  roleModelDecisionContractVersion,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  roleModelUnsupportedEffectRejectionReason,
  isRoleModelMalformedAdapterRawOutputDetails,
  type CharacterDecision, type RoleModelProviderMetadata,
  type RoleModelToolObservation,
  type AcceptedRoleModelDecisionResult, type RejectedRoleModelDecisionResult,
  type RoleModelDecisionResult,
  type RoleModelPluginToolDefinition, type RoleModelToolDefinition
} from '../api/contracts.ts';
import {
  freezeAllowedTools,
  createAcceptedRoleModelDecisionResult, createCharacterDecision,
  createRejectedRoleModelDecisionResult
} from '../api/decision.ts';

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
