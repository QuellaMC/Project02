import {isJsonRecord} from '../../shared/json-boundary.ts';
import {
  roleModelProviderErrorRejectionReason,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
} from '../api/contracts.ts';
import {
  freezeRoleModelProviderExchangeSnapshot,
  roleModelProviderExchangeJsonBoundaryLimits,
} from '../api/provider-exchange.ts';
import {
  visibleReplyModelToolName,
  type ModelToolCall,
} from '../api/model-tools.ts';
import type {
  RoleModelAssistantChatMessage,
  RoleModelChatCompletionTool,
  RoleModelChatMessage,
  RoleModelChatToolCall,
  RoleModelProviderCapabilities,
  RoleModelProviderToolNameMapping,
} from '../api/chat-wire.ts';
import {
  defaultRoleModelProviderCapabilities,
  type RoleModelTurnContext,
} from '../prompt/render.ts';
import {
  createRoleModelProviderToolNameMappings,
  providerToolNameForRuntimeToolName,
  runtimeToolNameForProviderToolName,
} from '../prompt/tool-wire.ts';
import type {
  RoleModelAdapter,
  RoleModelAdapterRawOutput,
  RoleModelNativeToolCallArgumentError,
} from '../api/adapter.ts';
import {
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
} from '../../plugins/api/index.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
} from '../../shared/json-boundary.ts';
import {scrubReasoningBlocks} from '../api/reasoning.ts';

const nvidiaRoleModelProviderName = 'nvidia';
export const defaultNvidiaRoleModelReasoningBudget = 16384;
export const nvidiaApiKeyEnvName = 'NVIDIA_API_KEY';
export const nvidiaModelEnvName = 'NVIDIA_MODEL';

export const nvidiaRoleModelProviderCapabilities = Object.freeze({
  ...defaultRoleModelProviderCapabilities,
  supportsReasoning: true,
  reasoningParameterStyle: 'nvidia',
  requiresReasoningBlockRoundTrip: false,
} satisfies RoleModelProviderCapabilities);

export type NvidiaRoleModelProviderConfig = {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly requestTimeoutMs?: number;
};

type NvidiaRoleModelProviderEnvironment = {
  readonly NVIDIA_API_KEY?: string;
  readonly NVIDIA_MODEL?: string;
};

type NvidiaChatCompletionMessage = RoleModelChatMessage;
type NvidiaChatCompletionTool = RoleModelChatCompletionTool;

export {
  createNvidiaRequestDeadline,
  defaultNvidiaRoleModelRequestTimeoutMs,
  defaultNvidiaTransportRetryDelaysMs,
  NvidiaRequestTimeoutError,
  type NvidiaFetchClient,
  type NvidiaFetchRequest,
  type NvidiaFetchResponse,
} from './nvidia-transport.ts';
import {
  terminalNvidiaFinishReasons,
  createNvidiaRequestDeadline,
  defaultFetchClient,
  normalizeNvidiaRequestTimeoutMs,
  normalizeNvidiaTransportRetryDelays,
  NvidiaRequestTimeoutError,
  performNvidiaTransportRequest,
  redactProviderSecret,
  type NvidiaFetchClient,
} from './nvidia-transport.ts';
import {createNvidiaTextCompletion} from './nvidia-completion.ts';

export type CreateNvidiaRoleModelProviderAdapterOptions =
  NvidiaRoleModelProviderConfig & {
    readonly fetchClient?: NvidiaFetchClient;
    readonly transportRetryDelaysMs?: readonly number[];
  };

type NvidiaProviderErrorCode =
  | 'empty_output'
  | 'http_error'
  | 'malformed_response'
  | 'missing_api_key'
  | 'provider_error'
  | 'request_timeout';

export function createNvidiaRoleModelProviderConfigFromEnv(
  env: NvidiaRoleModelProviderEnvironment = process.env,
): NvidiaRoleModelProviderConfig {
  const apiKey = optionalNvidiaProviderEnvValue(env.NVIDIA_API_KEY);
  const model = optionalNvidiaProviderEnvValue(env.NVIDIA_MODEL);

  return Object.freeze({
    ...(apiKey === undefined ? {} : {apiKey}),
    ...(model === undefined ? {} : {model}),
  } satisfies NvidiaRoleModelProviderConfig);
}

