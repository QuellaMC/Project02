import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';
import {
  normalizeVisibleMessageText,
  VisibleMessageTextValidationError,
} from '../../core/index.ts';
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
import {isRoleModelToolNameSyntax} from '../api/tool-names.ts';
import {scrubReasoningBlocks} from '../api/reasoning.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {
  roleModelDecisionContractVersion,
  roleModelMalformedOutputRejectionReason,
  type CharacterDecision,
  type AcceptedRoleModelDecisionResult,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionResult,
} from '../api/contracts.ts';
import {
  createAcceptedRoleModelDecisionResult,
  createCharacterDecision,
  createRejectedRoleModelDecisionResult,
} from '../api/decision.ts';

/**
 * The one judge of what the model wrote. Anything the decision contract does
 * not allow — shape, tool-call shape, a blank reply, a round that neither
 * replies nor calls a tool — is refused here as malformed_output with the
 * reason in details, and the loop hands that back to the model.
 */
export function parseRoleModelDecision(
  rawOutputText: string,
): RoleModelDecisionResult {
  return parseRoleModelDecisionForBoundary(rawOutputText, 'public_snapshot');
}

export function parseRoleModelExecutionDecision(
  rawOutputText: string,
): RoleModelDecisionResult {
  return parseRoleModelDecisionForBoundary(rawOutputText, 'execution');
}

type RoleModelDecisionBoundary = 'execution' | 'public_snapshot';

function parseRoleModelDecisionForBoundary(
  rawOutputText: string,
  boundary: RoleModelDecisionBoundary,
): RoleModelDecisionResult {
  let parsedOutput: unknown;

  try {
    parsedOutput = JSON.parse(rawOutputText);
  } catch {
    return createMalformedOutputResult('Adapter output must be valid JSON.');
  }

  return parseRoleModelDecisionObject(parsedOutput, boundary);
}

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

/** Executable calls are every call but visible_reply, which the runtime commits itself. */
export function executableModelToolCalls(
  toolCalls: readonly ModelToolCall[],
): readonly ModelToolCall[] {
  return Object.freeze(
    toolCalls.filter(call => call.name !== visibleReplyModelToolName),
  );
}

function parseRoleModelDecisionObject(
  parsedOutput: unknown,
  boundary: RoleModelDecisionBoundary,
): RoleModelDecisionResult {
  if (!isJsonRecord(parsedOutput)) {
    return createMalformedOutputResult(
      'Adapter output must be a CharacterDecision JSON object.',
    );
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, [
    'version',
    'toolCalls',
    'text',
  ]);

  if (unsupportedTopLevelKeys.length > 0) {
    return createMalformedOutputResult(
      `Decision includes unsupported fields: ${unsupportedTopLevelKeys.join(', ')}.`,
    );
  }

  const rawToolCalls = parsedOutput['toolCalls'];

  if (!Array.isArray(rawToolCalls)) {
    return createMalformedOutputResult('Decision toolCalls must be an array.');
  }

  if (rawToolCalls.length === 0) {
    return createMalformedOutputResult(
      'Decision toolCalls must not be empty: reply with visible_reply or call a tool.',
    );
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

  const topLevelText = parsedOutput['text'];

  if (topLevelText !== undefined && typeof topLevelText !== 'string') {
    return createMalformedOutputResult('Decision text must be a string.');
  }

  // A thinking model leaves a newline where its reasoning block was; blank
  // text is nothing the model said, not a refusal.
  const text =
    topLevelText === undefined || topLevelText.trim().length === 0
      ? undefined
      : topLevelText;

  return boundary === 'execution'
    ? createExecutionRoleModelDecisionResult(toolCalls, text)
    : createAcceptedRoleModelDecisionResult(
        createCharacterDecision(toolCalls, text),
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
    return rejectToolCall(
      `Decision toolCalls[${String(
        options.index,
      )}] includes unsupported fields: ${unsupportedToolCallKeys.join(', ')}.`,
    );
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
      `Decision toolCalls[${String(
        options.index,
      )}].input for tool "${name}" must be a JSON object; the tool call's arguments were not one.`,
    );
  }

  if (name === visibleReplyModelToolName) {
    return parseVisibleReplyToolCallInput(input, options.index);
  }

  // The plugin's contract is the host's check; here the call only has to cross
  // the JSON boundary, and a refusal is a malformed tool call, not a failure.
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
    return rejectToolCall(
      `visible_reply input includes unsupported fields: ${unsupportedInputKeys.join(
        ', ',
      )}.`,
    );
  }

  const scrubbedText = scrubReasoningBlocks(text);

  if (scrubbedText.status === 'rejected') {
    return rejectToolCall(
      'visible_reply text contains an unterminated reasoning block.',
    );
  }

  // Normalized here so what the model said, what the person sees, and what
  // the log holds are one text; the commit re-normalizes to the same value.
  try {
    return {
      status: 'accepted',
      toolCall: createVisibleReplyModelToolCall(
        normalizeVisibleMessageText(scrubbedText.text),
      ),
    };
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      return rejectToolCall('visible_reply text must not be empty.');
    }

    throw error;
  }
}

function createExecutionRoleModelDecisionResult(
  toolCalls: readonly ModelToolCall[],
  text: string | undefined,
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: Object.freeze({
      version: roleModelDecisionContractVersion,
      toolCalls: Object.freeze(toolCalls.map(freezeExecutionModelToolCall)),
      ...(text === undefined ? {} : {text}),
    } satisfies CharacterDecision),
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
    result: createMalformedOutputResult(details),
  };
}

function createMalformedOutputResult(
  details: string,
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelMalformedOutputRejectionReason,
    details,
  );
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
