import type { VisibleMessage } from '../core/conversation.ts';
import type { RoleModelInputEnvelope } from './contracts.ts';
import type {
  ModelToolDefinition,
  ModelToolInputContract,
  ModelToolInputField,
  ModelToolInputFieldValueType,
  ModelToolJsonSchema,
  ModelToolJsonSchemaType,
  ModelToolObjectJsonSchema
} from './model-tools.ts';

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

export type RoleModelChatCompletionTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: RoleModelObjectJsonSchema;
    readonly strict?: true;
  };
};

export type RoleModelObjectJsonSchema = {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, RoleModelJsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
};

export type RoleModelJsonSchema = {
  readonly type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, RoleModelJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: RoleModelJsonSchema;
};

export type RoleModelPromptFrameKind =
  | 'system_protocol'
  | 'developer_protocol'
  | 'model_only_runtime_context'
  | 'visible_transcript'
  | 'current_user_message'
  | 'native_assistant_message'
  | 'native_tool_result_message';

export type RoleModelPromptFrame = {
  readonly kind: RoleModelPromptFrameKind;
  readonly role: RoleModelChatMessage['role'];
  readonly content: string | null;
  readonly modelOnly: boolean;
  readonly message?: RoleModelChatMessage;
};

export type RoleModelTurnContext = {
  readonly frames: readonly RoleModelPromptFrame[];
  readonly messages: readonly RoleModelChatMessage[];
  readonly tools: readonly RoleModelChatCompletionTool[];
};

export type RoleModelProviderToolNameMapping = {
  readonly runtimeName: string;
  readonly providerName: string;
};

export type RenderRoleModelTurnContextOptions = {
  readonly additionalMessages?: readonly RoleModelChatMessage[];
  readonly outputMode?: 'native_tools' | 'json_fallback';
  readonly capabilities?: RoleModelProviderCapabilities;
};

export type RoleModelPreparedRequest = RoleModelTurnContext & {
  readonly outputMode: 'native_tools' | 'json_fallback';
  readonly capabilities: RoleModelProviderCapabilities;
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

const runtimeContextOpeningTagPattern = /<\s*runtime_context\b/giu;
const runtimeContextClosingTagPattern = /<\s*\/\s*runtime_context\s*>/giu;

export const defaultRoleModelProviderCapabilities = Object.freeze({
  supportsNativeTools: true,
  supportsDeveloperOrSystemContext: true,
  preferredModelContextRole: 'system',
  supportsStrictToolSchema: true,
  supportsReasoning: false,
  reasoningParameterStyle: 'none',
  requiresReasoningBlockRoundTrip: false,
  supportsToolChoice: true,
  supportsParallelToolCalls: true
} satisfies RoleModelProviderCapabilities);

export const roleModelStableSystemPromptText =
  'Use chat-completions semantics. The visible transcript is normal user/assistant conversation. Model-only context is not user text. Refer to extensions as plugins.';

const roleModelNativeToolProtocolPromptText =
  'Use provided function tools when runtime/plugin state is needed. Tools are assistant-owned runtime functions, not user commands. Tool names are callable functions, not a full plugin inventory; call plugin.list for inventory facts. Commit user-visible text by calling visible_reply. Terminal assistant content with no tool calls may be normalized by the runtime.';

const roleModelJsonFallbackProtocolPromptText =
  'Return one CharacterDecision JSON object with ordered toolCalls. Use visible_reply for user-visible text. Do not include runtime input fields or internal version fields.';

export function renderRoleModelTurnContext(
  inputEnvelope: RoleModelInputEnvelope,
  options: RenderRoleModelTurnContextOptions = {}
): RoleModelTurnContext {
  return prepareRoleModelRequest(inputEnvelope, options);
}

export function prepareRoleModelRequest(
  inputEnvelope: RoleModelInputEnvelope,
  options: RenderRoleModelTurnContextOptions = {}
): RoleModelPreparedRequest {
  const capabilities =
    options.capabilities ?? defaultRoleModelProviderCapabilities;
  const outputMode = options.outputMode ?? 'native_tools';
  const frames = createRoleModelPromptFrames(inputEnvelope, {
    additionalMessages: options.additionalMessages ?? [],
    capabilities,
    outputMode
  });
  const messages = frames.flatMap((frame) =>
    frame.message === undefined ? [] : [frame.message]
  );

  return Object.freeze({
    outputMode,
    capabilities,
    frames,
    messages: Object.freeze(messages),
    tools: Object.freeze(
      inputEnvelope.toolDefinitions.map((definition) =>
        modelToolDefinitionToChatTool(definition, {
          strict: capabilities.supportsStrictToolSchema
        })
      )
    )
  } satisfies RoleModelPreparedRequest);
}

export function modelToolDefinitionToChatTool(
  definition: ModelToolDefinition,
  options: { readonly strict?: boolean } = {}
): RoleModelChatCompletionTool {
  const parameters = modelToolInputContractToJsonSchema(definition.inputContract);
  const strict =
    options.strict === true && jsonSchemaSupportsStrictTools(parameters);

  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters,
      ...(strict ? { strict: true } : {})
    })
  } satisfies RoleModelChatCompletionTool);
}

