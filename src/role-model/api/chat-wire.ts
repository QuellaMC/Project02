import type {ModelToolInputContract} from './model-tools.ts';

export type RoleModelSystemChatMessage = {
  readonly role: 'system';
  readonly content: string;
};

export type RoleModelDeveloperChatMessage = {
  readonly role: 'developer';
  readonly content: string;
};

export type RoleModelUserChatMessage = {
  readonly role: 'user';
  readonly content: string;
};

export type RoleModelAssistantChatMessage = {
  readonly role: 'assistant';
  readonly content: string | null;
  readonly tool_calls?: readonly RoleModelChatToolCall[];
};

export type RoleModelToolChatMessage = {
  readonly role: 'tool';
  readonly content: string;
  readonly tool_call_id: string;
};

export type RoleModelChatMessage =
  | RoleModelSystemChatMessage
  | RoleModelDeveloperChatMessage
  | RoleModelUserChatMessage
  | RoleModelAssistantChatMessage
  | RoleModelToolChatMessage;

export type RoleModelChatToolCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
};

// Parameters are the input contract itself; there is no wire-side translation.
export type RoleModelChatCompletionTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ModelToolInputContract;
    readonly strict?: true;
  };
};

export type RoleModelProviderToolNameMapping = {
  readonly runtimeName: string;
  readonly providerName: string;
};

export type RoleModelProviderCapabilities = {
  readonly supportsNativeTools: boolean;
  readonly supportsDeveloperOrSystemContext: boolean;
  readonly preferredModelContextRole: 'developer' | 'system';
  readonly supportsStrictToolSchema: boolean;
  readonly supportsReasoning: boolean;
  readonly reasoningParameterStyle: 'none' | 'nvidia';
  readonly requiresReasoningBlockRoundTrip: boolean;
  readonly supportsToolChoice: boolean;
  readonly supportsParallelToolCalls: boolean;
};

export function freezeRoleModelChatMessage(
  message: RoleModelChatMessage,
): RoleModelChatMessage {
  if (message.role === 'assistant') {
    return Object.freeze({
      role: 'assistant',
      content: message.content,
      ...(message.tool_calls === undefined
        ? {}
        : {
            tool_calls: Object.freeze(
              message.tool_calls.map(freezeRoleModelChatToolCall),
            ),
          }),
    } satisfies RoleModelAssistantChatMessage);
  }

  if (message.role === 'tool') {
    return Object.freeze({
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id,
    } satisfies RoleModelToolChatMessage);
  }

  return Object.freeze({
    role: message.role,
    content: message.content,
  } satisfies
    | RoleModelSystemChatMessage
    | RoleModelDeveloperChatMessage
    | RoleModelUserChatMessage);
}

export function freezeRoleModelChatToolCall(
  call: RoleModelChatToolCall,
): RoleModelChatToolCall {
  return Object.freeze({
    id: call.id,
    type: 'function',
    function: Object.freeze({
      name: call.function.name,
      arguments: call.function.arguments,
    }),
  } satisfies RoleModelChatToolCall);
}
