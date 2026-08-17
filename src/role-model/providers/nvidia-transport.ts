import {isJsonRecord} from '../../shared/json-boundary.ts';

export type NvidiaFetchRequest = {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
};

export type NvidiaFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type NvidiaFetchClient = (
  url: string,
  request: NvidiaFetchRequest,
) => Promise<NvidiaFetchResponse>;

type NvidiaRequestDeadline = {
  readonly signal: AbortSignal;
  readonly wait: <T>(operation: Promise<T>) => Promise<T>;
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

export function createNvidiaRequestDeadline(
  timeoutMs: number,
): NvidiaRequestDeadline {
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = (): NvidiaRequestTimeoutError => {
    controller.abort();
    return new NvidiaRequestTimeoutError(timeoutMs);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(timeoutError());
    }, timeoutMs);
  });

  return Object.freeze({
    signal: controller.signal,
    async wait<T>(operation: Promise<T>): Promise<T> {
      if (performance.now() >= deadlineAt) {
        throw timeoutError();
      }

      const result = await Promise.race([operation, timeout]);

      if (performance.now() >= deadlineAt) {
        throw timeoutError();
      }

      return result;
    },
    dispose() {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    },
  });
}

type NvidiaTransportResult =
  | {
      readonly status: 'accepted';
      readonly httpStatus: number;
      readonly responseBody: unknown;
    }
  | {
      readonly status: 'rejected';
      readonly httpStatus: number;
      readonly message: string;
    };

/**
 * Retries only transport-class failures (network throws, HTTP 408/429/5xx).
 * Retries share the request deadline and never extend it.
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
    let response: NvidiaFetchResponse;

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

    if (response.ok) {
      return {
        status: 'accepted',
        httpStatus: response.status,
        responseBody: await options.requestDeadline.wait(response.json()),
      };
    }

    const message = await options.requestDeadline.wait(
      responseErrorMessage(response),
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
  response: NvidiaFetchResponse,
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

export function redactProviderSecret(
  message: string,
  secret: string | undefined,
): string {
  if (secret === undefined || secret.length === 0) {
    return message;
  }

  return message.split(secret).join('[redacted]');
}

export async function defaultFetchClient(
  url: string,
  request: NvidiaFetchRequest,
): Promise<NvidiaFetchResponse> {
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });

  return Object.freeze({
    ok: response.ok,
    status: response.status,
    async json() {
      return await response.json();
    },
    async text() {
      return await response.text();
    },
  } satisfies NvidiaFetchResponse);
}

/** Reasons a chat completion ends whole; anything else cut the output short. */
export const terminalNvidiaFinishReasons = Object.freeze([
  'stop',
  'tool_calls',
]);
