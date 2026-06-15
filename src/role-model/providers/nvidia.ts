import {
  roleModelProviderErrorRejectionReason,
  type RoleModelInputEnvelope,
  type RoleModelProviderMetadata
} from '../contracts.ts';
import {
  validateModelToolInputAgainstContract,
  visibleReplyModelToolName,
  type ModelToolInputContract
} from '../model-tools.ts';
import {
  renderRoleModelTurnContext,
  type RoleModelAssistantChatMessage,
  type RoleModelChatCompletionTool,
  type RoleModelChatMessage,
  type RoleModelChatToolCall,
  type RoleModelTurnContext
} from '../prompt.ts';
import type {
  RoleModelAdapter,
  RoleModelAdapterInvocation,
  RoleModelAdapterRawOutput
} from '../loop.ts';

export const nvidiaRoleModelProviderName = 'nvidia';
export const defaultNvidiaChatCompletionsEndpoint =
  'https://integrate.api.nvidia.com/v1/chat/completions';
export const defaultNvidiaRoleModelName = 'nvidia/nemotron-3-nano-30b-a3b';
export const nvidiaRoleModelTemperature = 1;
export const nvidiaRoleModelTopP = 1;
export const nvidiaRoleModelMaxTokens = 16384;
export const nvidiaRoleModelReasoningBudget = 16384;
export const nvidiaApiKeyEnvName = 'NVIDIA_API_KEY';
export const nvidiaModelEnvName = 'NVIDIA_MODEL';

export type NvidiaRoleModelProviderConfig = {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly model?: string;
};

export type NvidiaRoleModelProviderEnvironment = {
  readonly NVIDIA_API_KEY?: string;
  readonly NVIDIA_MODEL?: string;
};

export type NvidiaChatCompletionMessage = RoleModelChatMessage;
export type NvidiaChatCompletionTool = RoleModelChatCompletionTool;

