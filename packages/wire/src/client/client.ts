import {
  gatewayLoopbackHostnames,
  gatewayProtocolVersion,
  type Answer,
  type AnswerBody,
  type AnswerOutcome,
  type ClientStamp,
  type ConfigChange,
  type ConfigChangeOutcome,
  type ConfigTarget,
  type ConfigView,
  type ConnectorConfigView,
  type GatewayReady,
  type GatewayEvent,
  type GatewayHealth,
  type GatewayMessage,
  type HistoryOutcome,
  type OpenConversationBody,
  type OpenOutcome,
  type PairingRequest,
  type PairingRequestBody,
  type PairingRequestOutcome,
  type PairingSettleOutcome,
  type PairingSubject,
  type PendingConfirmation,
  type StartOutcome,
  type TurnOutcome,
} from '../contract/index.ts';
import {createSseFrameSplitter} from './sse.ts';

/**
 * Which page of a conversation's scrollback to read: the cursor a previous
 * page returned, for the messages before it, and how many, 1 to 500, 100
 * unless given. The query carries both as text, which the daemon judges.
 */
export type HistoryPage = {
  readonly before?: string;
  readonly limit?: string | number;
};

export type GatewayClientOptions =
  | {
      /** The line `serve` prints: `http://127.0.0.1:<port>/#token=<token>`. */
      readonly url: string;
    }
  | {readonly baseUrl: string; readonly token: string};

/** Cancels a verb's request: its socket is destroyed and the call rejects. */
export type GatewayCallOptions = {
  readonly signal?: AbortSignal;
};

export type GatewayEventsOptions = {
  readonly signal: AbortSignal;
  /**
   * Runs on every `ready` frame with the daemon's snapshot at that moment.
   * The stream waits for a returned promise, so whatever the caller
   * installs from it is in place before any event that followed the
   * handshake is handed on — and a bootstrap that fails ends the stream
   * with its error.
   */
  readonly onReady?: (info: {
    readonly reconnected: boolean;
    readonly snapshot: GatewayReady;
  }) => void | Promise<void>;
  /**
   * Runs when the stream ends before the caller aborts it — the daemon
   * down, stopping, or gone from its socket — and a reconnect is coming;
   * the next `ready` or `resumed` says it is back.
   */
  readonly onLost?: () => void;
  /**
   * Runs when a reconnect resumed the stream: the daemon still held the
   * frame this client last applied, so what follows is exactly what it
   * missed, in order, and nothing is installed.
   */
  readonly onResumed?: () => void;
  /** The pause before reconnecting after the stream ends. */
  readonly retryMs?: number;
  /** Names this client as a connector's process, so the daemon's health says it is on the stream. */
  readonly connector?: string;
};

/**
 * The gateway's verbs from the far side of the socket, in Node and in a
 * browser tab alike. Domain outcomes come back as they are; a transport
 * failure is a `GatewayClientError`.
 */
