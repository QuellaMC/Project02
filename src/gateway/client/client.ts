import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';

import {hc} from 'hono/client';

import {
  gatewayProtocolVersion,
  type AnswerOutcome,
  type GatewayConfirmationDecision,
  type GatewayEvent,
  type GatewayHealth,
  type GatewayMessage,
  type HistoryOutcome,
  type HistoryPage,
  type OpenOutcome,
  type PendingConfirmation,
  type StartOutcome,
  type TurnOutcome,
} from '../api/contract.ts';
import type {GatewayApp} from '../http/app.ts';
import {createSseFrameSplitter} from './sse.ts';

/** Where a client finds the daemon: the line `serve` prints, exported. */
export const gatewayUrlEnvVarName = 'PROJECT02_GATEWAY';

export type GatewayClientOptions =
  /** The line `serve` prints: `http://127.0.0.1:<port>/#token=<token>`. */
  {readonly url: string} | {readonly baseUrl: string; readonly token: string};

export type GatewayEventsOptions = {
  readonly signal: AbortSignal;
  /**
   * Runs on every `ready` frame; the caller reads its snapshots here. The
   * stream waits for a returned promise, so the snapshots are installed
   * before any event that followed the handshake is handed on — and a
   * bootstrap that fails ends the stream with its error.
   */
  readonly onReady?: (info: {
    readonly reconnected: boolean;
  }) => void | Promise<void>;
  /** The pause before reconnecting after the stream ends. */
  readonly retryMs?: number;
};

/**
 * The gateway's verbs from the far side of the socket. Domain outcomes come
 * back as they are; a transport failure is a `GatewayClientError`.
 */
export type GatewayClient = {
  readonly baseUrl: string;
  health(): Promise<GatewayHealth>;
  startCharacter(characterId: string): Promise<StartOutcome>;
  openDirectConversation(characterId: string): Promise<OpenOutcome>;
  /** Waits for the turn however long it takes, and is never retried. */
  deliver(message: GatewayMessage): Promise<TurnOutcome>;
  history(conversationId: string, page?: HistoryPage): Promise<HistoryOutcome>;
  pendingConfirmations(): Promise<readonly PendingConfirmation[]>;
  answerConfirmation(
    id: string,
    decision: GatewayConfirmationDecision,
  ): Promise<AnswerOutcome>;
  /**
   * Follows the event stream until the signal aborts, reconnecting after
   * the daemon closes it. A refused token or a wrong protocol rejects; a
   * daemon that is down or stopping is waited for.
   */
  events(
    listener: (event: GatewayEvent) => void,
    options: GatewayEventsOptions,
  ): Promise<void>;
};

/** The daemon answered with an error envelope, or could not be reached. */
export class GatewayClientError extends Error {
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GatewayClientError';
    this.status = status;
    this.code = code;
  }
}

const defaultRetryMs = 1_000;
const eventKinds: ReadonlySet<GatewayEvent['kind']> = new Set([
  'turn_progress',
  'turn_completed',
  'confirmation_requested',
  'confirmation_settled',
  'state_changed',
  'maintenance_failed',
]);