export type NvidiaFetchRequest = {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type NvidiaFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type NvidiaFetchClient = (
  url: string,
  request: NvidiaFetchRequest
) => Promise<NvidiaFetchResponse>;

export type CreateNvidiaRoleModelProviderAdapterOptions =
  NvidiaRoleModelProviderConfig & {
    readonly fetchClient?: NvidiaFetchClient;
  };

type NvidiaProviderErrorCode =
  | 'empty_output'
  | 'http_error'
  | 'malformed_response'
  | 'missing_api_key'
  | 'provider_error';

const nvidiaNativeToolArgumentsContract = Object.freeze({
  type: 'object',
  fields: Object.freeze([]),
  additionalFields: true
} satisfies ModelToolInputContract);

export function createNvidiaRoleModelProviderConfigFromEnv(
  env: NvidiaRoleModelProviderEnvironment = process.env
): NvidiaRoleModelProviderConfig {
  const apiKey = optionalNvidiaProviderEnvValue(env.NVIDIA_API_KEY);
  const model = optionalNvidiaProviderEnvValue(env.NVIDIA_MODEL);

  return Object.freeze({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(model === undefined ? {} : { model })
  } satisfies NvidiaRoleModelProviderConfig);
}

export function createNvidiaRoleModelProviderAdapter(
  options: CreateNvidiaRoleModelProviderAdapterOptions = {}
): RoleModelAdapter {
  const endpoint = options.endpoint ?? defaultNvidiaChatCompletionsEndpoint;
  const model = options.model ?? defaultNvidiaRoleModelName;
  const fetchClient = options.fetchClient ?? defaultFetchClient;

  return Object.freeze({
    async invoke(inputEnvelope, invocation) {
      if (options.apiKey === undefined || options.apiKey.length === 0) {
        return createProviderRejectedOutput({
          code: 'missing_api_key',
          endpoint,
          message: `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
          model
        });
      }

      const messages = renderNvidiaMessages(inputEnvelope, invocation);
      const tools = renderNvidiaTools(inputEnvelope, invocation);
      const body = JSON.stringify({
        model,
        messages,
        ...(tools.length === 0
          ? {}
          : {
              tools,
              tool_choice: 'auto'
            }),
        stream: false,
        temperature: nvidiaRoleModelTemperature,
        top_p: nvidiaRoleModelTopP,
        max_tokens: nvidiaRoleModelMaxTokens,
        reasoning_budget: nvidiaRoleModelReasoningBudget,
        chat_template_kwargs: {
          enable_thinking: false
        }
      });
      const baseMetadata = createProviderMetadata({
        endpoint,
        messageCount: messages.length,
        model
      });

      try {
        const response = await fetchClient(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json'
          },
          body
        });

        if (!response.ok) {
          return createProviderRejectedOutput({
            code: 'http_error',
            endpoint,
            message: redactProviderSecret(
              await responseErrorMessage(response),
              options.apiKey
            ),
            model,
            status: response.status
          });
        }

        const responseBody = await response.json();
        const rawOutput = parseNvidiaResponseMessage(responseBody);

        if (rawOutput.status === 'rejected') {
          return createProviderRejectedOutput({
            code: rawOutput.code,
            endpoint,
            message: rawOutput.message,
            model,
            status: response.status
          });
        }

        return Object.freeze({
          rawOutputText: rawOutput.rawOutputText,
          nativeAssistantMessage: rawOutput.nativeAssistantMessage,
          providerMetadata: Object.freeze({
            ...baseMetadata,
            response: Object.freeze({
              status: response.status
            })
          } satisfies RoleModelProviderMetadata)
        } satisfies RoleModelAdapterRawOutput);
      } catch (error: unknown) {
        return createProviderRejectedOutput({
          code: 'provider_error',
          endpoint,
          message: redactProviderSecret(
            error instanceof Error
              ? error.message
              : 'NVIDIA provider request failed.',
            options.apiKey
          ),
          model
        });
      }
    }
  } satisfies RoleModelAdapter);
}

export function renderNvidiaMessages(
  inputEnvelope: RoleModelInputEnvelope,
  invocation?: RoleModelAdapterInvocation
): readonly NvidiaChatCompletionMessage[] {
  return Object.freeze(
    turnContextForNvidia(inputEnvelope, invocation).messages.map((message) =>
      sanitizeNvidiaMessage(message)
    )
  );
}

export function renderNvidiaTools(
  inputEnvelope: RoleModelInputEnvelope,
  invocation?: RoleModelAdapterInvocation
): readonly NvidiaChatCompletionTool[] {
  return Object.freeze([...turnContextForNvidia(inputEnvelope, invocation).tools]);
}

function turnContextForNvidia(
  inputEnvelope: RoleModelInputEnvelope,
  invocation?: RoleModelAdapterInvocation
): RoleModelTurnContext {
  return invocation?.turnContext ?? renderRoleModelTurnContext(inputEnvelope);
}

function sanitizeNvidiaMessage(
  message: RoleModelChatMessage
): NvidiaChatCompletionMessage {
  if (message.role === 'assistant') {
    return Object.freeze({
      role: 'assistant',
      content: message.content,
      ...(message.tool_calls === undefined
        ? {}
        : { tool_calls: Object.freeze([...message.tool_calls]) })
    } satisfies NvidiaChatCompletionMessage);
  }

  if (message.role === 'tool') {
    return Object.freeze({
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id
    } satisfies NvidiaChatCompletionMessage);
  }

  return Object.freeze({
    role: message.role,
    content: message.content
  } satisfies NvidiaChatCompletionMessage);
}

function createProviderRejectedOutput(options: {
  readonly code: NvidiaProviderErrorCode;
  readonly endpoint: string;
  readonly message: string;
  readonly model: string;
  readonly status?: number;
}): RoleModelAdapterRawOutput {
  return Object.freeze({
    rawOutputText: '',
    providerMetadata: createProviderMetadata({
      code: options.code,
      endpoint: options.endpoint,
      message: options.message,
      model: options.model,
      ...(options.status === undefined ? {} : { status: options.status })
    }),
    rejection: Object.freeze({
      reason: roleModelProviderErrorRejectionReason,
      details: options.message
    })
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
        : { messageCount: options.messageCount }),
      stream: false
    }),
    ...(options.status === undefined
      ? {}
      : {
          response: Object.freeze({
            status: options.status
          })
        }),
    ...(options.code === undefined || options.message === undefined
      ? {}
      : {
          error: Object.freeze({
            code: options.code,
            message: options.message
          })
        })
  } satisfies RoleModelProviderMetadata);
}

type ParsedNvidiaResponseMessage =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly nativeAssistantMessage: RoleModelAssistantChatMessage;
    }
  | RejectedNvidiaProviderParseResult;

type RejectedNvidiaProviderParseResult = {
  readonly status: 'rejected';
  readonly code: NvidiaProviderErrorCode;
  readonly message: string;
};

function parseNvidiaResponseMessage(value: unknown): ParsedNvidiaResponseMessage {
  if (!isJsonRecord(value)) {
    return rejectResponse('malformed_response', 'NVIDIA response must be an object.');
  }

  const choicesValue = value['choices'];

  if (!Array.isArray(choicesValue)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response choices must be an array.'
    );
  }

  const choices: readonly unknown[] = choicesValue;
  const firstChoice = choices[0];

  if (!isJsonRecord(firstChoice)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response must include at least one choice.'
    );
  }

  const message = firstChoice['message'];

  if (!isJsonRecord(message)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response choice.message must be an object.'
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
    toolCalls
  });

  if (rawOutputResult.status === 'rejected') {
    return rawOutputResult;
  }

  return Object.freeze({
    status: 'accepted',
    rawOutputText: rawOutputResult.rawOutputText,
    nativeAssistantMessage: Object.freeze({
      role: 'assistant',
      content,
      ...(toolCalls.length === 0
        ? {}
        : { tool_calls: Object.freeze([...toolCalls]) })
    } satisfies RoleModelAssistantChatMessage)
  } satisfies ParsedNvidiaResponseMessage);
}

type ParsedNvidiaMessageContent =
  | {
      readonly status: 'accepted';
      readonly content: string | null;
    }
  | RejectedNvidiaProviderParseResult;

function parseOptionalNvidiaMessageContent(
  value: unknown
): ParsedNvidiaMessageContent {
  if (value === undefined || value === null) {
    return Object.freeze({
      status: 'accepted',
      content: null
    } satisfies ParsedNvidiaMessageContent);
  }

  if (typeof value !== 'string') {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response message.content must be a string or null.'
    );
  }

  return Object.freeze({
    status: 'accepted',
    content: value
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
      toolCalls: Object.freeze([])
    } satisfies ParsedNvidiaToolCalls);
  }

  if (!Array.isArray(value)) {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response message.tool_calls must be an array.'
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
    toolCalls: Object.freeze(toolCalls)
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
  index: number
): ParsedNvidiaToolCall {
  if (!isJsonRecord(value)) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}] must be an object.`
    );
  }

  const id = value['id'];
  const type = value['type'];
  const fn = value['function'];

  if (typeof id !== 'string' || id.length === 0) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].id must be a string.`
    );
  }

  if (type !== 'function' || !isJsonRecord(fn)) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}] must be a function tool call.`
    );
  }

  const name = fn['name'];
  const args = fn['arguments'];

  if (typeof name !== 'string' || name.length === 0) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].function.name must be a string.`
    );
  }

  if (typeof args !== 'string') {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].function.arguments must be a JSON string.`
    );
  }

  return Object.freeze({
    status: 'accepted',
    toolCall: Object.freeze({
      id,
      type: 'function',
      function: Object.freeze({
        name,
        arguments: args
      })
    } satisfies RoleModelChatToolCall)
  } satisfies ParsedNvidiaToolCall);
}

