import {isJsonRecord} from '../../shared/json-boundary.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {scrubReasoningBlocks} from '../api/reasoning.ts';
import {
  createNvidiaRequestDeadline,
  NvidiaRequestTimeoutError,
  performNvidiaTransportRequest,
  redactProviderSecret,
  type NvidiaFetchClient,
} from './nvidia-transport.ts';

export const nvidiaTextCompletionProviderName = 'nvidia';

/**
 * A plain chat completion on the same model the character speaks through:
 * no tools, no persona, thinking off, output bounded by the caller's cap.
 * Every failure is reported, never thrown, with the key redacted.
 */
export function createNvidiaTextCompletion(options: {
  readonly apiKey?: string;
  readonly endpoint: string;
  readonly model: string;
  readonly fetchClient: NvidiaFetchClient;
  readonly requestTimeoutMs: number;
  readonly transportRetryDelaysMs: readonly number[];
}): NonNullable<RoleModelAdapter['completeText']> {
  return async request => {
    if (options.apiKey === undefined || options.apiKey.length === 0) {
      return {status: 'failed', reason: 'NVIDIA provider has no API key.'};
    }

    const requestDeadline = createNvidiaRequestDeadline(
      options.requestTimeoutMs,
    );

    try {
      const transport = await performNvidiaTransportRequest({
        fetchClient: options.fetchClient,
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        body: JSON.stringify({
          model: options.model,
          messages: [
            {role: 'system', content: request.instructions},
            {role: 'user', content: request.input},
          ],
          stream: false,
          temperature: 0.3,
          top_p: 1,
          max_tokens: Math.max(1, Math.ceil(request.maxOutputChars / 2)),
          chat_template_kwargs: {enable_thinking: false},
        }),
        requestDeadline,
        retryDelaysMs: options.transportRetryDelaysMs,
      });

      if (transport.status === 'rejected') {
        return {
          status: 'failed',
          reason: redactProviderSecret(transport.message, options.apiKey),
        };
      }

      const text = completionText(transport.responseBody);

      return text === undefined
        ? {status: 'failed', reason: 'NVIDIA completion returned no text.'}
        : {
            status: 'completed',
            text,
            provider: {
              name: nvidiaTextCompletionProviderName,
              model: options.model,
            },
          };
    } catch (error: unknown) {
      return {
        status: 'failed',
        reason:
          error instanceof NvidiaRequestTimeoutError
            ? error.message
            : redactProviderSecret(
                error instanceof Error ? error.message : String(error),
                options.apiKey,
              ),
      };
    } finally {
      requestDeadline.dispose();
    }
  };
}

function completionText(responseBody: unknown): string | undefined {
  if (!isJsonRecord(responseBody) || !Array.isArray(responseBody['choices'])) {
    return undefined;
  }

  const choice: unknown = responseBody['choices'][0];

  if (!isJsonRecord(choice) || !isJsonRecord(choice['message'])) {
    return undefined;
  }

  const content = choice['message']['content'];

  if (typeof content !== 'string') {
    return undefined;
  }

  const scrubbed = scrubReasoningBlocks(content);

  if (scrubbed.status === 'rejected') {
    return undefined;
  }

  const text = scrubbed.text.trim();

  return text.length === 0 ? undefined : text;
}