export function createGatewayClient(
  options: GatewayClientOptions,
): GatewayClient {
  const {baseUrl, token} = resolveOptions(options);
  const headers = {authorization: `Bearer ${token}`};
  const api = hc<GatewayApp>(baseUrl, {
    headers,
    fetch: fetchWithoutTimeouts,
  }).api;

  const client: GatewayClient = {
    baseUrl,
    async health() {
      const health = await readOutcome<GatewayHealth>(await api.health.$get());

      // Typed as this build's version; another daemon build answers here.
      assertProtocol(health);

      return health;
    },
    startCharacter: async characterId =>
      readOutcome<StartOutcome>(
        await api.characters[':id'].start.$post({param: {id: characterId}}),
      ),
    openDirectConversation: async characterId =>
      readOutcome<OpenOutcome>(
        await api.conversations.open.$post({json: {characterId}}),
      ),
    deliver: async message =>
      readOutcome<TurnOutcome>(await api.turns.$post({json: message})),
    history: async (conversationId, page = {}) =>
      readOutcome<HistoryOutcome>(
        await api.conversations[':id'].messages.$get({
          param: {id: conversationId},
          query: {
            ...(page.before === undefined ? {} : {before: page.before}),
            ...(page.limit === undefined ? {} : {limit: String(page.limit)}),
          },
        }),
      ),
    pendingConfirmations: async () =>
      readOutcome<readonly PendingConfirmation[]>(
        await api.confirmations.$get(),
      ),
    answerConfirmation: async (id, decision) =>
      readOutcome<AnswerOutcome>(
        await api.confirmations[':id'].$post({param: {id}, json: {decision}}),
      ),
    async events(listener, eventsOptions) {
      const {signal} = eventsOptions;
      const aborted = (): boolean => signal.aborted;
      const retryMs = eventsOptions.retryMs ?? defaultRetryMs;
      let reconnected = false;

      while (!aborted()) {
        try {
          const response = await fetchWithoutTimeouts(`${baseUrl}/api/events`, {
            headers,
            signal,
          });

          await rejectUnlessOk(response);
          await followStream(response, listener, async () => {
            const wasReconnect = reconnected;

            reconnected = true;
            await eventsOptions.onReady?.({reconnected: wasReconnect});
          });
        } catch (error: unknown) {
          if (aborted()) {
            return;
          }

          // A daemon that is down or stopping comes back; a refused token,
          // a wrong protocol, or a listener's own failure does not.
          if (
            !(error instanceof GatewayClientError) ||
            (error.status !== 0 && error.status !== 503)
          ) {
            throw error;
          }
        }

        await pause(retryMs, signal);
      }
    },
  };

  return client;
}

/**
 * The daemon is this codebase: each route answers with its verb's outcome,
 * typed on the server by the façade. That is the one trust this client
 * places in the wire, and it lives here alone.
 */
async function readOutcome<T>(response: Response): Promise<T> {
  await rejectUnlessOk(response);

  return JSON.parse(await readBody(response)) as T;
}

/** A body cut short or not JSON is a transport failure, never a raw throw. */
async function readBody(response: Response): Promise<string> {
  const text = await response.text().catch((error: unknown) => {
    throw new GatewayClientError(
      response.status,
      'malformed_response',
      `The daemon's answer was cut short: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  try {
    JSON.parse(text);
  } catch {
    throw new GatewayClientError(
      response.status,
      'malformed_response',
      `The daemon answered ${String(response.status)} with something other than JSON.`,
    );
  }

  return text;
}

function resolveOptions(options: GatewayClientOptions): {
  baseUrl: string;
  token: string;
} {
  const given = 'baseUrl' in options ? options.baseUrl : options.url;
  let url: URL;

  try {
    url = new URL(given);
  } catch {
    throw new GatewayClientError(
      0,
      'invalid_url',
      `Not a gateway URL: ${given}`,
    );
  }

  // The daemon speaks plain HTTP on loopback; anything else is a typo.
  if (url.protocol !== 'http:') {
    throw new GatewayClientError(
      0,
      'invalid_url',
      `A gateway URL starts with http://, not ${url.protocol}//: ${given}`,
    );
  }

  if ('baseUrl' in options) {
    return {baseUrl: url.origin, token: options.token};
  }

  const token = new URLSearchParams(url.hash.slice(1)).get('token');

  if (token === null || token.length === 0) {
    throw new GatewayClientError(
      0,
      'invalid_url',
      `The gateway URL carries no #token: ${options.url}`,
    );
  }

  return {baseUrl: url.origin, token};
}

/** Reads the stream until the daemon ends it, handing each event on. */
async function followStream(
  response: Response,
  listener: (event: GatewayEvent) => void,
  onReady: () => void | Promise<void>,
): Promise<void> {
  if (response.body === null) {
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const frames = createSseFrameSplitter();

  try {
    for (;;) {
      const {value, done} = await reader.read();

      if (done) {
        return;
      }

      for (const frame of frames.push(value)) {
        if (frame.data === undefined) {
          continue;
        }

        const data = parseFrameData(frame.data);

        if (frame.event === 'ready') {
          assertProtocol(data);
          await onReady();
        } else if (isGatewayEvent(data)) {
          listener(data);
        }
      }
    }
  } finally {
    // Whatever ended the loop, the socket does not outlive it.
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrameData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new GatewayClientError(
      200,
      'malformed_event',
      'The daemon sent an event that is not JSON.',
    );
  }
}

function assertProtocol(data: unknown): void {
  const version =
    typeof data === 'object' && data !== null && 'protocolVersion' in data
      ? data.protocolVersion
      : undefined;

  if (version !== gatewayProtocolVersion) {
    throw new GatewayClientError(
      200,
      'protocol_mismatch',
      `The daemon speaks protocol ${String(version)}; this client speaks ${String(gatewayProtocolVersion)}.`,
    );
  }
}

/**
 * The daemon is this codebase, so a frame with a known kind is an event of
 * that kind; one this client does not know is skipped, never a crash.
 */
function isGatewayEvent(data: unknown): data is GatewayEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    'kind' in data &&
    typeof data.kind === 'string' &&
    (eventKinds as ReadonlySet<string>).has(data.kind)
  );
}