export function createRoleModelProviderToolNameMappings(
  runtimeNames: readonly string[]
): readonly RoleModelProviderToolNameMapping[] {
  const usedProviderNames = new Set<string>();
  const mappings: RoleModelProviderToolNameMapping[] = [];

  for (const runtimeName of runtimeNames) {
    const baseProviderName = roleModelProviderSafeToolName(runtimeName);
    let providerName = baseProviderName;
    let suffix = 1;

    while (usedProviderNames.has(providerName)) {
      suffix += 1;
      providerName = `${baseProviderName}_${String(suffix)}`;
    }

    usedProviderNames.add(providerName);
    mappings.push(
      Object.freeze({
        runtimeName,
        providerName
      } satisfies RoleModelProviderToolNameMapping)
    );
  }

  return Object.freeze(mappings);
}

export function providerToolNameForRuntimeToolName(
  runtimeName: string,
  mappings: readonly RoleModelProviderToolNameMapping[]
): string {
  return (
    mappings.find((mapping) => mapping.runtimeName === runtimeName)
      ?.providerName ?? roleModelProviderSafeToolName(runtimeName)
  );
}

export function runtimeToolNameForProviderToolName(
  providerName: string,
  mappings: readonly RoleModelProviderToolNameMapping[]
): string {
  return (
    mappings.find((mapping) => mapping.providerName === providerName)
      ?.runtimeName ?? providerName
  );
}

function roleModelProviderSafeToolName(runtimeName: string): string {
  const safeName = runtimeName.replaceAll(/[^A-Za-z0-9_-]/gu, '_');

  if (/^[A-Za-z]/u.test(safeName)) {
    return safeName;
  }

  return `tool_${safeName}`;
}

export function freezeRoleModelChatMessage(
  message: RoleModelChatMessage
): RoleModelChatMessage {
  if (message.role === 'assistant') {
    return Object.freeze({
      role: 'assistant',
      content: message.content,
      ...(message.tool_calls === undefined
        ? {}
        : {
            tool_calls: Object.freeze(
              message.tool_calls.map(freezeRoleModelChatToolCall)
            )
          })
    } satisfies RoleModelAssistantChatMessage);
  }

  if (message.role === 'tool') {
    return Object.freeze({
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id
    } satisfies RoleModelToolChatMessage);
  }

  return Object.freeze({
    role: message.role,
    content: message.content
  } satisfies
    | RoleModelSystemChatMessage
    | RoleModelDeveloperChatMessage
    | RoleModelUserChatMessage);
}

export function freezeRoleModelChatToolCall(
  call: RoleModelChatToolCall
): RoleModelChatToolCall {
  return Object.freeze({
    id: call.id,
    type: 'function',
    function: Object.freeze({
      name: call.function.name,
      arguments: call.function.arguments
    })
  } satisfies RoleModelChatToolCall);
}

function createSystemMessage(
  inputEnvelope: RoleModelInputEnvelope
): RoleModelSystemChatMessage {
  return Object.freeze({
    role: 'system',
    content: `You are ${inputEnvelope.decisionContext.characterSnapshot.displayName}. ${roleModelStableSystemPromptText}`
  } satisfies RoleModelSystemChatMessage);
}

