import {isJsonRecord} from '../../shared/json-boundary.ts';
import {
  freezeRoleModelChatMessage,
  type RoleModelChatCompletionTool,
  type RoleModelChatMessage,
  type RoleModelProviderToolNameMapping,
} from './chat-wire.ts';
import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import type {RuntimePluginJsonValue} from '../../plugins/api/index.ts';
import type {
  RoleModelProviderExchangeSnapshot,
  RoleModelProviderMetadata,
} from './contracts.ts';

export function parseRoleModelProviderExchangeSnapshot(
  value: unknown,
): RoleModelProviderExchangeSnapshot | undefined {
  if (!isRoleModelProviderExchangeSnapshot(value)) {
    return undefined;
  }

  return freezeRoleModelProviderExchangeSnapshot(value);
}

export function freezeRoleModelProviderExchangeSnapshot(
  snapshot: RoleModelProviderExchangeSnapshot,
): RoleModelProviderExchangeSnapshot {
  const boundedSnapshot = createJsonBoundarySnapshot(snapshot, {
    field: 'Role-model provider exchange',
    redact: true,
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
        : {model: snapshot.provider.model}),
      ...(snapshot.provider.endpoint === undefined
        ? {}
        : {endpoint: snapshot.provider.endpoint}),
    }),
    capabilities: Object.freeze({...snapshot.capabilities}),
    reasoning: Object.freeze({
      mode: snapshot.reasoning.mode,
      params: freezeRuntimePluginJsonValue(snapshot.reasoning.params),
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
    ...(snapshot.toolChoice === undefined
      ? {}
      : {toolChoice: freezeRuntimePluginJsonValue(snapshot.toolChoice)}),
    ...(snapshot.parallelToolCalls === undefined
      ? {}
      : {parallelToolCalls: snapshot.parallelToolCalls}),
    requestBody: freezeRuntimePluginJsonValue(snapshot.requestBody),
    ...(snapshot.rawFinishReason === undefined
      ? {}
      : {
          rawFinishReason: freezeRuntimePluginJsonValue(
            snapshot.rawFinishReason,
          ),
        }),
    ...(snapshot.finishReason === undefined
      ? {}
      : {finishReason: snapshot.finishReason}),
    ...(snapshot.usage === undefined
      ? {}
      : {usage: freezeRuntimePluginJsonValue(snapshot.usage)}),
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
    ...(snapshot.responseBody === undefined
      ? {}
      : {responseBody: freezeRuntimePluginJsonValue(snapshot.responseBody)}),
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
    isRuntimePluginJsonValue(value['requestBody']) &&
    Array.isArray(nativeToolResultMessages) &&
    nativeToolResultMessages.every(isRoleModelProviderExchangeChatMessage)
  );
}

function isOptionalRoleModelProviderExchangeSnapshot(
  value: Readonly<Record<string, unknown>>,
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
        value['nativeAssistantMessage'],
      )) &&
    isOptionalRuntimePluginJsonValue(value['responseBody']) &&
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
    return value.every(item => isRuntimePluginJsonValue(item, depth + 1));
  }

  return (
    isJsonRecord(value) &&
    Object.values(value).every(item =>
      isRuntimePluginJsonValue(item, depth + 1),
    )
  );
}

function freezeProviderExchangeTool(
  tool: RoleModelChatCompletionTool,
): RoleModelChatCompletionTool {
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: tool.function.name,
      description: tool.function.description,
      parameters: freezeRuntimePluginJsonValue(
        tool.function.parameters,
      ) as RoleModelChatCompletionTool['function']['parameters'],
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

function freezeRuntimePluginJsonObject(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, RuntimePluginJsonValue>> {
  const snapshot: Record<string, RuntimePluginJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    snapshot[key] = freezeRuntimePluginJsonValue(item);
  }

  return Object.freeze(snapshot);
}

function freezeRuntimePluginJsonValue(value: unknown): RuntimePluginJsonValue {
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

  throw new TypeError(
    'Role-model tool observation values must be JSON-compatible.',
  );
}
