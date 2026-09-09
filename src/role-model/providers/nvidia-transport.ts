import {isJsonRecord} from '../../shared/json-boundary.ts';

export type NvidiaFetchRequest = {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
};

/** The provider's HTTP seam: fetch's own shape, injectable for tests. */
export type NvidiaFetchClient = (
  url: string,
  request: NvidiaFetchRequest,
) => Promise<Response>;

export type NvidiaRequestDeadline = {
  readonly signal: AbortSignal;
  readonly wait: <T>(operation: Promise<T>) => Promise<T>;
  /** Moves the deadline: the provider just sent something. */
  readonly touch: () => void;
  readonly dispose: () => void;
};

export const defaultNvidiaRoleModelRequestTimeoutMs = 30_000;

export const defaultNvidiaTransportRetryDelaysMs: readonly number[] =
  Object.freeze([250, 1000]);

export class NvidiaRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`NVIDIA provider request timed out after ${String(timeoutMs)}ms.`);
    this.name = 'NvidiaRequestTimeoutError';
  }
}

export function normalizeNvidiaRequestTimeoutMs(
  value: number | undefined,
): number {
  const timeoutMs = value ?? defaultNvidiaRoleModelRequestTimeoutMs;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      'NVIDIA provider request timeout must be a positive safe integer.',
    );
  }

  return timeoutMs;
}

export function normalizeNvidiaTransportRetryDelays(
  value: readonly number[] | undefined,
): readonly number[] {
  const delays = value ?? defaultNvidiaTransportRetryDelaysMs;

  for (const delayMs of delays) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new TypeError(
        'NVIDIA transport retry delays must be non-negative safe integers.',
      );
    }
  }

  return Object.freeze([...delays]);
}

/**
 * Bounds silence, not the exchange: the wait for the headers, then the wait
 * for each next chunk, each within `timeoutMs` of the last thing the
 * provider sent. A reply of any length streams as long as bytes keep
 * coming; a provider that goes quiet fails in `timeoutMs`. Expiry aborts
 * the request, and a rejection that arrives while the abort is set is the
 * timeout that caused it — the abort reaches the operation a microtask
 * ahead of the timer's own error.
 */
export function createNvidiaRequestDeadline(
  timeoutMs: number,
): NvidiaRequestDeadline {
  const controller = new AbortController();
  let deadlineAt = performance.now() + timeoutMs;
  const expire = (): NvidiaRequestTimeoutError => {
    controller.abort();
    return new NvidiaRequestTimeoutError(timeoutMs);
  };

  return Object.freeze({
    signal: controller.signal,
    async wait<T>(operation: Promise<T>): Promise<T> {
      if (performance.now() >= deadlineAt) {
        throw expire();
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(expire());
        }, deadlineAt - performance.now());
      });

      try {
        const result = await Promise.race([operation, expiry]);

        // Delivered late is not delivered within the bound: a body that
        // blocked the loop past the deadline is refused all the same.
        if (performance.now() >= deadlineAt) {
          throw expire();
        }

        return result;
      } catch (error: unknown) {
        throw controller.signal.aborted
          ? new NvidiaRequestTimeoutError(timeoutMs)
          : error;
      } finally {
        clearTimeout(timer);
      }
    },
    touch() {
      deadlineAt = performance.now() + timeoutMs;
    },
    dispose() {
      // Releases a body abandoned before its end; a finished one is unmoved.
      controller.abort();
    },
  });
}

/**
 * The body as it arrives, each chunk within the deadline, which every chunk
 * moves. A body left before its end is cancelled so the socket goes with it.
 */
export async function* readResponseChunks(
  response: Response,
  deadline: NvidiaRequestDeadline,
): AsyncGenerator<Uint8Array, void, undefined> {
  if (response.body === null) {
    return;
  }

  const reader = response.body.getReader();

  try {
    for (;;) {
      const read: Promise<unknown> = reader.read();
      const chunk = bytesOf(await deadline.wait(read));

      if (chunk === undefined) {
        return;
      }

      deadline.touch();
      yield chunk;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The bytes a read delivered, or nothing at the body's end; the body's own element type is erased. */
function bytesOf(result: unknown): Uint8Array | undefined {
  return isJsonRecord(result) && result['value'] instanceof Uint8Array
    ? result['value']
    : undefined;
}

export async function readResponseText(
  response: Response,
  deadline: NvidiaRequestDeadline,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';

  for await (const chunk of readResponseChunks(response, deadline)) {
    text += decoder.decode(chunk, {stream: true});
  }

  return text + decoder.decode();
}

type NvidiaTransportResult =
  | {
      readonly status: 'accepted';
      readonly httpStatus: number;
      /** Headers in, body unread: the caller reads it under the deadline. */
      readonly response: Response;
    }
  | {
      readonly status: 'rejected';
      readonly httpStatus: number;
      readonly message: string;
    };

/**
 * Retries only transport-class failures (network throws, HTTP 408/429/5xx),
 * all before a body is read. Headers of any status are the provider
 * speaking, so they move the silence bound; retries wait under it.
 */
export async function performNvidiaTransportRequest(options: {
  readonly fetchClient: NvidiaFetchClient;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly body: string;
  readonly requestDeadline: NvidiaRequestDeadline;
  readonly retryDelaysMs: readonly number[];
}): Promise<NvidiaTransportResult> {
  for (let attempt = 0; ; attempt += 1) {
    const retryDelayMs = options.retryDelaysMs[attempt];
    let response: Response;

    try {
      response = await options.requestDeadline.wait(
        options.fetchClient(options.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: options.body,
          signal: options.requestDeadline.signal,
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof NvidiaRequestTimeoutError ||
        retryDelayMs === undefined
      ) {
        throw error;
      }

      await waitForNvidiaRetryDelay(options.requestDeadline, retryDelayMs);
      continue;
    }

    // Headers in: the silence bound starts over for the body, whatever the status.
    options.requestDeadline.touch();

    if (response.ok) {
      return {
        status: 'accepted',
        httpStatus: response.status,
        response,
      };
    }

    const message = await responseErrorMessage(
      response,
      options.requestDeadline,
    );

    if (
      retryDelayMs === undefined ||
      !isRetryableNvidiaHttpStatus(response.status)
    ) {
      return {
        status: 'rejected',
        httpStatus: response.status,
        message,
      };
    }

    await waitForNvidiaRetryDelay(options.requestDeadline, retryDelayMs);
  }
}

function isRetryableNvidiaHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function waitForNvidiaRetryDelay(
  requestDeadline: NvidiaRequestDeadline,
  delayMs: number,
): Promise<void> {
  if (delayMs === 0) {
    return Promise.resolve();
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  return requestDeadline
    .wait(
      new Promise<void>(resolve => {
        timeoutId = setTimeout(resolve, delayMs);
      }),
    )
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

async function responseErrorMessage(
  response: Response,
  deadline: NvidiaRequestDeadline,
): Promise<string> {
  let text: string;

  try {
    text = await readResponseText(response, deadline);
  } catch (error: unknown) {
    if (error instanceof NvidiaRequestTimeoutError) {
      throw error;
    }

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

export function redactProviderSecret(
  message: string,
  secret: string | undefined,
): string {
  if (secret === undefined || secret.length === 0) {
    return message;
  }

  return message.split(secret).join('[redacted]');
}

/** Reasons a chat completion ends whole; anything else cut the output short. */
export const terminalNvidiaFinishReasons = Object.freeze([
  'stop',
  'tool_calls',
]);