export function createNvidiaRoleModelProviderAdapter(
  options: CreateNvidiaRoleModelProviderAdapterOptions = {},
): RoleModelAdapter {
  const endpoint =
    options.endpoint ?? 'https://integrate.api.nvidia.com/v1/chat/completions';
  const model = options.model ?? 'nvidia/nemotron-3-nano-30b-a3b';
  const fetchClient = options.fetchClient ?? defaultFetchClient;
  const requestTimeoutMs = normalizeNvidiaRequestTimeoutMs(
    options.requestTimeoutMs,
  );
  const transportRetryDelaysMs = normalizeNvidiaTransportRetryDelays(
    options.transportRetryDelaysMs,
  );

  return Object.freeze({
    completeText: createNvidiaTextCompletion({
      ...(options.apiKey === undefined ? {} : {apiKey: options.apiKey}),
      endpoint,
      model,
      fetchClient,
      requestTimeoutMs,
      transportRetryDelaysMs,
    }),
    async invoke(inputEnvelope, invocation) {
      if (options.apiKey === undefined || options.apiKey.length === 0) {
        return createProviderRejectedOutput({
          code: 'missing_api_key',
          endpoint,
          message: `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
          model,
        });
      }

      const turnContext = invocation.turnContext;
      const toolNameMappings =
        createNvidiaProviderToolNameMappings(turnContext);
      const messages = renderNvidiaMessagesForTurnContext(
        turnContext,
        toolNameMappings,
      );
      const tools = renderNvidiaToolsForTurnContext(
        turnContext,
        toolNameMappings,
      );
      const requestBody = createNvidiaRequestBody({
        model,
        messages,
        tools,
      });
      const body = JSON.stringify(requestBody);
      const baseProviderExchange = createBaseNvidiaProviderExchange({
        endpoint,
        messages,
        model,
        requestBody,
        toolNameMappings,
        tools,
        // History replays earlier tool results too; only this turn's belong here.
        nativeToolResultMessages: turnContext.frames.flatMap(frame =>
          frame.placement === 'own_message' &&
          frame.kind === 'native_tool_result_message'
            ? [sanitizeNvidiaMessage(frame.message, toolNameMappings)]
            : [],
        ),
      });
      const baseMetadata = createProviderMetadata({
        endpoint,
        messageCount: messages.length,
        model,
      });
      const requestDeadline = createNvidiaRequestDeadline(requestTimeoutMs);

      try {
        const transport = await performNvidiaTransportRequest({
          fetchClient,
          endpoint,
          apiKey: options.apiKey,
          body,
          requestDeadline,
          retryDelaysMs: transportRetryDelaysMs,
        });

        if (transport.status === 'rejected') {
          return createProviderRejectedOutput({
            code: 'http_error',
            endpoint,
            message: redactProviderSecret(transport.message, options.apiKey),
            model,
            status: transport.httpStatus,
            providerExchange: baseProviderExchange,
          });
        }

        const responseBody = transport.responseBody;
        const rawOutput = parseNvidiaResponseMessage(
          responseBody,
          toolNameMappings,
          inputEnvelope.allowedTools.includes(visibleReplyModelToolName),
        );

        if (rawOutput.status === 'rejected') {
          return createProviderRejectedOutput({
            code: rawOutput.code,
            endpoint,
            message: rawOutput.message,
            model,
            status: transport.httpStatus,
            providerExchange: baseProviderExchange,
          });
        }

        return Object.freeze({
          rawOutputText: rawOutput.rawOutputText,
          nativeAssistantMessage: rawOutput.nativeAssistantMessage,
          ...nativeToolCallArgumentErrorsOption(
            rawOutput.nativeToolCallArgumentErrors,
          ),
          providerMetadata: Object.freeze({
            ...baseMetadata,
            response: Object.freeze({
              status: transport.httpStatus,
            }),
          } satisfies RoleModelProviderMetadata),
          providerExchange: createNvidiaProviderExchange({
            base: baseProviderExchange,
            ...(rawOutput.finishReason === undefined
              ? {}
              : {finishReason: rawOutput.finishReason}),
            ...(rawOutput.usage === undefined ? {} : {usage: rawOutput.usage}),
            nativeAssistantMessage: rawOutput.nativeAssistantMessage,
            ...(rawOutput.outputNormalization === undefined
              ? {}
              : {outputNormalization: rawOutput.outputNormalization}),
          }),
        } satisfies RoleModelAdapterRawOutput);
      } catch (error: unknown) {
        const message =
          error instanceof NvidiaRequestTimeoutError
            ? error.message
            : redactProviderSecret(
                error instanceof Error
                  ? error.message
                  : 'NVIDIA provider request failed.',
                options.apiKey,
              );

        return createProviderRejectedOutput({
          code:
            error instanceof NvidiaRequestTimeoutError
              ? 'request_timeout'
              : 'provider_error',
          endpoint,
          message,
          model,
          providerExchange: baseProviderExchange,
        });
      } finally {
        requestDeadline.dispose();
      }
    },
  } satisfies RoleModelAdapter);
}

function createNvidiaRequestBody(options: {
  readonly model: string;
  readonly messages: readonly NvidiaChatCompletionMessage[];
  readonly tools: readonly NvidiaChatCompletionTool[];
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    model: options.model,
    messages: options.messages,
    ...(options.tools.length === 0
      ? {}
      : {
          tools: options.tools,
          tool_choice: 'auto',
          parallel_tool_calls: true,
        }),
    stream: false,
    temperature: 1,
    top_p: 1,
    max_tokens: 16384,
    ...nvidiaThinkingRequestParams,
  });
}

const nvidiaThinkingRequestParams = Object.freeze({
  reasoning_budget: defaultNvidiaRoleModelReasoningBudget,
  chat_template_kwargs: Object.freeze({
    enable_thinking: true,
  }),
}) satisfies RuntimePluginJsonObject;

function createBaseNvidiaProviderExchange(options: {
  readonly endpoint: string;
  readonly messages: readonly NvidiaChatCompletionMessage[];
  readonly model: string;
  readonly requestBody: Readonly<Record<string, unknown>>;
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
  readonly tools: readonly NvidiaChatCompletionTool[];
  readonly nativeToolResultMessages: readonly NvidiaChatCompletionMessage[];
}): RoleModelProviderExchangeSnapshot {
  return createNvidiaProviderExchange({
    base: Object.freeze({
      provider: Object.freeze({
        name: nvidiaRoleModelProviderName,
        model: options.model,
        endpoint: options.endpoint,
      }),
      capabilities: nvidiaRoleModelProviderCapabilities,
      reasoning: Object.freeze({
        mode: 'enabled',
        params: nvidiaThinkingRequestParams,
      }),
      renderedMessages: Object.freeze([...options.messages]),
      renderedTools: Object.freeze([...options.tools]),
      toolNameMappings: Object.freeze([...options.toolNameMappings]),
      requestBody: redactProviderBoundaryJson(options.requestBody),
      nativeToolResultMessages: Object.freeze([
        ...options.nativeToolResultMessages,
      ]),
    } satisfies RoleModelProviderExchangeSnapshot),
  });
}

function createNvidiaProviderExchange(options: {
  readonly base: RoleModelProviderExchangeSnapshot;
  readonly finishReason?: string;
  readonly usage?: unknown;
  readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
  readonly outputNormalization?: RoleModelProviderExchangeSnapshot['outputNormalization'];
}): RoleModelProviderExchangeSnapshot {
  const candidate = Object.freeze({
    ...options.base,
    ...(options.finishReason === undefined
      ? {}
      : {finishReason: options.finishReason}),
    ...(options.usage === undefined
      ? {}
      : {usage: redactProviderBoundaryJson(options.usage)}),
    ...(options.nativeAssistantMessage === undefined
      ? {}
      : {nativeAssistantMessage: options.nativeAssistantMessage}),
    ...(options.outputNormalization === undefined
      ? {}
      : {outputNormalization: options.outputNormalization}),
  } satisfies RoleModelProviderExchangeSnapshot);

  return freezeRoleModelProviderExchangeSnapshot(candidate);
}

function createNvidiaProviderToolNameMappings(
  turnContext: RoleModelTurnContext,
): readonly RoleModelProviderToolNameMapping[] {
  return createRoleModelProviderToolNameMappings(
    turnContext.tools.map(tool => tool.function.name),
  );
}

function renderNvidiaMessagesForTurnContext(
  turnContext: RoleModelTurnContext,
  toolNameMappings: readonly RoleModelProviderToolNameMapping[],
): readonly NvidiaChatCompletionMessage[] {
  return Object.freeze(
    turnContext.messages.map(message =>
      sanitizeNvidiaMessage(message, toolNameMappings),
    ),
  );
}

function renderNvidiaToolsForTurnContext(
  turnContext: RoleModelTurnContext,
  toolNameMappings: readonly RoleModelProviderToolNameMapping[],
): readonly NvidiaChatCompletionTool[] {
  return Object.freeze(
    turnContext.tools.map(tool =>
      Object.freeze({
        type: 'function',
        function: Object.freeze({
          name: providerToolNameForRuntimeToolName(
            tool.function.name,
            toolNameMappings,
          ),
          description: tool.function.description,
          parameters: tool.function.parameters,
          ...(tool.function.strict === undefined ? {} : {strict: true}),
        }),
      } satisfies NvidiaChatCompletionTool),
    ),
  );
}

function sanitizeNvidiaMessage(
  message: RoleModelChatMessage,
  toolNameMappings: readonly RoleModelProviderToolNameMapping[],
): NvidiaChatCompletionMessage {
  if (message.role === 'assistant') {
    return Object.freeze({
      role: 'assistant',
      content: message.content,
      ...(message.tool_calls === undefined
        ? {}
        : {
            tool_calls: Object.freeze(
              message.tool_calls.map(toolCall =>
                sanitizeNvidiaToolCall(toolCall, toolNameMappings),
              ),
            ),
          }),
    } satisfies NvidiaChatCompletionMessage);
  }

  if (message.role === 'tool') {
    return Object.freeze({
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id,
    } satisfies NvidiaChatCompletionMessage);
  }

  return Object.freeze({
    role: message.role,
    content: message.content,
  } satisfies NvidiaChatCompletionMessage);
}

function sanitizeNvidiaToolCall(
  toolCall: RoleModelChatToolCall,
  toolNameMappings: readonly RoleModelProviderToolNameMapping[],
): RoleModelChatToolCall {
  return Object.freeze({
    id: toolCall.id,
    type: 'function',
    function: Object.freeze({
      name: providerToolNameForNvidiaAssistantHistoryToolName(
        toolCall.function.name,
        toolNameMappings,
      ),
      arguments: toolCall.function.arguments,
    }),
  } satisfies RoleModelChatToolCall);
}

function providerToolNameForNvidiaAssistantHistoryToolName(
  toolName: string,
  toolNameMappings: readonly RoleModelProviderToolNameMapping[],
): string {
  if (toolNameMappings.some(mapping => mapping.providerName === toolName)) {
    return toolName;
  }

  return providerToolNameForRuntimeToolName(toolName, toolNameMappings);
}

function createProviderRejectedOutput(options: {
  readonly code: NvidiaProviderErrorCode;
  readonly endpoint: string;
  readonly message: string;
  readonly model: string;
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
  readonly status?: number;
}): RoleModelAdapterRawOutput {
  const providerMetadata = createProviderMetadata({
    code: options.code,
    endpoint: options.endpoint,
    message: options.message,
    model: options.model,
    ...(options.status === undefined ? {} : {status: options.status}),
  });
  const rejectionDetails = providerMetadata.error?.message ?? options.message;

  return Object.freeze({
    rawOutputText: '',
    providerMetadata,
    ...(options.providerExchange === undefined
      ? {}
      : {providerExchange: options.providerExchange}),
    rejection: Object.freeze({
      reason: roleModelProviderErrorRejectionReason,
      details: rejectionDetails,
    }),
  } satisfies RoleModelAdapterRawOutput);
}

function createProviderMetadata(options: {
  readonly code?: NvidiaProviderErrorCode;
  readonly endpoint: string;
  readonly message?: string;
  readonly messageCount?: number;
  readonly model: string;
  readonly status?: number;
}): RoleModelProviderMetadata {
  return Object.freeze({
    provider: nvidiaRoleModelProviderName,
    model: options.model,
    request: Object.freeze({
      endpoint: options.endpoint,
      ...(options.messageCount === undefined
        ? {}
        : {messageCount: options.messageCount}),
      stream: false,
    }),
    ...(options.status === undefined
      ? {}
      : {
          response: Object.freeze({
            status: options.status,
          }),
        }),
    ...(options.code === undefined || options.message === undefined
      ? {}
      : {
          error: Object.freeze({
            code: options.code,
            message: options.message,
          }),
        }),
  } satisfies RoleModelProviderMetadata);
}

type ParsedNvidiaResponseMessage =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly finishReason?: string;
      readonly usage?: unknown;
      readonly nativeAssistantMessage: RoleModelAssistantChatMessage;
      readonly nativeToolCallArgumentErrors?: readonly RoleModelNativeToolCallArgumentError[];
      readonly outputNormalization?: RoleModelProviderExchangeSnapshot['outputNormalization'];
    }
  | RejectedNvidiaProviderParseResult;

type RejectedNvidiaProviderParseResult = {
  readonly status: 'rejected';
  readonly code: NvidiaProviderErrorCode;
  readonly message: string;
};

function parseNvidiaResponseMessage(
  value: unknown,
  toolNameMappings: readonly RoleModelProviderToolNameMapping[],
  visibleReplyAvailable: boolean,
): ParsedNvidiaResponseMessage {
  if (!isJsonRecord(value)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response must be an object.',
    );
  }

  const choicesValue = value['choices'];

  if (!Array.isArray(choicesValue)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response choices must be an array.',
    );
  }

  const choices: readonly unknown[] = choicesValue;
  const firstChoice = choices[0];

  if (!isJsonRecord(firstChoice)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response must include at least one choice.',
    );
  }

  const finishReasonResult = parseNvidiaFinishReason(
    firstChoice['finish_reason'],
  );

  if (finishReasonResult.status === 'rejected') {
    return finishReasonResult;
  }

  const message = firstChoice['message'];

  if (!isJsonRecord(message)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response choice.message must be an object.',
    );
  }

  const contentResult = parseOptionalNvidiaMessageContent(message['content']);

  if (contentResult.status === 'rejected') {
    return contentResult;
  }

  const toolCallsResult = parseOptionalNvidiaToolCalls(message['tool_calls']);

  if (toolCallsResult.status === 'rejected') {
    return toolCallsResult;
  }

  const content = contentResult.content;
  const toolCalls = toolCallsResult.toolCalls;
  const rawOutputResult = createRawOutputTextFromNvidiaMessage({
    content,
    toolCalls,
    toolNameMappings,
    visibleReplyAvailable,
  });

  if (rawOutputResult.status === 'rejected') {
    return rawOutputResult;
  }

  return Object.freeze({
    status: 'accepted',
    rawOutputText: rawOutputResult.rawOutputText,
    finishReason: finishReasonResult.finishReason,
    ...(value['usage'] === undefined ? {} : {usage: value['usage']}),
    nativeAssistantMessage: Object.freeze({
      role: 'assistant',
      content,
      ...(toolCalls.length === 0 ? {} : {tool_calls: toolCalls}),
    } satisfies RoleModelAssistantChatMessage),
    ...nativeToolCallArgumentErrorsOption(
      rawOutputResult.nativeToolCallArgumentErrors,
    ),
    ...(rawOutputResult.outputNormalization === undefined
      ? {}
      : {outputNormalization: rawOutputResult.outputNormalization}),
  } satisfies ParsedNvidiaResponseMessage);
}

function parseNvidiaFinishReason(
  value: unknown,
):
  | {readonly status: 'accepted'; readonly finishReason: string}
  | RejectedNvidiaProviderParseResult {
  if (value === undefined || value === null) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response choice.finish_reason is required.',
    );
  }

  if (typeof value !== 'string') {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response choice.finish_reason must be a string.',
    );
  }

  if (terminalNvidiaFinishReasons.includes(value)) {
    return Object.freeze({status: 'accepted', finishReason: value});
  }

  return rejectResponse(
    'provider_error',
    `NVIDIA response finish_reason "${value}" is not terminal.`,
  );
}

type ParsedNvidiaMessageContent =
  | {
      readonly status: 'accepted';
      readonly content: string | null;
    }
  | RejectedNvidiaProviderParseResult;

function parseOptionalNvidiaMessageContent(
  value: unknown,
): ParsedNvidiaMessageContent {
  if (value === undefined || value === null) {
    return Object.freeze({
      status: 'accepted',
      content: null,
    } satisfies ParsedNvidiaMessageContent);
  }

  if (typeof value !== 'string') {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response message.content must be a string or null.',
    );
  }

  const scrubbed = scrubReasoningBlocks(value);

  if (scrubbed.status === 'rejected') {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response message.content contains an unterminated reasoning block.',
    );
  }

  return Object.freeze({
    status: 'accepted',
    content: scrubbed.text,
  } satisfies ParsedNvidiaMessageContent);
}

type ParsedNvidiaToolCalls =
  | {
      readonly status: 'accepted';
      readonly toolCalls: readonly RoleModelChatToolCall[];
    }
  | RejectedNvidiaProviderParseResult;

function parseOptionalNvidiaToolCalls(value: unknown): ParsedNvidiaToolCalls {
  if (value === undefined || value === null) {
    return Object.freeze({
      status: 'accepted',
      toolCalls: Object.freeze([]),
    } satisfies ParsedNvidiaToolCalls);
  }

  if (!Array.isArray(value)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response message.tool_calls must be an array.',
    );
  }

  const toolCalls: RoleModelChatToolCall[] = [];

  for (const [index, item] of value.entries()) {
    const parsed = parseNvidiaToolCall(item, index);

    if (parsed.status === 'rejected') {
      return parsed;
    }

    toolCalls.push(parsed.toolCall);
  }

  return Object.freeze({
    status: 'accepted',
    toolCalls: Object.freeze(toolCalls),
  } satisfies ParsedNvidiaToolCalls);
}

type ParsedNvidiaToolCall =
  | {
      readonly status: 'accepted';
      readonly toolCall: RoleModelChatToolCall;
    }
  | RejectedNvidiaProviderParseResult;

function parseNvidiaToolCall(
  value: unknown,
  index: number,
): ParsedNvidiaToolCall {
  if (!isJsonRecord(value)) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}] must be an object.`,
    );
  }

  const id = value['id'];
  const type = value['type'];
  const fn = value['function'];

  if (typeof id !== 'string' || id.length === 0) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].id must be a string.`,
    );
  }

  if (type !== 'function' || !isJsonRecord(fn)) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}] must be a function tool call.`,
    );
  }

  const name = fn['name'];
  const args = fn['arguments'];

  if (typeof name !== 'string' || name.length === 0) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].function.name must be a string.`,
    );
  }

  if (typeof args !== 'string') {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].function.arguments must be a JSON string.`,
    );
  }

  return Object.freeze({
    status: 'accepted',
    toolCall: Object.freeze({
      id,
      type: 'function',
      function: Object.freeze({
        name,
        arguments: args,
      }),
    } satisfies RoleModelChatToolCall),
  } satisfies ParsedNvidiaToolCall);
}

