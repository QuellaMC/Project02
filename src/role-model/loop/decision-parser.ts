import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';
import {
  freezeBuiltInModelToolCall,
  freezeModelToolCall,
  visibleReplyModelToolName,
  createVisibleReplyModelToolCall,
  type BuiltInModelToolCall,
  type BuiltInModelToolName,
  type ModelToolCall,
  type VisibleReplyModelToolCall,
} from '../api/model-tools.ts';
import {
  isRoleModelToolNameSyntax,
  roleModelAllowedToolNames,
  type RoleModelAllowedToolName,
} from '../api/tool-names.ts';
import {scrubReasoningBlocks} from '../api/reasoning.ts';
import {
  createDefaultRoleModelPluginToolDefinitions,
  createRoleModelPluginToolDefinitions,
  modelToolDefinitionsForPluginToolDefinitions,
} from '../api/plugin-tool-definitions.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {
  roleModelDecisionContractVersion,
  roleModelDisallowedToolRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  roleModelUnsupportedEffectRejectionReason,
  type CharacterDecision,
  type AcceptedRoleModelDecisionResult,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionResult,
  type RoleModelPluginToolDefinition,
} from '../api/contracts.ts';
import {
  freezeAllowedTools,
  createAcceptedRoleModelDecisionResult,
  createCharacterDecision,
  createRejectedRoleModelDecisionResult,
} from '../api/decision.ts';

export function parseRoleModelDecision(
  rawOutputText: string,
  allowedTools: readonly RoleModelAllowedToolName[] = roleModelAllowedToolNames,
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[] = createDefaultRoleModelPluginToolDefinitions(),
): RoleModelDecisionResult {
  return parseRoleModelDecisionForBoundary(
    rawOutputText,
    allowedTools,
    pluginToolDefinitions,
    'public_snapshot',
  );
}

export function parseRoleModelExecutionDecision(
  rawOutputText: string,
  allowedTools: readonly RoleModelAllowedToolName[] = roleModelAllowedToolNames,
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[] = createDefaultRoleModelPluginToolDefinitions(),
): RoleModelDecisionResult {
  return parseRoleModelDecisionForBoundary(
    rawOutputText,
    allowedTools,
    pluginToolDefinitions,
    'execution',
  );
}

type RoleModelDecisionBoundary = 'execution' | 'public_snapshot';

function parseRoleModelDecisionForBoundary(
  rawOutputText: string,
  allowedTools: readonly RoleModelAllowedToolName[],
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
  boundary: RoleModelDecisionBoundary,
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
    boundary,
  );
}

export function getRequiredVisibleReplyText(
  decision: CharacterDecision,
): string {
  const visibleReply = visibleReplyToolCalls(decision)[0];

  if (visibleReply === undefined) {
    throw new TypeError('CharacterDecision must include visible_reply.');
  }

  return visibleReply.input.text;
}

/** Every reply the decision asks to send, in the order it asked. */
export function visibleReplyToolCalls(
  decision: CharacterDecision,
): readonly VisibleReplyModelToolCall[] {
  return Object.freeze(
    decision.toolCalls.filter(
      (call): call is VisibleReplyModelToolCall =>
        call.name === visibleReplyModelToolName,
    ),
  );
}