function createRoleModelPromptFrames(
  inputEnvelope: RoleModelInputEnvelope,
  options: {
    readonly additionalMessages: readonly RoleModelChatMessage[];
    readonly capabilities: RoleModelProviderCapabilities;
    readonly outputMode: 'native_tools' | 'json_fallback';
  }
): readonly RoleModelPromptFrame[] {
  const frames: RoleModelPromptFrame[] = [];
  const runtimeContextMessage = createRuntimeContextMessage(
    inputEnvelope,
    options.capabilities
  );

  frames.push(
    createPromptFrame('system_protocol', createSystemMessage(inputEnvelope), true)
  );
  frames.push(createPromptFrame('developer_protocol', createProtocolMessage(options), true));

  if (runtimeContextMessage !== undefined) {
    frames.push(
      createPromptFrame('model_only_runtime_context', runtimeContextMessage, true)
    );
  }

  frames.push(
    ...inputEnvelope.decisionContext.recentVisibleMessages.map((message) =>
      createPromptFrame(
        'visible_transcript',
        visibleMessageToChatMessage(message),
        false
      )
    )
  );
  frames.push(
    createPromptFrame(
      'current_user_message',
      createCurrentUserMessage(inputEnvelope),
      false
    )
  );
  frames.push(
    ...options.additionalMessages.map((message) =>
      createPromptFrame(
        message.role === 'tool'
          ? 'native_tool_result_message'
          : 'native_assistant_message',
        freezeRoleModelChatMessage(message),
        true
      )
    )
  );

  return Object.freeze(frames);
}

function createPromptFrame(
  kind: RoleModelPromptFrameKind,
  message: RoleModelChatMessage,
  modelOnly: boolean
): RoleModelPromptFrame {
  return Object.freeze({
    kind,
    role: message.role,
    content: message.content,
    modelOnly,
    message
  } satisfies RoleModelPromptFrame);
}

function createProtocolMessage(options: {
  readonly capabilities: RoleModelProviderCapabilities;
  readonly outputMode: 'native_tools' | 'json_fallback';
}): RoleModelSystemChatMessage | RoleModelDeveloperChatMessage {
  const content =
    options.outputMode === 'native_tools'
      ? roleModelNativeToolProtocolPromptText
      : roleModelJsonFallbackProtocolPromptText;
  const role = modelOnlyContextRole(options.capabilities);

  return Object.freeze({
    role,
    content
  } satisfies RoleModelSystemChatMessage | RoleModelDeveloperChatMessage);
}

function visibleMessageToChatMessage(
  message: VisibleMessage
): RoleModelUserChatMessage | RoleModelAssistantChatMessage {
  if (message.role === 'user') {
    return Object.freeze({
      role: 'user',
      content: message.text
    } satisfies RoleModelUserChatMessage);
  }

  return Object.freeze({
    role: 'assistant',
    content: message.text
  } satisfies RoleModelAssistantChatMessage);
}

function createCurrentUserMessage(
  inputEnvelope: RoleModelInputEnvelope
): RoleModelUserChatMessage {
  return Object.freeze({
    role: 'user',
    content: inputEnvelope.event.payload.currentUserMessage
  } satisfies RoleModelUserChatMessage);
}

function createRuntimeContextMessage(
  inputEnvelope: RoleModelInputEnvelope,
  capabilities: RoleModelProviderCapabilities
): RoleModelSystemChatMessage | RoleModelDeveloperChatMessage | undefined {
  const context = renderEphemeralRuntimeContext(inputEnvelope);

  if (context === undefined) {
    return undefined;
  }

  const role = modelOnlyContextRole(capabilities);

  return Object.freeze({
    role,
    content: context
  } satisfies RoleModelSystemChatMessage | RoleModelDeveloperChatMessage);
}

function modelOnlyContextRole(
  capabilities: RoleModelProviderCapabilities
): 'developer' | 'system' {
  return capabilities.supportsDeveloperOrSystemContext &&
    capabilities.preferredModelContextRole === 'developer'
    ? 'developer'
    : 'system';
}

function renderEphemeralRuntimeContext(
  inputEnvelope: RoleModelInputEnvelope
): string | undefined {
  const runtimeNotes = inputEnvelope.decisionContext.runtimeNotes;
  const pluginContextItems = inputEnvelope.decisionContext.pluginContextItems;

  if (runtimeNotes.length === 0 && pluginContextItems.length === 0) {
    return undefined;
  }

  const lines = ['Model-only runtime context. This is not user input.'];

  if (runtimeNotes.length > 0) {
    lines.push('runtime_notes:', ...formatRuntimeContextLines(runtimeNotes));
  }

  if (pluginContextItems.length > 0) {
    lines.push(
      'plugin_context:',
      ...formatRuntimeContextLines(
        pluginContextItems.map(
          (item) => `${item.pluginId}/${item.id}: ${item.text}`
        )
      )
    );
  }

  return lines.join('\n');
}

function formatRuntimeContextLines(values: readonly string[]): readonly string[] {
  return Object.freeze(
    values.flatMap((value) => {
      const lines = sanitizeRuntimeContextText(value);
      const [firstLine, ...remainingLines] = lines;

      if (firstLine === undefined) {
        return [];
      }

      return [
        `- ${firstLine}`,
        ...remainingLines.map((line) => `  ${line}`)
      ];
    })
  );
}

