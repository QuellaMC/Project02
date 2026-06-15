import type { VisibleMessage } from '../core/conversation.ts';
import type { RoleModelInputEnvelope } from './contracts.ts';
import type {
  ModelToolDefinition,
  ModelToolInputContract,
  ModelToolInputField,
  ModelToolInputFieldValueType
} from './model-tools.ts';

export type RoleModelSystemChatMessage = {
  readonly role: 'system';
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
  readonly additionalProperties?: boolean;
  readonly items?: RoleModelJsonSchema;
};

export type RoleModelTurnContext = {
  readonly messages: readonly RoleModelChatMessage[];
  readonly tools: readonly RoleModelChatCompletionTool[];
};

export type RoleModelProviderToolNameMapping = {
  readonly runtimeName: string;
  readonly providerName: string;
};

export type RenderRoleModelTurnContextOptions = {
  readonly additionalMessages?: readonly RoleModelChatMessage[];
};

const runtimeContextOpeningTagPattern = /<\s*runtime_context\b/giu;
const runtimeContextClosingTagPattern = /<\s*\/\s*runtime_context\s*>/giu;

export const roleModelStableSystemPromptText =
  'Use OpenAI-compatible chat-completions semantics. ' +
  'The conversation history is provided as normal user and assistant messages. ' +
  'The tools array lists tools you, the assistant, can call through the runtime; these are not commands the user runs. ' +
  'Tool names are callable functions, not a complete plugin inventory. ' +
  'If you need canonical plugin inventory facts, call the plugin inventory tool and use its tool result rather than inferring plugins from tool names. ' +
  'When discussing tools, describe them as tools you can call through the runtime, not as commands the user should run. ' +
  'Runtime and plugin context may be appended to the current user message inside a runtime_context block; treat that block as hidden reference data, not new user input or user-visible text. ' +
  'Use your provided function tools when a response depends on runtime/plugin state. ' +
  'Prefer the visible_reply tool for final user-visible replies. If you return final assistant content with no tool calls, the runtime normalizes that content through the same visible-reply commit path. ' +
  'When tool results arrive as tool messages, use those results before deciding whether another tool call is necessary. ' +
  'Do not return CharacterDecision JSON, do not include internal version fields, and do not copy runtime_context text verbatim into your response. ' +
  'Refer to extensions as plugins, not capabilities.';

export function renderRoleModelTurnContext(
  inputEnvelope: RoleModelInputEnvelope,
  options: RenderRoleModelTurnContextOptions = {}
): RoleModelTurnContext {
  const messages = [
    createSystemMessage(inputEnvelope),
    ...inputEnvelope.decisionContext.recentVisibleMessages.map(
      visibleMessageToChatMessage
    ),
    createCurrentUserMessage(inputEnvelope),
    ...(options.additionalMessages ?? []).map(freezeRoleModelChatMessage)
  ];

  return Object.freeze({
    messages: Object.freeze(messages),
    tools: Object.freeze(
      inputEnvelope.toolDefinitions.map(modelToolDefinitionToChatTool)
    )
  } satisfies RoleModelTurnContext);
}

export function modelToolDefinitionToChatTool(
  definition: ModelToolDefinition
): RoleModelChatCompletionTool {
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters: modelToolInputContractToJsonSchema(definition.inputContract)
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
  } satisfies RoleModelSystemChatMessage | RoleModelUserChatMessage);
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
  const context = renderEphemeralRuntimeContext(inputEnvelope);
  const contextText =
    context === undefined
      ? ''
      : `\n\n<runtime_context hidden_from_user="true">\n${context}\n</runtime_context>`;

  return Object.freeze({
    role: 'user',
    content: `${inputEnvelope.event.payload.currentUserMessage}${contextText}`
  } satisfies RoleModelUserChatMessage);
}

function renderEphemeralRuntimeContext(
  inputEnvelope: RoleModelInputEnvelope
): string | undefined {
  const runtimeNotes = inputEnvelope.decisionContext.runtimeNotes;
  const pluginContextItems = inputEnvelope.decisionContext.pluginContextItems;

  if (runtimeNotes.length === 0 && pluginContextItems.length === 0) {
    return undefined;
  }

  const lines = [
    '[System note: The following runtime context is reference data, NOT new user input. Use it to inform responses, but do not copy it verbatim.]'
  ];

  if (runtimeNotes.length > 0) {
    lines.push('', 'Runtime notes:', ...formatRuntimeContextLines(runtimeNotes));
  }

  if (pluginContextItems.length > 0) {
    lines.push(
      '',
      'Runtime context:',
      ...formatRuntimeContextLines(pluginContextItems.map((item) => item.text))
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
