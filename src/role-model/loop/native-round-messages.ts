import {visibleReplyModelToolName} from '../api/model-tools.ts';
import {
  freezeRoleModelChatMessage,
  type RoleModelAssistantChatMessage,
  type RoleModelChatMessage,
  type RoleModelProviderToolNameMapping,
  type RoleModelToolChatMessage,
} from '../api/chat-wire.ts';
import {
  createNativeMissingToolResultContent,
  createNativeToolResultMessageContent,
  createNativeVisibleReplyToolResultContent,
  runtimeToolNameForProviderToolName,
} from '../prompt/tool-wire.ts';
import type {RoleModelPluginToolRoutingEvidence} from './routing-rejections.ts';

export function appendNativeToolRoundMessages(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage | undefined;
  readonly previousMessages: readonly RoleModelChatMessage[];
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): readonly RoleModelChatMessage[] {
  if (options.assistantMessage === undefined || options.results.length === 0) {
    return options.previousMessages;
  }

  return Object.freeze([
    ...options.previousMessages,
    freezeRoleModelChatMessage(options.assistantMessage),
    ...createNativeToolResultMessages({
      assistantMessage: options.assistantMessage,
      results: options.results,
      toolNameMappings: options.toolNameMappings,
    }),
  ]);
}

function createNativeToolResultMessages(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage;
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): readonly RoleModelToolChatMessage[] {
  let executableResultIndex = 0;
  const nativeToolCalls = options.assistantMessage.tool_calls ?? [];

  if (nativeToolCalls.length === 0) {
    return Object.freeze(
      options.results.map(result =>
        Object.freeze({
          role: 'tool',
          tool_call_id: result.callId,
          content: JSON.stringify(
            createNativeToolResultMessageContent(nativeToolResultCall(result)),
          ),
        } satisfies RoleModelToolChatMessage),
      ),
    );
  }

  return Object.freeze(
    nativeToolCalls.map(toolCall => {
      const runtimeToolName = runtimeToolNameForProviderToolName(
        toolCall.function.name,
        options.toolNameMappings,
      );

      if (runtimeToolName === visibleReplyModelToolName) {
        return Object.freeze({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(createNativeVisibleReplyToolResultContent()),
        } satisfies RoleModelToolChatMessage);
      }

      const result = options.results[executableResultIndex];

      executableResultIndex += 1;

      return Object.freeze({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(
          result === undefined
            ? createNativeMissingToolResultContent(runtimeToolName)
            : createNativeToolResultMessageContent(
                nativeToolResultCall(result),
              ),
        ),
      } satisfies RoleModelToolChatMessage);
    }),
  );
}

function nativeToolResultCall(result: RoleModelPluginToolRoutingEvidence): {
  readonly pluginId: string;
  readonly toolName: string;
  readonly result: RoleModelPluginToolRoutingEvidence['result'];
} {
  return {
    pluginId: result.call.pluginId,
    toolName: result.call.toolName,
    result: result.result,
  };
}