async function rejectUnlessOk(response: Response): Promise<void> {
  if (response.status === 200) {
    return;
  }

  const text = await response.text().catch(() => '');
  let envelope: unknown;

  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = undefined;
  }

  const error =
    typeof envelope === 'object' && envelope !== null && 'error' in envelope
      ? envelope.error
      : undefined;
  const field = (name: string): string | undefined =>
    typeof error === 'object' &&
    error !== null &&
    name in error &&
    typeof (error as Record<string, unknown>)[name] === 'string'
      ? String((error as Record<string, unknown>)[name])
      : undefined;

  throw new GatewayClientError(
    response.status,
    field('code') ?? 'transport',
    field('message') ?? `The daemon answered ${String(response.status)}.`,
  );
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    signal.addEventListener('abort', onAbort, {once: true});
  });
}

/**
 * A fetch over node:http with no timeouts of its own. The global fetch
 * gives a response five minutes to start and its body five minutes between
 * chunks; a turn that waits on a person can outlast both, and this client
 * never retries a turn.
 */
function fetchWithoutTimeouts(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // The signal stays out of the Request: the platform would derive its own
  // and hold a listener on the caller's until garbage collection, and a
  // signal reused across reconnects must not collect one per stream.
  const {signal: given, ...rest} = init ?? {};
  const signal = given ?? undefined;
  const request = new Request(input, rest);

  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      reject(
        error instanceof GatewayClientError
          ? error
          : new GatewayClientError(
              0,
              'unreachable',
              `The daemon at ${request.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
            ),
      );
    };

    request.text().then(body => {
      try {
        if (signal?.aborted === true) {
          reject(
            new GatewayClientError(0, 'aborted', 'The request was aborted.'),
          );

          return;
        }

        const headers = Object.fromEntries(request.headers);

        if (body.length > 0) {
          headers['content-length'] = String(Buffer.byteLength(body));
        }

        const outgoing = httpRequest(
          request.url,
          {method: request.method, headers},
          incoming => {
            resolve(
              new Response(Readable.toWeb(incoming), {
                status: incoming.statusCode ?? 500,
                headers: Object.entries(incoming.headers).flatMap(
                  ([name, value]) =>
                    typeof value === 'string' ? [[name, value] as const] : [],
                ),
              }),
            );
          },
        );

        // The listener lives as long as the exchange: a signal reused across
        // reconnects must not keep every finished request alive.
        const onAbort = (): void => {
          outgoing.destroy(new Error('aborted'));
        };
        const release = (): void => {
          signal?.removeEventListener('abort', onAbort);
        };

        signal?.addEventListener('abort', onAbort, {once: true});
        outgoing.once('response', incoming => {
          incoming.once('close', release);
        });
        outgoing.once('close', release);
        outgoing.on('error', fail);
        outgoing.end(body);
      } catch (error: unknown) {
        // A request that cannot even be built fails like one that never connected.
        fail(error);
      }
    }, fail);
  });
}