export type GatewayClient = {
  readonly baseUrl: string;
  health(options?: GatewayCallOptions): Promise<GatewayHealth>;
  startCharacter(
    characterId: string,
    options?: GatewayCallOptions,
  ): Promise<StartOutcome>;
  openDirectConversation(
    characterId: string,
    options?: GatewayCallOptions,
  ): Promise<OpenOutcome>;
  /**
   * Waits for the turn, however long, and is never retried, unless the
   * caller's signal ends the wait; the turn runs on without it.
   */
  deliver(
    message: GatewayMessage,
    options?: GatewayCallOptions,
  ): Promise<TurnOutcome>;
  history(
    conversationId: string,
    page?: HistoryPage,
    options?: GatewayCallOptions,
  ): Promise<HistoryOutcome>;
  pendingConfirmations(
    options?: GatewayCallOptions,
  ): Promise<readonly PendingConfirmation[]>;
  answerConfirmation(
    id: string,
    decision: Answer,
    options?: GatewayCallOptions,
  ): Promise<AnswerOutcome>;
  configView(
    target: ConfigTarget,
    options?: GatewayCallOptions,
  ): Promise<ConfigView>;
  applyConfigChange(
    change: ConfigChange,
    options?: GatewayCallOptions,
  ): Promise<ConfigChangeOutcome>;
  connectorConfig(
    connectorId: string,
    options?: GatewayCallOptions,
  ): Promise<ConnectorConfigView>;
  requestPairing(
    connectorId: string,
    subject: PairingSubject,
    source: ClientStamp,
    options?: GatewayCallOptions,
  ): Promise<PairingRequestOutcome>;
  pendingPairings(
    options?: GatewayCallOptions,
  ): Promise<readonly PairingRequest[]>;
  settlePairing(
    code: string,
    decision: Answer,
    options?: GatewayCallOptions,
  ): Promise<PairingSettleOutcome>;
  /**
   * Follows the event stream until the signal aborts, reconnecting after
   * the daemon closes it with the id of the last frame it handed on, so a
   * daemon that still holds that frame resumes the stream instead of
   * starting it over. A refused token or a wrong protocol rejects; a
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
  'pairing_requested',
  'pairing_settled',
  'state_changed',
  'health_changed',
  'maintenance_failed',
]);

export function createGatewayClient(
  options: GatewayClientOptions,
): GatewayClient {
  const {baseUrl, token} = resolveOptions(options);
  const guardedFetch = createGuardedFetch(fetch);
  const headers = {authorization: `Bearer ${token}`};
  const route = createRoutes(baseUrl, headers, guardedFetch);

  // The routes of protocol 7, one per verb: each its method and path, the
  // body the daemon reads and the outcome it answers under 200.
  const client: GatewayClient = {
    baseUrl,
    async health(callOptions) {
      const health = await route.get<GatewayHealth>('/api/health', callOptions);

      // Typed as this build's version; another daemon build answers here.
      assertProtocol(health);

      return health;
    },
    startCharacter: (characterId, callOptions) =>
      route.post<StartOutcome>(
        `/api/characters/${segment(characterId)}/start`,
        undefined,
        callOptions,
      ),
    openDirectConversation: (characterId, callOptions) =>
      route.post<OpenOutcome>(
        '/api/conversations/open',
        {characterId} satisfies OpenConversationBody,
        callOptions,
      ),
    deliver: (message, callOptions) =>
      route.post<TurnOutcome>('/api/turns', message, callOptions),
    history: (conversationId, page = {}, callOptions) =>
      route.get<HistoryOutcome>(
        `/api/conversations/${segment(conversationId)}/messages${query({
          before: page.before,
          limit: page.limit === undefined ? undefined : String(page.limit),
        })}`,
        callOptions,
      ),
    pendingConfirmations: callOptions =>
      route.get<PendingConfirmation[]>('/api/confirmations', callOptions),
    answerConfirmation: (id, decision, callOptions) =>
      route.post<AnswerOutcome>(
        `/api/confirmations/${segment(id)}`,
        {decision} satisfies AnswerBody,
        callOptions,
      ),
    configView: (target, callOptions) =>
      route.get<ConfigView>(
        `/api/config${query(
          target.scope === 'global'
            ? {scope: 'global'}
            : {scope: 'character', characterId: target.characterId},
        )}`,
        callOptions,
      ),
    applyConfigChange: (change, callOptions) =>
      route.post<ConfigChangeOutcome>('/api/config', change, callOptions),
    connectorConfig: (connectorId, callOptions) =>
      route.get<ConnectorConfigView>(
        `/api/connectors/${segment(connectorId)}/config`,
        callOptions,
      ),
    requestPairing: (connectorId, subject, source, callOptions) =>
      route.post<PairingRequestOutcome>(
        `/api/connectors/${segment(connectorId)}/pairing`,
        {subject, source} satisfies PairingRequestBody,
        callOptions,
      ),
    pendingPairings: callOptions =>
      route.get<PairingRequest[]>('/api/pairing', callOptions),
    settlePairing: (code, decision, callOptions) =>
      route.post<PairingSettleOutcome>(
        `/api/pairing/${segment(code)}`,
        {decision} satisfies AnswerBody,
        callOptions,
      ),
    async events(listener, eventsOptions) {
      const {signal, connector} = eventsOptions;
      const aborted = (): boolean => signal.aborted;
      const retryMs = eventsOptions.retryMs ?? defaultRetryMs;
      let reconnected = false;
      // The id of the last frame handed on and applied, sent back on
      // every reconnect: a frame the caller never applied is asked for
      // again, and a `resumed` frame carries no id and moves nothing.
      const cursor = {lastEventId: undefined as string | undefined};

      while (!aborted()) {
        try {
          const response = await guardedFetch(
            `${baseUrl}/api/events${query({connector})}`,
            {
              headers:
                cursor.lastEventId === undefined
                  ? headers
                  : {...headers, 'last-event-id': cursor.lastEventId},
              signal,
            },
          );

          await rejectUnlessOk(response);
          await followStream(
            response,
            {
              listener,
              async onReady(snapshot) {
                const wasReconnect = reconnected;

                reconnected = true;
                await eventsOptions.onReady?.({
                  reconnected: wasReconnect,
                  snapshot,
                });
              },
              onResumed: () => {
                eventsOptions.onResumed?.();
              },
              cursor,
            },
            signal,
          );
        } catch (error: unknown) {
          if (aborted()) {
            return;
          }

          // The caller's own failure is the caller's, whatever it threw.
          // A daemon that is down or stopping comes back; a refused token
          // or a wrong protocol does not.
          if (error instanceof CallbackFailure) {
            throw error.cause;
          }

          if (
            !(error instanceof GatewayClientError) ||
            (error.status !== 0 && error.status !== 503)
          ) {
            throw error;
          }
        }

        eventsOptions.onLost?.();
        await pause(retryMs, signal);
      }
    },
  };

  return client;
}

/**
 * A verb's request, and its answer read: a 200 is the route's outcome as
 * the contract declares it, which the daemon's own types generate, and
 * anything else the envelope of a transport refusal. That is the one trust
 * this client places in the wire, and it lives here alone; the conformance
 * suite holds every daemon's answers to the same declarations.
 */
function createRoutes(
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  transport: typeof fetch,
): {
  get<Outcome>(path: string, options?: GatewayCallOptions): Promise<Outcome>;
  post<Outcome>(
    path: string,
    body: object | undefined,
    options?: GatewayCallOptions,
  ): Promise<Outcome>;
} {
  const send = async (
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
    options: GatewayCallOptions | undefined,
  ): Promise<unknown> => {
    const response = await transport(`${baseUrl}${path}`, {
      method,
      headers:
        body === undefined
          ? headers
          : {...headers, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });

    await rejectUnlessOk(response);

    return readJson(response, options?.signal);
  };

  return {
    get: async <Outcome>(path: string, options?: GatewayCallOptions) =>
      (await send('GET', path, undefined, options)) as Outcome,
    post: async <Outcome>(
      path: string,
      body: object | undefined,
      options?: GatewayCallOptions,
    ) => (await send('POST', path, body, options)) as Outcome,
  };
}

/**
 * A value as one segment of a path: the daemon reads it back as given,
 * whatever characters it holds, and never as a path of its own.
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/** The query of the parameters given, none when none is. */
function query(
  parameters: Readonly<Record<string, string | undefined>>,
): string {
  const given = Object.entries(parameters).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );

  return given.length === 0 ? '' : `?${new URLSearchParams(given).toString()}`;
}

/**
 * A body cut short or not JSON is a transport failure, never a raw throw —
 * unless the caller cut it short itself, which is its abort and not the
 * daemon's fault.
 */
async function readJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await response.text().catch((error: unknown) => {
    if (signal?.aborted === true) {
      throw abortedRequest();
    }

    throw new GatewayClientError(
      response.status,
      'malformed_response',
      `The daemon's answer was cut short: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayClientError(
      response.status,
      'malformed_response',
      `The daemon answered ${String(response.status)} with something other than JSON.`,
    );
  }
}

function resolveOptions(options: GatewayClientOptions): {
  baseUrl: string;
  token: string;
} {
  const given = 'baseUrl' in options ? options.baseUrl : options.url;
  // The token rides the fragment to stay out of logs; an error about the
  // URL must not put it there, whatever the fragment holds.
  const shown = given.split('#', 1)[0] ?? given;
  let url: URL;

  try {
    url = new URL(given);
  } catch {
    throw new GatewayClientError(
      0,
      'invalid_url',
      `Not a gateway URL: ${shown}`,
    );
  }

  // The daemon speaks plain HTTP on loopback; anything else is a typo, and
  // a token or a thread must never go anywhere else in the clear.
  if (url.protocol !== 'http:') {
    throw new GatewayClientError(
      0,
      'invalid_url',
      `A gateway URL starts with http://, not ${url.protocol}//: ${shown}`,
    );
  }

  if (!gatewayLoopbackHostnames.has(url.hostname)) {
    throw new GatewayClientError(
      0,
      'invalid_url',
      `A gateway URL points at this machine (127.0.0.1 or localhost), not ${url.hostname}: ${shown}`,
    );
  }

  const token =
    'baseUrl' in options
      ? options.token
      : new URLSearchParams(url.hash.slice(1)).get('token');

  // The token rides a header, so it must be one line of printable ASCII;
  // anything else could not even be sent, and would fail as a raw throw.
  if (token === null || !/^[\x21-\x7E]+$/u.test(token)) {
    throw new GatewayClientError(
      0,
      'invalid_url',
      token === null || token.length === 0
        ? `The gateway URL carries no #token: ${shown}`
        : `The gateway token is not a usable header value: ${shown}`,
    );
  }

  return {baseUrl: url.origin, token};
}

/**
 * What the caller's listener or bootstrap threw, told apart from what the
 * stream did: a bootstrap's own request may fail with the same shape the
 * transport uses, and that is never a reason to reconnect.
 */
class CallbackFailure extends Error {
  constructor(cause: unknown) {
    super('A stream callback failed.', {cause});
  }
}

/** Runs the caller's code; what it throws is its own, never the stream's. */
async function ownFailure<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw new CallbackFailure(error);
  }
}

