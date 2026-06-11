import {
  roleModelProviderErrorRejectionReason,
  type RoleModelInputEnvelope,
  type RoleModelProviderMetadata
} from './role-model-contracts.ts';
import { renderRoleModelPromptMessages } from './role-model-prompt.ts';
import type {
  RoleModelAdapter,
  RoleModelAdapterRawOutput
} from './role-model-loop.ts';

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

export type NvidiaChatCompletionMessage = {
  readonly role: 'system' | 'user';
  readonly content: string;
};

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

export function createNvidiaRoleModelProviderConfigFromEnv(
  env: NvidiaRoleModelProviderEnvironment = process.env
): NvidiaRoleModelProviderConfig {
  return Object.freeze({
    ...(env.NVIDIA_API_KEY === undefined ? {} : { apiKey: env.NVIDIA_API_KEY }),
    ...(env.NVIDIA_MODEL === undefined ? {} : { model: env.NVIDIA_MODEL })
  } satisfies NvidiaRoleModelProviderConfig);
}

export function createNvidiaRoleModelProviderAdapter(
  options: CreateNvidiaRoleModelProviderAdapterOptions = {}
): RoleModelAdapter {
  const endpoint = options.endpoint ?? defaultNvidiaChatCompletionsEndpoint;
  const model = options.model ?? defaultNvidiaRoleModelName;
  const fetchClient = options.fetchClient ?? defaultFetchClient;

  return Object.freeze({
    async invoke(inputEnvelope) {
      if (options.apiKey === undefined || options.apiKey.length === 0) {
        return createProviderRejectedOutput({
          code: 'missing_api_key',
          endpoint,
          message: `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
          model
        });
      }

      const messages = renderNvidiaMessages(inputEnvelope);
      const body = JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: nvidiaRoleModelTemperature,
        top_p: nvidiaRoleModelTopP,
        max_tokens: nvidiaRoleModelMaxTokens,
        reasoning_budget: nvidiaRoleModelReasoningBudget
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
        const rawOutputText = parseNvidiaResponseText(responseBody);

        if (rawOutputText.status === 'rejected') {
          return createProviderRejectedOutput({
            code: rawOutputText.code,
            endpoint,
            message: rawOutputText.message,
            model,
            status: response.status
          });
        }

        return Object.freeze({
          rawOutputText: rawOutputText.text,
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
  inputEnvelope: RoleModelInputEnvelope
): readonly NvidiaChatCompletionMessage[] {
  return Object.freeze(
    renderRoleModelPromptMessages(inputEnvelope).map((message) =>
      Object.freeze({
        role: message.role,
        content: message.content
      } satisfies NvidiaChatCompletionMessage)
    )
  );
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

type ParsedNvidiaResponseText =
  | {
      readonly status: 'accepted';
      readonly text: string;
    }
  | {
      readonly status: 'rejected';
      readonly code: NvidiaProviderErrorCode;
      readonly message: string;
    };

function parseNvidiaResponseText(value: unknown): ParsedNvidiaResponseText {
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

  const content = message['content'];

  if (typeof content !== 'string') {
    return rejectResponse(
      'malformed_response',
      'NVIDIA response message.content must be a string.'
    );
  }

  if (content.length === 0) {
    return rejectResponse('empty_output', 'NVIDIA response content is empty.');
  }

  return Object.freeze({
    status: 'accepted',
    text: content
  } satisfies ParsedNvidiaResponseText);
}

function rejectResponse(
  code: NvidiaProviderErrorCode,
  message: string
): ParsedNvidiaResponseText {
  return Object.freeze({
    status: 'rejected',
    code,
    message
  } satisfies ParsedNvidiaResponseText);
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