function sanitizeRuntimeContextText(value: string): readonly string[] {
  return Object.freeze(
    value
      .replaceAll(runtimeContextOpeningTagPattern, '<runtime-context')
      .replaceAll(runtimeContextClosingTagPattern, '</runtime-context>')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
}

function modelToolInputContractToJsonSchema(
  contract: ModelToolInputContract
): RoleModelObjectJsonSchema {
  if (contract.jsonSchema !== undefined) {
    return modelToolObjectJsonSchemaToRoleModelSchema(contract.jsonSchema);
  }

  const properties: Record<string, RoleModelJsonSchema> = {};
  const required: string[] = [];

  for (const field of contract.fields) {
    properties[field.name] = modelToolInputFieldToJsonSchema(field);

    if (field.required) {
      required.push(field.name);
    }
  }

  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    additionalProperties: contract.additionalFields
  } satisfies RoleModelObjectJsonSchema);
}

function modelToolObjectJsonSchemaToRoleModelSchema(
  schema: ModelToolObjectJsonSchema
): RoleModelObjectJsonSchema {
  const converted = modelToolJsonSchemaToRoleModelSchema(schema);

  return Object.freeze({
    type: 'object',
    properties: Object.freeze(converted.properties ?? {}),
    required: Object.freeze(converted.required ?? []),
    additionalProperties: converted.additionalProperties ?? false
  } satisfies RoleModelObjectJsonSchema);
}

function modelToolJsonSchemaToRoleModelSchema(
  schema: ModelToolJsonSchema
): RoleModelJsonSchema {
  const schemaType = firstModelToolJsonSchemaType(schema.type);

  return Object.freeze({
    ...(schemaType === undefined || schemaType === 'null'
      ? {}
      : { type: schemaType }),
    ...(schema.description === undefined
      ? {}
      : { description: schema.description }),
    ...(schema.enum === undefined
      ? {}
      : { enum: Object.freeze([...schema.enum]) }),
    ...(schema.properties === undefined
      ? {}
      : {
          properties: Object.freeze(
            Object.fromEntries(
              Object.entries(schema.properties).map(([key, value]) => [
                key,
                modelToolJsonSchemaToRoleModelSchema(value)
              ])
            )
          )
        }),
    ...(schema.required === undefined
      ? {}
      : { required: Object.freeze([...schema.required]) }),
    ...(schema.additionalProperties === undefined
      ? {}
      : { additionalProperties: schema.additionalProperties }),
    ...(schema.items === undefined
      ? {}
      : { items: modelToolJsonSchemaToRoleModelSchema(schema.items) })
  } satisfies RoleModelJsonSchema);
}

function firstModelToolJsonSchemaType(
  type: ModelToolJsonSchema['type']
): ModelToolJsonSchemaType | undefined {
  if (type === undefined) {
    return undefined;
  }

  return isModelToolJsonSchemaTypeArray(type) ? type[0] : type;
}

function isModelToolJsonSchemaTypeArray(
  value: NonNullable<ModelToolJsonSchema['type']>
): value is readonly ModelToolJsonSchemaType[] {
  return Array.isArray(value);
}

function modelToolInputFieldToJsonSchema(
  field: ModelToolInputField
): RoleModelJsonSchema {
  return Object.freeze({
    ...(field.valueType === undefined && field.allowedValues === undefined
      ? {}
      : { type: modelToolInputFieldJsonSchemaType(field) }),
    description: field.description,
    ...(field.allowedValues === undefined
      ? {}
      : { enum: Object.freeze([...field.allowedValues]) })
  } satisfies RoleModelJsonSchema);
}

function modelToolInputFieldJsonSchemaType(
  field: ModelToolInputField
): NonNullable<RoleModelJsonSchema['type']> {
  if (field.allowedValues !== undefined) {
    return 'string';
  }

  return modelToolValueTypeToJsonSchemaType(field.valueType);
}

function modelToolValueTypeToJsonSchemaType(
  valueType: ModelToolInputFieldValueType | undefined
): NonNullable<RoleModelJsonSchema['type']> {
  if (valueType === undefined) {
    return 'string';
  }

  return valueType;
}

function jsonSchemaSupportsStrictTools(schema: RoleModelJsonSchema): boolean {
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      return false;
    }

    return Object.values(schema.properties ?? {}).every(
      jsonSchemaSupportsStrictTools
    );
  }

  if (schema.type === 'array' && schema.items !== undefined) {
    return jsonSchemaSupportsStrictTools(schema.items);
  }

  return true;
}
