import {
  createJsonBoundarySnapshot,
  defaultJsonBoundaryLimits,
  isJsonRecord,
  type JsonBoundaryLimits,
} from '../../shared/json-boundary.ts';
import {
  freezeRoleModelChatMessage,
  type RoleModelChatCompletionTool,
  type RoleModelChatMessage,
  type RoleModelProviderToolNameMapping,
} from './chat-wire.ts';
import type {
  RoleModelProviderExchangeSnapshot,
  RoleModelProviderMetadata,
} from './contracts.ts';

/**
 * The exchange is the wire as sent and received, so it weighs what the prompt
 * weighs: bounded by the context window, not by a plugin's output. These
 * limits stop only a runaway shape; a prompt the window admits must always
 * be recordable, or the evidence would fail the very turn it describes.
 */
export const roleModelProviderExchangeJsonBoundaryLimits = Object.freeze({
  ...defaultJsonBoundaryLimits,
  maxEntriesPerContainer: 65_536,
  maxNodes: 1_048_576,
  maxStringBytes: 8 * 1_024 * 1_024,
  maxTotalStringBytes: 64 * 1_024 * 1_024,
} satisfies JsonBoundaryLimits);

export function parseRoleModelProviderExchangeSnapshot(
  value: unknown,
): RoleModelProviderExchangeSnapshot | undefined {
  try {
    return freezeRoleModelProviderExchangeSnapshot(value);
  } catch {
    return undefined;
  }
}

export function freezeRoleModelProviderExchangeSnapshot(
  value: unknown,
): RoleModelProviderExchangeSnapshot {
  // Normalization runs first, so the shape check below judges JSON leaves only.
  const boundedValue = createJsonBoundarySnapshot(value, {
    field: 'Role-model provider exchange',
    redact: true,
    limits: roleModelProviderExchangeJsonBoundaryLimits,
  });

  if (!isRoleModelProviderExchangeSnapshot(boundedValue)) {
    throw new TypeError('Role-model provider exchange is malformed.');
  }

  const snapshot: RoleModelProviderExchangeSnapshot = boundedValue;

  return Object.freeze({
    provider: Object.freeze({
      name: snapshot.provider.name,
      ...(snapshot.provider.model === undefined
        ? {}
        : {model: snapshot.provider.model}),
      ...(snapshot.provider.endpoint === undefined
        ? {}
        : {endpoint: snapshot.provider.endpoint}),
    }),
    capabilities: Object.freeze({...snapshot.capabilities}),
    reasoning: Object.freeze({
      mode: snapshot.reasoning.mode,
      params: snapshot.reasoning.params,
    }),
    renderedMessages: Object.freeze(
      snapshot.renderedMessages.map(freezeRoleModelChatMessage),
    ),
    renderedTools: Object.freeze(
      snapshot.renderedTools.map(freezeProviderExchangeTool),
    ),
    toolNameMappings: Object.freeze(
      snapshot.toolNameMappings.map(mapping =>
        Object.freeze({
          runtimeName: mapping.runtimeName,
          providerName: mapping.providerName,
        } satisfies RoleModelProviderToolNameMapping),
      ),
    ),
    requestBody: snapshot.requestBody,
    ...(snapshot.finishReason === undefined
      ? {}
      : {finishReason: snapshot.finishReason}),
    ...(snapshot.usage === undefined ? {} : {usage: snapshot.usage}),
    ...(snapshot.nativeAssistantMessage === undefined
      ? {}
      : {
          nativeAssistantMessage: freezeRoleModelChatMessage(
            snapshot.nativeAssistantMessage,
          ),
        }),
    nativeToolResultMessages: Object.freeze(
      snapshot.nativeToolResultMessages.map(freezeRoleModelChatMessage),
    ),
    ...(snapshot.outputNormalization === undefined
      ? {}
      : {
          outputNormalization: Object.freeze({
            source: snapshot.outputNormalization.source,
            committed: false,
          }),
        }),
  } satisfies RoleModelProviderExchangeSnapshot);
}

function isRoleModelProviderExchangeSnapshot(
  value: unknown,
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
  value: Readonly<Record<string, unknown>>,
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
    value['requestBody'] !== undefined &&
    Array.isArray(nativeToolResultMessages) &&
    nativeToolResultMessages.every(isRoleModelProviderExchangeChatMessage)
  );
}

function isOptionalRoleModelProviderExchangeSnapshot(
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    isOptionalString(value['finishReason']) &&
    (value['nativeAssistantMessage'] === undefined ||
      isRoleModelProviderExchangeChatMessage(
        value['nativeAssistantMessage'],
      )) &&
    (value['outputNormalization'] === undefined ||
      isRoleModelProviderExchangeOutputNormalization(
        value['outputNormalization'],
      ))
  );
}

function isRoleModelProviderExchangeProvider(value: unknown): boolean {
  if (!isJsonRecord(value)) {
    return false;
  }

  return (
    value['name'] === 'nvidia' &&
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
    value['mode'] === 'enabled' &&
    value['params'] !== undefined
  );
}

function isRoleModelProviderExchangeChatMessage(
  value: unknown,
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
  value: unknown,
): value is RoleModelChatCompletionTool {
  if (!isJsonRecord(value) || value['type'] !== 'function') {
    return false;
  }

  const toolFunction = value['function'];

  return (
    isJsonRecord(toolFunction) &&
    typeof toolFunction['name'] === 'string' &&
    typeof toolFunction['description'] === 'string' &&
    // Not re-judged here: the manifest gate already judged the contract.
    isJsonRecord(toolFunction['parameters']) &&
    (toolFunction['strict'] === undefined || toolFunction['strict'] === true)
  );
}

function isRoleModelProviderToolNameMapping(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    typeof value['runtimeName'] === 'string' &&
    typeof value['providerName'] === 'string'
  );
}

function isRoleModelProviderExchangeOutputNormalization(
  value: unknown,
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

function freezeProviderExchangeTool(
  tool: RoleModelChatCompletionTool,
): RoleModelChatCompletionTool {
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      ...(tool.function.strict === undefined ? {} : {strict: true}),
    }),
  } satisfies RoleModelChatCompletionTool);
}

function recordableMetadataNumber(
  value: number | undefined,
): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

export function freezeProviderMetadata(
  metadata: RoleModelProviderMetadata,
): RoleModelProviderMetadata {
  // Dropped rather than recorded as a number that would read back as null.
  const messageCount = recordableMetadataNumber(metadata.request?.messageCount);
  const status = recordableMetadataNumber(metadata.response?.status);

  return Object.freeze({
    provider: metadata.provider,
    ...(metadata.model === undefined ? {} : {model: metadata.model}),
    ...(metadata.request === undefined
      ? {}
      : {
          request: Object.freeze({
            ...(metadata.request.endpoint === undefined
              ? {}
              : {endpoint: metadata.request.endpoint}),
            ...(messageCount === undefined ? {} : {messageCount}),
            stream: false,
          }),
        }),
    ...(metadata.response === undefined
      ? {}
      : {
          response: Object.freeze({
            ...(status === undefined ? {} : {status}),
          }),
        }),
    ...(metadata.error === undefined
      ? {}
      : {
          error: Object.freeze({
            code: metadata.error.code,
            message: metadata.error.message,
          }),
        }),
  } satisfies RoleModelProviderMetadata);
}