type NvidiaRawOutputTextResult =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
    }
  | RejectedNvidiaProviderParseResult;

function createRawOutputTextFromNvidiaMessage(options: {
  readonly content: string | null;
  readonly toolCalls: readonly RoleModelChatToolCall[];
}): NvidiaRawOutputTextResult {
  if (options.toolCalls.length === 0) {
    if (options.content === null || options.content.length === 0) {
      return rejectResponse('empty_output', 'NVIDIA response content is empty.');
    }

    return Object.freeze({
      status: 'accepted',
      rawOutputText: JSON.stringify({
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: options.content
            }
          }
        ]
      })
    } satisfies NvidiaRawOutputTextResult);
  }

  const toolCalls: Array<{
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
  }> = [];

  for (const [index, call] of options.toolCalls.entries()) {
    const parsedArgs = parseNvidiaToolCallArguments(call, index);

    if (parsedArgs.status === 'rejected') {
      return parsedArgs;
    }

    toolCalls.push({
      name: call.function.name,
      input: parsedArgs.input
    });
  }

  return Object.freeze({
    status: 'accepted',
    rawOutputText: JSON.stringify({
      toolCalls,
      ...(options.content === null || options.content.length === 0
        ? {}
        : { text: options.content })
    })
  } satisfies NvidiaRawOutputTextResult);
}

