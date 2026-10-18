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
import {visibleReplyModelToolName} from '../api/model-tools.ts';
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
} from '../api/adapter.ts';
import {
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
} from '../../plugins/api/index.ts';
import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import {scrubReasoningBlocks} from '../api/reasoning.ts';

const nvidiaRoleModelProviderName = 'nvidia';
const nvidiaCloudBaseUrl = 'https://integrate.api.nvidia.com/v1';
export const defaultNvidiaRoleModelReasoningBudget = 16384;

export const nvidiaRoleModelProviderCapabilities = Object.freeze({
  ...defaultRoleModelProviderCapabilities,
  supportsReasoning: true,
  reasoningParameterStyle: 'nvidia',
  requiresReasoningBlockRoundTrip: false,
} satisfies RoleModelProviderCapabilities);

export type NvidiaRoleModelProviderConfig = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly requestTimeoutMs?: number;
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
} from './nvidia-transport.ts';
import {
  terminalNvidiaFinishReasons,
  createNvidiaRequestDeadline,
  normalizeNvidiaRequestTimeoutMs,
  normalizeNvidiaTransportRetryDelays,
  NvidiaRequestTimeoutError,
  performNvidiaTransportRequest,
  readResponseChunks,
  redactProviderSecret,
  type NvidiaFetchClient,
} from './nvidia-transport.ts';
import {createNvidiaTextCompletion} from './nvidia-completion.ts';
import {readNvidiaChatCompletionStream} from './nvidia-stream.ts';
import {createNvidiaReplyDrafts} from './reply-draft.ts';

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

