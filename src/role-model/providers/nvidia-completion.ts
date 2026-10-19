import {isJsonRecord} from '../../shared/json-boundary.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {scrubReasoningBlocks} from '../api/reasoning.ts';
import {
  createNvidiaRequestDeadline,
  NvidiaRequestTimeoutError,
  performNvidiaTransportRequest,
  readResponseText,
  redactProviderSecret,
  terminalNvidiaFinishReasons,
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
    const requestDeadline = createNvidiaRequestDeadline(
      options.requestTimeoutMs,
    );

    try {
      const transport = await performNvidiaTransportRequest({
        fetchClient: options.fetchClient,
        endpoint: options.endpoint,
        ...(options.apiKey === undefined ? {} : {apiKey: options.apiKey}),
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

      const completion = completionText(
        JSON.parse(await readResponseText(transport.response, requestDeadline)),
      );

      return 'reason' in completion
        ? {status: 'failed', reason: completion.reason}
        : {
            status: 'completed',
            text: completion.text,
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

/**
 * A completion counts only when it ended whole: a recollection cut off at
 * the output limit would lose its newest part, which is the part that
 * matters most, so it is refused rather than stored.
 */
function completionText(
  responseBody: unknown,
): {readonly text: string} | {readonly reason: string} {
  const choice: unknown =
    isJsonRecord(responseBody) && Array.isArray(responseBody['choices'])
      ? responseBody['choices'][0]
      : undefined;

  if (!isJsonRecord(choice) || !isJsonRecord(choice['message'])) {
    return {reason: 'NVIDIA completion returned no text.'};
  }

  const finishReason = choice['finish_reason'];

  if (
    typeof finishReason !== 'string' ||
    !terminalNvidiaFinishReasons.includes(finishReason)
  ) {
    return {
      reason: `NVIDIA completion ended with finish_reason "${String(
        finishReason,
      )}" instead of finishing.`,
    };
  }

  const content = choice['message']['content'];
  const scrubbed =
    typeof content === 'string' ? scrubReasoningBlocks(content) : undefined;
  const text =
    scrubbed === undefined || scrubbed.status === 'rejected'
      ? ''
      : scrubbed.text.trim();

  return text.length === 0
    ? {reason: 'NVIDIA completion returned no text.'}
    : {text};
}