type ParsedNvidiaToolCallArguments =
  | {
      readonly status: 'accepted';
      readonly input: Readonly<Record<string, unknown>>;
    }
  | RejectedNvidiaProviderParseResult;

function parseNvidiaToolCallArguments(
  call: RoleModelChatToolCall,
  index: number
): ParsedNvidiaToolCallArguments {
  let parsed: unknown;

  try {
    parsed = JSON.parse(call.function.arguments);
  } catch {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].function.arguments must be valid JSON.`
    );
  }

  if (!isJsonRecord(parsed)) {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].function.arguments must parse to an object.`
    );
  }

  const validatedInput = validateModelToolInputAgainstContract({
    toolName: call.function.name,
    input: parsed,
    inputContract: nvidiaNativeToolArgumentsContract
  });

  if (validatedInput.status === 'rejected') {
    return rejectResponse(
      'malformed_response',
      `NVIDIA response message.tool_calls[${String(index)}].function.arguments must contain JSON-compatible finite values: ${validatedInput.details}`
    );
  }

  return Object.freeze({
    status: 'accepted',
    input: validatedInput.input
  } satisfies ParsedNvidiaToolCallArguments);
}

function rejectResponse(
  code: NvidiaProviderErrorCode,
  message: string
): RejectedNvidiaProviderParseResult {
  return Object.freeze({
    status: 'rejected',
    code,
    message
  } satisfies RejectedNvidiaProviderParseResult);
}

async function responseErrorMessage(
  response: NvidiaFetchResponse
): Promise<string> {
  let text: string;

  try {
    text = await response.text();
  } catch {
    return `NVIDIA provider HTTP ${String(response.status)}.`;
  }

  try {
    const body: unknown = JSON.parse(text);
    const message = providerErrorMessageFromBody(body);

    if (message !== undefined) {
      return message;
    }
  } catch {
    // Fall through to text fallback below for non-JSON provider errors.
  }

  if (text.length > 0) {
    return `NVIDIA provider HTTP ${String(response.status)}: ${text}`;
  }

  return `NVIDIA provider HTTP ${String(response.status)}.`;
}

function providerErrorMessageFromBody(body: unknown): string | undefined {
  if (!isJsonRecord(body)) {
    return undefined;
  }

  const error = body['error'];

  if (isJsonRecord(error) && typeof error['message'] === 'string') {
    return `NVIDIA provider error: ${error['message']}`;
  }

  if (typeof body['message'] === 'string') {
    return `NVIDIA provider error: ${body['message']}`;
  }

  return undefined;
}

function redactProviderSecret(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) {
    return message;
  }

  return message.split(secret).join('[redacted]');
}

function optionalNvidiaProviderEnvValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value;
}

async function defaultFetchClient(
  url: string,
  request: NvidiaFetchRequest
): Promise<NvidiaFetchResponse> {
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });

  return Object.freeze({
    ok: response.ok,
    status: response.status,
    async json() {
      return await response.json();
    },
    async text() {
      return await response.text();
    }
  } satisfies NvidiaFetchResponse);
}

function isJsonRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
