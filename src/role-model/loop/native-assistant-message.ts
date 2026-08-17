import {isDeepStrictEqual} from 'node:util';

import type {
  RoleModelAssistantChatMessage,
  RoleModelChatToolCall,
  RoleModelProviderToolNameMapping,
} from '../api/chat-wire.ts';
import type {CharacterDecision} from '../api/contracts.ts';
import {
  visibleReplyModelToolName,
  type ModelToolCall,
} from '../api/model-tools.ts';
import {runtimeToolNameForProviderToolName} from '../prompt/tool-wire.ts';
import {
  executableModelToolCalls,
  parseRoleModelExecutionDecision,
} from './decision-parser.ts';

/**
 * The provider's own assistant message is replayed to it only when it says
 * exactly what the accepted decision says: valid call ids, one native call
 * per executable call in order, arguments that parse, and the whole
 * re-parsing to the same decision.
 */
export function nativeAssistantMessageForAcceptedDecision(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage | undefined;
  readonly decision: CharacterDecision;
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): RoleModelAssistantChatMessage | undefined {
  const nativeToolCalls = options.assistantMessage?.tool_calls;

  if (options.assistantMessage === undefined || nativeToolCalls === undefined) {
    return undefined;
  }

  if (!nativeToolCallIdsAreValid(nativeToolCalls)) {
    return undefined;
  }

  const normalizedNativeToolCalls = normalizeNativeAssistantToolCalls({
    nativeToolCalls,
    expectedExecutableToolCalls: executableModelToolCalls(
      options.decision.toolCalls,
    ),
    toolNameMappings: options.toolNameMappings,
  });

  if (normalizedNativeToolCalls === undefined) {
    return undefined;
  }

  const nativeDecisionResult = parseRoleModelExecutionDecision(
    JSON.stringify({toolCalls: normalizedNativeToolCalls}),
  );

  if (
    nativeDecisionResult.status === 'rejected' ||
    !isDeepStrictEqual(
      nativeDecisionResult.decision.toolCalls,
      options.decision.toolCalls,
    )
  ) {
    return undefined;
  }

  return options.assistantMessage;
}

function nativeToolCallIdsAreValid(
  nativeToolCalls: readonly RoleModelChatToolCall[],
): boolean {
  const nativeToolCallIds = new Set<string>();

  for (const nativeToolCall of nativeToolCalls) {
    if (
      nativeToolCall.id.length === 0 ||
      nativeToolCallIds.has(nativeToolCall.id)
    ) {
      return false;
    }

    nativeToolCallIds.add(nativeToolCall.id);
  }

  return true;
}

function normalizeNativeAssistantToolCalls(options: {
  readonly nativeToolCalls: readonly RoleModelChatToolCall[];
  readonly expectedExecutableToolCalls: readonly ModelToolCall[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): readonly Readonly<{name: string; input: unknown}>[] | undefined {
  const normalizedNativeToolCalls: Array<
    Readonly<{name: string; input: unknown}>
  > = [];
  let executableIndex = 0;

  for (const nativeToolCall of options.nativeToolCalls) {
    const runtimeToolName = runtimeToolNameForProviderToolName(
      nativeToolCall.function.name,
      options.toolNameMappings,
    );

    if (runtimeToolName !== visibleReplyModelToolName) {
      const expected = options.expectedExecutableToolCalls[executableIndex];

      if (expected === undefined || expected.name !== runtimeToolName) {
        return undefined;
      }

      executableIndex += 1;
    }

    let input: unknown;

    try {
      input = JSON.parse(nativeToolCall.function.arguments);
    } catch {
      return undefined;
    }

    normalizedNativeToolCalls.push(
      Object.freeze({name: runtimeToolName, input}),
    );
  }

  return executableIndex === options.expectedExecutableToolCalls.length
    ? normalizedNativeToolCalls
    : undefined;
}