type NvidiaRawOutputTextResult =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly nativeToolCallArgumentErrors?: readonly RoleModelNativeToolCallArgumentError[];
      readonly outputNormalization?: RoleModelProviderExchangeSnapshot['outputNormalization'];
    }
  | RejectedNvidiaProviderParseResult;

function createRawOutputTextFromNvidiaMessage(options: {
  readonly content: string | null;
  readonly toolCalls: readonly RoleModelChatToolCall[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
  readonly visibleReplyAvailable: boolean;
}): NvidiaRawOutputTextResult {
  if (options.toolCalls.length === 0) {
    // Empty content is model behavior, not a transport fault.
    if (options.content === null || options.content.length === 0) {
      return Object.freeze({
        status: 'accepted',
        rawOutputText: JSON.stringify({toolCalls: []}),
      } satisfies NvidiaRawOutputTextResult);
    }

    const scrubbedContent = scrubReasoningBlocks(options.content);

    if (scrubbedContent.status === 'rejected') {
      return rejectResponse(
        'malformed_response',
        'Visible reply contains an unterminated reasoning block.',
      );
    }

    return Object.freeze({
      status: 'accepted',
      rawOutputText: JSON.stringify(
        options.visibleReplyAvailable
          ? {
              toolCalls: [
                {
                  name: visibleReplyModelToolName,
                  input: {
                    text: scrubbedContent.text,
                  },
                },
              ],
            }
          : {
              toolCalls: [],
              text: scrubbedContent.text,
            },
      ),
      outputNormalization: Object.freeze({
        source: 'terminal_assistant_content',
        committed: false,
      } satisfies NonNullable<
        RoleModelProviderExchangeSnapshot['outputNormalization']
      >),
    } satisfies NvidiaRawOutputTextResult);
  }

  const toolCalls: ModelToolCall[] = [];
  const nativeToolCallArgumentErrors: RoleModelNativeToolCallArgumentError[] =
    [];
  let executableIndex = 0;

  for (const [index, call] of options.toolCalls.entries()) {
    const runtimeToolName = runtimeToolNameForProviderToolName(
      call.function.name,
      options.toolNameMappings,
    );
    const parsedArgs = parseNvidiaToolCallArguments({
      call,
      index,
      runtimeToolName,
    });

    if (parsedArgs.status === 'rejected') {
      // Empty text, not an empty object: the parser requires a string.
      if (runtimeToolName === visibleReplyModelToolName) {
        toolCalls.push({
          name: visibleReplyModelToolName,
          input: Object.freeze({text: ''}),
        });
        continue;
      }

      nativeToolCallArgumentErrors.push(
        Object.freeze({
          executableIndex,
          toolName: runtimeToolName,
          reason: 'invalid_native_tool_arguments',
          message: parsedArgs.message,
        } satisfies RoleModelNativeToolCallArgumentError),
      );
      toolCalls.push({
        name: runtimeToolName,
        input: Object.freeze({}),
      });
      executableIndex += 1;
      continue;
    }

    toolCalls.push({
      name: runtimeToolName,
      input: parsedArgs.input,
    });

    if (runtimeToolName !== visibleReplyModelToolName) {
      executableIndex += 1;
    }
  }

  return Object.freeze({
    status: 'accepted',
    rawOutputText: JSON.stringify({
      toolCalls,
    }),
    ...nativeToolCallArgumentErrorsOption(nativeToolCallArgumentErrors),
    ...(options.content === null || options.content.length === 0
      ? {}
      : {
          outputNormalization: Object.freeze({
            source: 'native_tool_calls',
            committed: false,
          } satisfies NonNullable<
            RoleModelProviderExchangeSnapshot['outputNormalization']
          >),
        }),
  } satisfies NvidiaRawOutputTextResult);
}

function nativeToolCallArgumentErrorsOption(
  errors: readonly RoleModelNativeToolCallArgumentError[] | undefined,
): {
  readonly nativeToolCallArgumentErrors?: readonly RoleModelNativeToolCallArgumentError[];
} {
  return errors === undefined || errors.length === 0
    ? {}
    : {nativeToolCallArgumentErrors: Object.freeze([...errors])};
}

type ParsedNvidiaToolCallArguments =
  | {
      readonly status: 'accepted';
      readonly input: Readonly<Record<string, unknown>>;
    }
  | RejectedNvidiaProviderParseResult;

function parseNvidiaToolCallArguments(options: {
  readonly call: RoleModelChatToolCall;
  readonly index: number;
  readonly runtimeToolName: string;
}): ParsedNvidiaToolCallArguments {
  let parsed: unknown;

  try {
    parsed = JSON.parse(options.call.function.arguments);
  } catch {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(options.index)}].function.arguments must be valid JSON.`,
    );
  }

  if (!isJsonRecord(parsed)) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(options.index)}].function.arguments must parse to an object.`,
    );
  }

  return Object.freeze({
    status: 'accepted',
    input: createJsonBoundaryObjectSnapshot(parsed, {
      field: `NVIDIA response message.tool_calls[${String(options.index)}].function.arguments`,
    }),
  } satisfies ParsedNvidiaToolCallArguments);
}

function rejectResponse(
  code: NvidiaProviderErrorCode,
  message: string,
): RejectedNvidiaProviderParseResult {
  return Object.freeze({
    status: 'rejected',
    code,
    message,
  } satisfies RejectedNvidiaProviderParseResult);
}

function redactProviderBoundaryJson(value: unknown): RuntimePluginJsonValue {
  return createJsonBoundarySnapshot(value, {
    field: 'NVIDIA provider exchange',
    redact: true,
    limits: roleModelProviderExchangeJsonBoundaryLimits,
  });
}

function optionalNvidiaProviderEnvValue(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value;
}