function parseRoleModelDecisionObject(
  parsedOutput: unknown,
  allowedTools: readonly RoleModelAllowedToolName[],
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
  boundary: RoleModelDecisionBoundary,
): RoleModelDecisionResult {
  const frozenPluginToolDefinitions = createRoleModelPluginToolDefinitions(
    pluginToolDefinitions,
  );
  const modelToolDefinitions = modelToolDefinitionsForPluginToolDefinitions(
    frozenPluginToolDefinitions,
  );
  const frozenAllowedTools = freezeAllowedTools(
    allowedTools,
    modelToolDefinitions,
  );
  if (!isJsonRecord(parsedOutput)) {
    return createMalformedOutputResult(
      'Adapter output must be a CharacterDecision JSON object.',
    );
  }

  if (hasEffectShape(parsedOutput)) {
    return createUnsupportedOutputResult(
      'Decision includes unsupported effect fields.',
    );
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, [
    'version',
    'toolCalls',
    'text',
  ]);

  if (unsupportedTopLevelKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision includes unsupported fields: ${unsupportedTopLevelKeys.join(', ')}.`,
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
      boundary,
    });

    if (parsedToolCall.status === 'rejected') {
      return parsedToolCall.result;
    }

    toolCalls.push(parsedToolCall.toolCall);
  }

  const availabilityResult = validateToolCallAvailability({
    toolCalls,
    allowedTools: frozenAllowedTools,
  });

  if (availabilityResult !== undefined) {
    return availabilityResult;
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
      roleModelTerminalEmptyOutputRejectionDetails,
    );
  }

  if (topLevelText !== undefined && toolCalls.length > 0) {
    return createMalformedOutputResult(
      'Decision text is only allowed when toolCalls is empty.',
    );
  }

  return boundary === 'execution'
    ? createExecutionRoleModelDecisionResult(toolCalls, topLevelText)
    : createAcceptedRoleModelDecisionResult(
        createCharacterDecision(toolCalls),
        {
          ...(topLevelText === undefined
            ? {}
            : {nonCommittedText: topLevelText}),
        },
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
  readonly boundary: RoleModelDecisionBoundary;
  readonly index: number;
  readonly rawToolCall: unknown;
}): ParsedToolCallResult {
  if (!isJsonRecord(options.rawToolCall)) {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}] must be an object.`,
    );
  }

  const unsupportedToolCallKeys = findUnsupportedKeys(options.rawToolCall, [
    'name',
    'input',
  ]);

  if (unsupportedToolCallKeys.length > 0) {
    return {
      status: 'rejected',
      result: createUnsupportedOutputResult(
        `Decision toolCalls[${String(
          options.index,
        )}] includes unsupported fields: ${unsupportedToolCallKeys.join(', ')}.`,
      ),
    };
  }

  const name = options.rawToolCall['name'];

  if (typeof name !== 'string') {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}].name must be a string.`,
    );
  }

  if (!isRoleModelToolNameSyntax(name)) {
    return rejectToolCall(
      `Decision toolCalls[${String(
        options.index,
      )}].name must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  const input = options.rawToolCall['input'];

  if (!isJsonRecord(input)) {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}].input must be an object.`,
    );
  }

  if (name === visibleReplyModelToolName) {
    return parseVisibleReplyToolCallInput(input, options.index);
  }

  // The plugin's own contract is checked by the host; here the call only
  // has to cross the JSON boundary, which the freeze below does. The
  // boundary's refusal is the model's correction note: a proposal it
  // cannot carry is a malformed tool call, not a runtime failure.
  try {
    return {
      status: 'accepted',
      toolCall:
        options.boundary === 'execution'
          ? freezeExecutionModelToolCall({name, input})
          : freezeModelToolCall({name, input}),
    };
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return rejectToolCall(error.message);
    }

    throw error;
  }
}

function parseVisibleReplyToolCallInput(
  input: Readonly<Record<string, unknown>>,
  index: number,
): ParsedToolCallResult {
  const text = input['text'];

  if (typeof text !== 'string') {
    return rejectToolCall(
      `Decision toolCalls[${String(index)}].input.text must be a string.`,
    );
  }

  const unsupportedInputKeys = findUnsupportedKeys(input, ['text']);

  if (unsupportedInputKeys.length > 0) {
    return {
      status: 'rejected',
      result: createRejectedRoleModelDecisionResult(
        roleModelUnsupportedEffectRejectionReason,
        `visible_reply input includes unsupported fields: ${unsupportedInputKeys.join(
          ', ',
        )}.`,
      ),
    };
  }

  const scrubbedText = scrubReasoningBlocks(text);

  if (scrubbedText.status === 'rejected') {
    return rejectToolCall(
      'visible_reply text contains an unterminated reasoning block.',
    );
  }

  return {
    status: 'accepted',
    toolCall: createVisibleReplyModelToolCall(scrubbedText.text),
  };
}

function createExecutionRoleModelDecisionResult(
  toolCalls: readonly ModelToolCall[],
  nonCommittedText: string | undefined,
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: Object.freeze({
      version: roleModelDecisionContractVersion,
      toolCalls: Object.freeze(toolCalls.map(freezeExecutionModelToolCall)),
    } satisfies CharacterDecision),
    ...(nonCommittedText === undefined ? {} : {nonCommittedText}),
  } satisfies AcceptedRoleModelDecisionResult);
}

function freezeExecutionModelToolCall(call: ModelToolCall): ModelToolCall {
  if (call.name === visibleReplyModelToolName) {
    const text = call.input['text'];

    return createVisibleReplyModelToolCall(
      typeof text === 'string' ? text : '',
    );
  }

  return Object.freeze({
    name: call.name,
    input: createJsonBoundaryObjectSnapshot(call.input, {
      field: `Model tool "${call.name}" execution input`,
    }),
  } satisfies ModelToolCall);
}

function rejectToolCall(details: string): ParsedToolCallResult {
  return {
    status: 'rejected',
    result: createRejectedRoleModelDecisionResult(
      roleModelMalformedToolCallRejectionReason,
      details,
    ),
  };
}

function validateToolCallAvailability(options: {
  readonly toolCalls: readonly ModelToolCall[];
  readonly allowedTools: readonly RoleModelAllowedToolName[];
}): RejectedRoleModelDecisionResult | undefined {
  // Executable calls outside allowedTools are NOT a parse failure: tool
  // routing rejects them pre-dispatch as tool_not_declared, which the model
  // sees as a failed observation and can correct. Only visible_reply keeps a
  // parse-level gate — it is commit semantics, not a routed tool, so an
  // unavailable visible_reply has no downstream enforcement point.
  const disallowedVisibleReply = options.toolCalls.find(
    call =>
      call.name === visibleReplyModelToolName &&
      !options.allowedTools.includes(call.name),
  );

  if (disallowedVisibleReply !== undefined) {
    return createRejectedRoleModelDecisionResult(
      roleModelDisallowedToolRejectionReason,
      `Decision requested disallowed tool ${disallowedVisibleReply.name}.`,
      {
        requestedToolNames: options.toolCalls.map(call => call.name),
      },
    );
  }

  return undefined;
}

function createMalformedOutputResult(
  details: string,
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelMalformedOutputRejectionReason,
    details,
  );
}

function createUnsupportedOutputResult(
  details: string,
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelUnsupportedEffectRejectionReason,
    details,
  );
}

function hasEffectShape(record: Readonly<Record<string, unknown>>): boolean {
  return record['effect'] !== undefined || record['effects'] !== undefined;
}

function findUnsupportedKeys(
  record: Readonly<Record<string, unknown>>,
  supportedKeys: readonly string[],
): readonly string[] {
  return Object.keys(record).filter(key => !supportedKeys.includes(key));
}

export {freezeBuiltInModelToolCall};
export type {
  BuiltInModelToolCall,
  BuiltInModelToolName,
  VisibleReplyModelToolCall,
};