type StreamFollower = {
  readonly listener: (event: GatewayEvent) => void;
  readonly onReady: (snapshot: GatewayReady) => void | Promise<void>;
  readonly onResumed: () => void;
  /** Advanced only once a frame's callback returned: what is applied is what is asked for next. */
  readonly cursor: {lastEventId: string | undefined};
};

/** Reads the stream until the daemon ends it, handing each event on. */
async function followStream(
  response: Response,
  follower: StreamFollower,
  signal: AbortSignal,
): Promise<void> {
  if (response.body === null) {
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const frames = createSseFrameSplitter();

  try {
    for (;;) {
      // A connection the daemon severed is the daemon going away, not a
      // fault of this client's: it is retried like a refused connection.
      const {value, done} = await reader.read().catch((error: unknown) => {
        throw new GatewayClientError(
          0,
          'unreachable',
          `The stream from the daemon broke: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

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
          // The daemon is this codebase: past the protocol check, the
          // snapshot is the contract's shape.
          await bootstrapOrAbort(
            () => ownFailure(() => follower.onReady(data as GatewayReady)),
            signal,
          );
        } else if (frame.event === 'resumed') {
          await ownFailure(() => {
            follower.onResumed();
          });
        } else if (isGatewayEvent(data)) {
          await ownFailure(() => {
            follower.listener(data);
          });
        }

        if (frame.id !== undefined) {
          follower.cursor.lastEventId = frame.id;
        }
      }
    }
  } finally {
    // Whatever ended the loop, the socket does not outlive it.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Runs the caller's bootstrap, but an abort must not wait out a request
 * of its that hangs: the abort wins the race and a late result is
 * discarded. The abort listener lives only for the wait.
 */
async function bootstrapOrAbort(
  onReady: () => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new GatewayClientError(0, 'aborted', 'The stream was aborted.'));
    };
  });

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, {once: true});
  }

  try {
    await Promise.race([
      Promise.resolve(onReady()).catch((error: unknown) => {
        if (!signal.aborted) {
          throw error;
        }
      }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Nobody may be listening by the time it rejects; that is not a fault.
    aborted.catch(() => undefined);
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

/** The caller's own abort, whenever in the exchange it lands. */
function abortedRequest(): GatewayClientError {
  return new GatewayClientError(0, 'aborted', 'The request was aborted.');
}

/** The platform's fetch says `fetch failed` and keeps the reason in `cause`. */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return error.cause instanceof Error
    ? `${error.message}: ${error.cause.message}`
    : error.message;
}

/**
 * A fetch, guarded. Every request runs under a signal of its own, derived
 * from the caller's: the platform keeps a listener on a signal it is
 * handed until the request is collected, and a signal reused across
 * reconnects must not gather one per stream. A rejection is named for what
 * it is — the caller's abort, or a daemon that could not be reached, with
 * the fetch's reason.
 */
function createGuardedFetch(transport: typeof fetch): typeof fetch {
  return (input, init) => {
    const {signal, ...rest} = init ?? {};
    const target =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (signal?.aborted === true) {
      return Promise.reject(abortedRequest());
    }

    return transport(input, {
      ...rest,
      ...(signal === undefined || signal === null
        ? {}
        : {signal: AbortSignal.any([signal])}),
    }).catch((error: unknown) => {
      if (signal?.aborted === true) {
        throw abortedRequest();
      }

      throw new GatewayClientError(
        0,
        'unreachable',
        `The daemon at ${target} could not be reached: ${describeFetchFailure(error)}`,
      );
    });
  };
}