export function createNvidiaRoleModelProviderAdapter(
  options: CreateNvidiaRoleModelProviderAdapterOptions = {},
): RoleModelAdapter {
  const endpoint = chatCompletionsEndpoint(
    options.baseUrl ?? nvidiaCloudBaseUrl,
  );
  const model = options.model ?? 'nvidia/nemotron-3-nano-30b-a3b';
  const apiKey =
    options.apiKey === undefined || options.apiKey.length === 0
      ? undefined
      : options.apiKey;
  // NVIDIA's cloud answers nothing without a key; a server of one's own may ask for none.
  const keyMissing = apiKey === undefined && options.baseUrl === undefined;
  const fetchClient: NvidiaFetchClient = options.fetchClient ?? fetch;
  const requestTimeoutMs = normalizeNvidiaRequestTimeoutMs(
    options.requestTimeoutMs,
  );
  const transportRetryDelaysMs = normalizeNvidiaTransportRetryDelays(
    options.transportRetryDelaysMs,
  );

  return Object.freeze({
    completeText: keyMissing
      ? () =>
          Promise.resolve({
            status: 'failed' as const,
            reason: 'NVIDIA provider has no API key.',
          })
      : createNvidiaTextCompletion({
          ...(apiKey === undefined ? {} : {apiKey}),
          endpoint,
          model,
          fetchClient,
          requestTimeoutMs,
          transportRetryDelaysMs,
        }),
    async invoke(_inputEnvelope, invocation) {
      if (keyMissing) {
        return createProviderRejectedOutput({
          code: 'missing_api_key',
          endpoint,
          message: 'NVIDIA provider requires the nvidiaApiKey setting.',
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
          ...(apiKey === undefined ? {} : {apiKey}),
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

        // The body streams whether or not anyone listens: one reader, one
        // reassembly, and the same judge the whole body always had.
        const drafts = createNvidiaReplyDrafts({
          toolNameMappings,
          ...(invocation.onReplyDelta === undefined
            ? {}
            : {onReplyDelta: invocation.onReplyDelta}),
        });
        const streamed = await readNvidiaChatCompletionStream(
          readResponseChunks(transport.response, requestDeadline),
          drafts.observer,
        );

        if (streamed.status === 'rejected') {
          return createProviderRejectedOutput({
            code: streamed.code,
            endpoint,
            message: redactProviderSecret(streamed.message, options.apiKey),
            model,
            status: transport.httpStatus,
            providerExchange: baseProviderExchange,
          });
        }

        const rawOutput = parseNvidiaResponseMessage(
          streamed.response,
          toolNameMappings,
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

        drafts.finish();

        return Object.freeze({
          rawOutputText: rawOutput.rawOutputText,
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
            ...(rawOutput.nativeAssistantMessage === undefined
              ? {}
              : {nativeAssistantMessage: rawOutput.nativeAssistantMessage}),
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

/** A base given with or without its trailing slash names one endpoint. */
function chatCompletionsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);

  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/chat/completions`;

  return url.href;
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
    stream: true,
    stream_options: {include_usage: true},
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
    } satisfies RoleModelProviderExchangeSnapshot),
  });
}

function createNvidiaProviderExchange(options: {
  readonly base: RoleModelProviderExchangeSnapshot;
  readonly finishReason?: string;
  readonly usage?: unknown;
  readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
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
      name: providerToolNameForRuntimeToolName(
        toolCall.function.name,
        toolNameMappings,
      ),
      arguments: toolCall.function.arguments,
    }),
  } satisfies RoleModelChatToolCall);
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
      /** Absent when the model's reply could not be normalised and goes to the parser as it is. */
      readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
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

  if (contentResult.status === 'unusable') {
    return Object.freeze({
      status: 'accepted',
      rawOutputText: contentResult.rawOutputText,
      finishReason: finishReasonResult.finishReason,
      ...(value['usage'] === undefined ? {} : {usage: value['usage']}),
    } satisfies ParsedNvidiaResponseMessage);
  }

  const toolCallsResult = parseOptionalNvidiaToolCalls(message['tool_calls']);

  if (toolCallsResult.status === 'rejected') {
    return toolCallsResult;
  }

  const content = contentResult.content;
  const toolCalls = toolCallsResult.toolCalls;

  return Object.freeze({
    status: 'accepted',
    rawOutputText: createRawOutputTextFromNvidiaMessage({
      content,
      toolCalls,
      toolNameMappings,
    }),
    finishReason: finishReasonResult.finishReason,
    ...(value['usage'] === undefined ? {} : {usage: value['usage']}),
    nativeAssistantMessage: Object.freeze({
      role: 'assistant',
      content,
      ...(toolCalls.length === 0 ? {} : {tool_calls: toolCalls}),
    } satisfies RoleModelAssistantChatMessage),
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
  | {
      /**
       * The model wrote something the adapter cannot normalise, such as an
       * unterminated reasoning block. It goes to the parser as it is: the
       * refusal is then the parser's, and the loop hands it back to the
       * model rather than ending the turn as it would for a provider fault.
       */
      readonly status: 'unusable';
      readonly rawOutputText: string;
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
    return Object.freeze({
      status: 'unusable',
      rawOutputText: value,
    } satisfies ParsedNvidiaMessageContent);
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

/**
 * The wire message as a decision: content alone is the character speaking,
 * so it becomes visible_reply; native tool calls become tool calls, and any
 * content beside them is the model's own text. Arguments are handed to the
 * parser as the model wrote them — parsed when they parse, the raw string
 * when they do not — so a bad call is refused there like any other.
 */
function createRawOutputTextFromNvidiaMessage(options: {
  readonly content: string | null;
  readonly toolCalls: readonly RoleModelChatToolCall[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): string {
  const content =
    options.content === null || options.content.length === 0
      ? undefined
      : options.content;

  if (options.toolCalls.length === 0) {
    // Empty content is model behavior, not a transport fault.
    return JSON.stringify({
      toolCalls:
        content === undefined
          ? []
          : [{name: visibleReplyModelToolName, input: {text: content}}],
    });
  }

  return JSON.stringify({
    toolCalls: options.toolCalls.map(call => ({
      name: runtimeToolNameForProviderToolName(
        call.function.name,
        options.toolNameMappings,
      ),
      input: decisionInputForNativeArguments(call.function.arguments),
    })),
    ...(content === undefined ? {} : {text: content}),
  });
}

function decisionInputForNativeArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
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
