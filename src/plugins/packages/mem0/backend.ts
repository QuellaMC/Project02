import {createHash} from 'node:crypto';
import {join, parse, resolve} from 'node:path';

import {
  chmodPathSync,
  listDirectoryNamesSync,
  makeDirectorySync,
} from '../../../shared/file-system.ts';
import {firstUnacceptableComponent} from '../../../shared/real-path.ts';

import {isRecord} from '../../api/validation-primitives.ts';
import type {RuntimePluginSourceReference} from '../../api/types.ts';

export type Mem0ChatMessage = {
  readonly role: 'user' | 'assistant';
  readonly content: string;
};

export type Mem0MemoryHit = {
  readonly id: string;
  readonly text: string;
  readonly score?: number;
};

export type Mem0SearchOptions = {
  readonly query: string;
  readonly userId: string;
  readonly agentId: string;
  readonly limit: number;
  readonly signal: AbortSignal;
};

export type Mem0AddOptions = {
  readonly messages: readonly Mem0ChatMessage[];
  readonly userId: string;
  readonly agentId: string;
  readonly runId?: string;
  readonly infer: boolean;
  /** Turn provenance the backend keeps as metadata beside the memory. */
  readonly sourceIds?: readonly string[];
  readonly signal: AbortSignal;
};

/**
 * One seam, three contracts: the platform API (v3, Token auth, async add
 * acknowledgements), the self-hosted server (unversioned paths,
 * Bearer/X-API-Key auth), and the embedded engine running in-process with
 * its own extraction model and embedder.
 */
export type Mem0Backend = {
  search(options: Mem0SearchOptions): Promise<readonly Mem0MemoryHit[]>;
  add(
    options: Mem0AddOptions,
  ): Promise<readonly RuntimePluginSourceReference[]>;
  /** Resolves with what readiness was actually established. */
  /**
   * Reports what the check actually established: `verified` false means
   * nothing was contacted, so health must not call the backend healthy on
   * the strength of it.
   */
  ping(options: {readonly signal: AbortSignal}): Promise<Mem0Readiness>;
};

export type Mem0Readiness = {
  readonly verified: boolean;
  readonly summary: string;
};

export type Mem0FetchFunction = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
    /**
     * Always 'manual'. An X-API-Key header is not stripped on redirect the
     * way Authorization is, and a 307 resends the body, so a redirect must
     * never be followed. Refusing it as the 3xx response it is -- rather
     * than a rejected fetch -- reports the endpoint's real status instead
     * of a fake outage.
     */
    readonly redirect: 'manual';
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export type Mem0RequestFailureKind =
  'http' | 'network' | 'malformed_response' | 'nothing_stored' | 'cancelled';

export class Mem0RequestError extends Error {
  readonly failureKind: Mem0RequestFailureKind;

  constructor(options: {
    readonly operation: string;
    readonly failureKind: Mem0RequestFailureKind;
    readonly status?: number;
  }) {
    super(mem0RequestErrorMessage(options));
    this.name = 'Mem0RequestError';
    this.failureKind = options.failureKind;
  }
}

function mem0RequestErrorMessage(options: {
  readonly operation: string;
  readonly failureKind: Mem0RequestFailureKind;
  readonly status?: number;
}): string {
  switch (options.failureKind) {
    case 'http':
      return `mem0 ${options.operation} failed: HTTP ${String(options.status ?? 0)}.`;
    case 'malformed_response':
      return `mem0 ${options.operation} failed: backend returned an unreadable response body.`;
    case 'network':
      return `mem0 ${options.operation} failed: backend unreachable.`;
    case 'nothing_stored':
      return `mem0 ${options.operation} failed: the backend created no memory for it.`;
    case 'cancelled':
      return `mem0 ${options.operation} was cancelled before the engine answered.`;
  }
}

export const mem0PlatformBaseUrl = 'https://api.mem0.ai';

export function createMem0PlatformBackend(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchFn?: Mem0FetchFunction;
}): Mem0Backend {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? mem0PlatformBaseUrl);
  const headers = Object.freeze({
    Authorization: `Token ${options.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  return Object.freeze({
    async search(searchOptions) {
      const response = await mem0Request({
        fetchFn,
        operation: 'search',
        url: `${baseUrl}/v3/memories/search/`,
        method: 'POST',
        requiresDocument: true,
        headers,
        body: {
          query: searchOptions.query,
          filters: {
            user_id: searchOptions.userId,
            agent_id: searchOptions.agentId,
          },
          top_k: searchOptions.limit,
        },
        signal: searchOptions.signal,
      });

      return memoryHitsFromResponse(response, 'search');
    },
    async add(addOptions) {
      const response = await mem0Request({
        fetchFn,
        operation: 'add',
        url: `${baseUrl}/v3/memories/add/`,
        method: 'POST',
        requiresDocument: true,
        headers,
        body: {
          messages: addOptions.messages,
          user_id: addOptions.userId,
          agent_id: addOptions.agentId,
          ...(addOptions.runId === undefined ? {} : {run_id: addOptions.runId}),
          infer: addOptions.infer,
          ...mem0SourceMetadata(addOptions.sourceIds),
        },
        signal: addOptions.signal,
      });

      return queuedAddReference(response, 'add');
    },
    async ping(pingOptions) {
      await mem0Request({
        fetchFn,
        operation: 'ping',
        url: `${baseUrl}/v1/ping/`,
        method: 'GET',
        headers,
        signal: pingOptions.signal,
      });

      return {verified: true, summary: 'Mem0 platform API reachable.'};
    },
  } satisfies Mem0Backend);
}

export function createMem0ServerBackend(options: {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetchFn?: Mem0FetchFunction;
}): Mem0Backend {
  const baseUrl = trimTrailingSlash(options.baseUrl);
  const headers = Object.freeze({
    ...serverAuthHeaders(options.apiKey),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  return Object.freeze({
    async search(searchOptions) {
      const response = await mem0Request({
        fetchFn,
        operation: 'search',
        url: `${baseUrl}/search`,
        method: 'POST',
        requiresDocument: true,
        headers,
        body: {
          query: searchOptions.query,
          user_id: searchOptions.userId,
          agent_id: searchOptions.agentId,
          limit: searchOptions.limit,
        },
        signal: searchOptions.signal,
      });

      return memoryHitsFromResponse(response, 'search');
    },
    async add(addOptions) {
      const response = await mem0Request({
        fetchFn,
        operation: 'add',
        url: `${baseUrl}/memories`,
        method: 'POST',
        requiresDocument: true,
        headers,
        body: {
          messages: addOptions.messages,
          user_id: addOptions.userId,
          agent_id: addOptions.agentId,
          ...(addOptions.runId === undefined ? {} : {run_id: addOptions.runId}),
          infer: addOptions.infer,
          ...mem0SourceMetadata(addOptions.sourceIds),
        },
        signal: addOptions.signal,
      });

      return storedAddReferences(response, 'add');
    },
    async ping(pingOptions) {
      await mem0Request({
        fetchFn,
        operation: 'ping',
        url: `${baseUrl}/`,
        method: 'GET',
        headers,
        signal: pingOptions.signal,
      });

      return {verified: true, summary: 'Mem0 server reachable.'};
    },
  } satisfies Mem0Backend);
}

/** Where a memory came from, kept beside it as the backend's own metadata. */
function mem0SourceMetadata(
  sourceIds: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
  return sourceIds === undefined || sourceIds.length === 0
    ? {}
    : {metadata: {project02_sources: [...sourceIds]}};
}

/** Server keys prefixed m0sk_ are per-user API keys; anything else is a JWT. */
function serverAuthHeaders(
  apiKey: string | undefined,
): Readonly<Record<string, string>> {
  if (apiKey === undefined) {
    return Object.freeze({});
  }

  return Object.freeze(
    apiKey.startsWith('m0sk_')
      ? {'X-API-Key': apiKey}
      : {Authorization: `Bearer ${apiKey}`},
  );
}

async function mem0Request(options: {
  readonly fetchFn: Mem0FetchFunction;
  readonly operation: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly requiresDocument?: boolean;
}): Promise<unknown> {
  let response;

  try {
    response = await options.fetchFn(options.url, {
      method: options.method,
      headers: options.headers,
      ...(options.body === undefined
        ? {}
        : {body: JSON.stringify(options.body)}),
      signal: options.signal,
      redirect: 'manual',
    });
  } catch {
    // Never rethrow transport errors: their messages can embed URLs and
    // headers, and the api key must not leak into evidence.
    throw new Mem0RequestError({
      operation: options.operation,
      failureKind: 'network',
    });
  }

  if (!response.ok) {
    throw new Mem0RequestError({
      operation: options.operation,
      failureKind: 'http',
      status: response.status,
    });
  }

  try {
    return await response.json();
  } catch {
    // Health only needs the status line, but a search or add that answers
    // 2xx with an unreadable body is a broken deployment: reporting it as
    // an empty result would read as "no memories".
    if (options.requiresDocument !== true) {
      return undefined;
    }

    throw new Mem0RequestError({
      operation: options.operation,
      failureKind: 'malformed_response',
      status: response.status,
    });
  }
}

function memoryHitsFromResponse(
  value: unknown,
  operation: string,
): readonly Mem0MemoryHit[] {
  const rows = requiredResultRows(value, operation);

  return Object.freeze(
    rows.map(row => {
      const id = isRecord(row) ? stringId(row['id']) : undefined;
      const text = isRecord(row)
        ? firstString(row['memory'], row['text'])
        : undefined;

      // Dropping a row this adapter cannot read would leave an
      // incompatible backend indistinguishable from an empty store.
      if (id === undefined || text === undefined) {
        throw new Mem0RequestError({
          operation,
          failureKind: 'malformed_response',
        });
      }

      const score = isRecord(row) ? row['score'] : undefined;

      return Object.freeze({
        id,
        text,
        ...(typeof score === 'number' ? {score} : {}),
      } satisfies Mem0MemoryHit);
    }),
  );
}

/**
 * The platform acknowledges adds asynchronously: only an event receipt
 * proves a queue exists, and stored memory ids only exist after
 * server-side processing.
 */
function queuedAddReference(
  value: unknown,
  operation: string,
): readonly RuntimePluginSourceReference[] {
  const eventId = isRecord(value) ? stringId(value['event_id']) : undefined;

  if (eventId === undefined) {
    throw new Mem0RequestError({
      operation,
      failureKind: 'malformed_response',
    });
  }

  return Object.freeze([
    {
      kind: 'external_contract',
      id: eventId,
      title: 'Queued mem0 memory write',
    },
  ]);
}

/**
 * The server stores synchronously, so every row must name what it stored.
 * A receipt-shaped or unreadable row here is a wrong deployment, and
 * dropping it would leave that indistinguishable from a smaller store.
 */
function storedAddReferences(
  value: unknown,
  operation: string,
): readonly RuntimePluginSourceReference[] {
  return Object.freeze(
    requiredResultRows(value, operation).map(row => {
      const id = isRecord(row) ? stringId(row['id']) : undefined;

      if (id === undefined) {
        throw new Mem0RequestError({
          operation,
          failureKind: 'malformed_response',
        });
      }

      return {kind: 'memory' as const, id, title: 'Mem0 memory'};
    }),
  );
}

/**
 * A 2xx body that decodes but carries no result array (an error envelope
 * from a proxy, say) is a broken deployment: treating it as "no memories"
 * would hide the failure behind an ordinary empty answer.
 */
function requiredResultRows(
  value: unknown,
  operation: string,
): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value) && Array.isArray(value['results'])) {
    return value['results'];
  }

  throw new Mem0RequestError({
    operation,
    failureKind: 'malformed_response',
  });
}

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Every supported backend speaks the OpenAI wire format, so the settings
 * are just endpoints, optional keys, and model names. Local servers
 * (LM Studio, Ollama's /v1, llama.cpp) ignore auth, but the client
 * library insists on a key string, so one is injected when unset.
 */
export const mem0OssPlaceholderApiKey = 'no-key-required';

/** Vector widths for common embedding models; the store must match. */
const mem0OssEmbedderDimsByModelKeyword: readonly (readonly [
  string,
  number,
])[] = Object.freeze([
  ['text-embedding-3-large', 3072],
  ['text-embedding-3-small', 1536],
  ['ada-002', 1536],
  ['nomic', 768],
  ['mxbai-embed-large', 1024],
  ['all-minilm', 384],
]);
const mem0OssFallbackEmbedderDims = 1536;

/** What the engine uses when the embedder model and endpoint go unset. */
export const mem0OssDefaultEmbedderModel = 'text-embedding-3-small';
const mem0OssDefaultEmbedderEndpoint = 'https://api.openai.com/v1';

export function mem0OssEmbedderDimsForModel(model: string | undefined): number {
  if (model === undefined) {
    return mem0OssFallbackEmbedderDims;
  }

  const normalized = model.toLowerCase();

  for (const [keyword, dims] of mem0OssEmbedderDimsByModelKeyword) {
    if (normalized.includes(keyword)) {
      return dims;
    }
  }

  return mem0OssFallbackEmbedderDims;
}

export type Mem0OssSettings = {
  readonly llmModel?: string;
  readonly llmApiKey?: string;
  /** Unset means the OpenAI cloud endpoint, which requires a key. */
  readonly llmBaseUrl?: string;
  readonly embedderModel?: string;
  readonly embedderApiKey?: string;
  readonly embedderBaseUrl?: string;
  readonly embedderDims?: number;
  /** Engine SQLite files (vectors, history) live under this directory. */
  readonly storageDir: string;
};

/**
 * The embedded engine's own call surface; in-process, so operations carry
 * no abort signal and rely on the hook timeout for bounding.
 */
export type Mem0OssEngine = {
  add(
    messages: readonly Mem0ChatMessage[],
    options: {
      readonly userId: string;
      readonly agentId: string;
      readonly runId?: string;
      readonly infer: boolean;
      readonly metadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<unknown>;
  search(
    query: string,
    options: {
      readonly topK: number;
      readonly filters: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
};

export type Mem0OssEngineLoader = (options: {
  readonly signal: AbortSignal;
}) => Promise<Mem0OssEngine>;

/**
 * Vectors are only comparable within the embedder that produced them, and
 * the embedder is reloadable: naming the collection after its identity
 * starts a fresh one when that changes, instead of ranking two embedding
 * spaces against each other or failing inserts on a width change.
 */
function mem0OssCollectionName(
  settings: Mem0OssSettings,
  dimension: number,
): string {
  // The effective identity, not what was typed: spelling out a default --
  // the model the engine already uses, or the OpenAI endpoint it already
  // calls -- must land in the same collection, or an operator who writes
  // one down loses every memory behind it.
  const identity = [
    (settings.embedderModel ?? mem0OssDefaultEmbedderModel).toLowerCase(),
    canonicalEndpoint(settings.embedderBaseUrl),
    String(dimension),
  ].join('\u0000');

  return `memories_${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

function canonicalEndpoint(baseUrl: string | undefined): string {
  if (baseUrl === undefined) {
    return mem0OssDefaultEmbedderEndpoint;
  }

  try {
    const url = new URL(baseUrl);

    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return baseUrl;
  }
}

export function mem0OssEngineConfig(
  settings: Mem0OssSettings,
): Readonly<Record<string, unknown>> {
  const dimension =
    settings.embedderDims ??
    mem0OssEmbedderDimsForModel(settings.embedderModel);

  return Object.freeze({
    // Captured turns carry speaker names in their text; this keeps the
    // extractor from reverting to role labels that mean nothing in
    // roleplay.
    customInstructions:
      'Refer to people by the names used in the conversation; never call anyone "user" or "assistant".',
    llm: Object.freeze({
      provider: 'openai',
      config: providerConfig({
        model: settings.llmModel,
        apiKey: settings.llmApiKey ?? mem0OssPlaceholderApiKey,
        baseUrl: settings.llmBaseUrl,
      }),
    }),
    embedder: Object.freeze({
      provider: 'openai',
      config: providerConfig({
        model: settings.embedderModel,
        apiKey: settings.embedderApiKey ?? mem0OssPlaceholderApiKey,
        baseUrl: settings.embedderBaseUrl,
      }),
    }),
    vectorStore: Object.freeze({
      provider: 'memory',
      config: Object.freeze({
        collectionName: mem0OssCollectionName(settings, dimension),
        dimension,
        dbPath: join(settings.storageDir, 'vectors.db'),
      }),
    }),
    historyStore: Object.freeze({
      provider: 'sqlite',
      config: Object.freeze({
        historyDbPath: join(settings.storageDir, 'history.db'),
      }),
    }),
    disableHistory: false,
  });
}

export function createDefaultMem0OssEngineLoader(
  settings: Mem0OssSettings,
): Mem0OssEngineLoader {
  return async () => {
    // The engine ships third-party analytics on by default, read from this
    // env var when its module first loads. Nobody running a character
    // consented to that, so it defaults off here — before the only import
    // — while an explicit MEM0_TELEMETRY=true still opts in.
    process.env['MEM0_TELEMETRY'] ??= 'false';

    const imported: unknown = await import('mem0ai/oss');
    const memoryConstructor = isRecord(imported)
      ? imported['Memory']
      : undefined;

    if (typeof memoryConstructor !== 'function') {
      throw new TypeError(
        'mem0ai/oss does not export the Memory engine; reinstall the mem0ai dependency.',
      );
    }

    assertRealMem0OssStorageDir(settings.storageDir);
    // The engine creates these databases itself, with the process umask;
    // they hold the same private conversation material as the runtime's
    // own stores, which are owner-only.
    makeDirectorySync(settings.storageDir, {recursive: true, mode: 0o700});

    const engine: unknown = Reflect.construct(memoryConstructor, [
      mem0OssEngineConfig(settings),
    ]);

    restrictMem0OssStorageMode(settings.storageDir);

    return pinnedMem0OssEngine(engine);
  };
}

/**
 * A symlink anywhere in the path would put the memory databases outside
 * the character store, and the permission pass would then reach whatever
 * the link points at. Checked before anything is created, because a
 * recursive mkdir follows a linked ancestor on its way down; the walk
 * stops at the first component that does not exist yet.
 */
function assertRealMem0OssStorageDir(storageDir: string): void {
  const absolute = resolve(storageDir);
  const offending = firstUnacceptableComponent({
    root: parse(absolute).root,
    path: absolute,
    accept: ['directory'],
  });

  if (offending !== undefined) {
    throw new TypeError(
      'Mem0 embedded storage must be a real directory inside the character store, with no symlinked path components.',
    );
  }
}

/** Owner-only, matching the runtime's own SQLite views and transcripts. */
function restrictMem0OssStorageMode(storageDir: string): void {
  chmodPathSync(storageDir, 0o700);

  for (const entry of listDirectoryNamesSync(storageDir)) {
    chmodPathSync(join(storageDir, entry), 0o600);
  }
}

export function createMem0OssBackend(options: {
  readonly loadEngine: Mem0OssEngineLoader;
}): Mem0Backend {
  let enginePromise: Promise<Mem0OssEngine> | undefined;
  // A failed construction (bad config, missing peer package) must retry
  // on the next call instead of caching the rejection forever. The signal
  // belongs to whichever call builds it: loading opens the store and its
  // provider clients, which a caller that gave up should not wait on.
  const engine = (signal: AbortSignal) =>
    (enginePromise ??= options.loadEngine({signal}).catch((error: unknown) => {
      enginePromise = undefined;
      throw error;
    }));

  return Object.freeze({
    async search(searchOptions) {
      const response: unknown = await settledOrAborted(
        (await engine(searchOptions.signal)).search(searchOptions.query, {
          topK: searchOptions.limit,
          filters: {
            user_id: searchOptions.userId,
            agent_id: searchOptions.agentId,
          },
        }),
        searchOptions.signal,
        'search',
      );

      return memoryHitsFromResponse(response, 'search');
    },
    async add(addOptions) {
      const response: unknown = await settledOrAborted(
        (await engine(addOptions.signal)).add([...addOptions.messages], {
          userId: addOptions.userId,
          agentId: addOptions.agentId,
          ...(addOptions.runId === undefined ? {} : {runId: addOptions.runId}),
          infer: addOptions.infer,
          ...mem0SourceMetadata(addOptions.sourceIds),
        }),
        addOptions.signal,
        'add',
      );

      return addReferencesFromResponse(response, 'add');
    },
    async ping(pingOptions) {
      // Constructing the engine only wires provider clients: neither the
      // extraction model nor the embedder is contacted until real work,
      // so claiming reachability here would be false comfort.
      await engine(pingOptions.signal);

      return {
        verified: false,
        summary:
          'Mem0 engine loaded; its model and embedder are contacted on first capture or recall.',
      };
    },
  } satisfies Mem0Backend);
}

/**
 * The engine takes no signal of its own, so a stalled model request would
 * outlive the caller that gave up on it: the drain settles when the
 * signal fires, and the abandoned work no longer holds the shutdown.
 */
async function settledOrAborted(
  work: Promise<unknown>,
  signal: AbortSignal,
  operation: string,
): Promise<unknown> {
  const aborted = new Promise<never>((_resolve, rejectAborted) => {
    const fail = () => {
      rejectAborted(
        new Mem0RequestError({operation, failureKind: 'cancelled'}),
      );
    };

    if (signal.aborted) {
      fail();
      return;
    }

    signal.addEventListener('abort', fail, {once: true});
    // The race already reports this promise's outcome; this derived one
    // exists to drop the listener, so its rejection is not a second
    // failure to report.
    void work
      .finally(() => {
        signal.removeEventListener('abort', fail);
      })
      .catch(() => undefined);
  });

  return await Promise.race([work, aborted]);
}

function pinnedMem0OssEngine(engine: unknown): Mem0OssEngine {
  if (!isRecord(engine)) {
    throw new TypeError('mem0ai/oss Memory did not construct an engine.');
  }

  const add = engine['add'];
  const search = engine['search'];

  if (typeof add !== 'function' || typeof search !== 'function') {
    throw new TypeError(
      'mem0ai/oss Memory engine does not expose add and search.',
    );
  }

  return Object.freeze({
    add(messages, addOptions) {
      const result: unknown = Reflect.apply(add, engine, [
        messages,
        addOptions,
      ]);

      return Promise.resolve(result);
    },
    search(query, searchOptions) {
      const result: unknown = Reflect.apply(search, engine, [
        query,
        searchOptions,
      ]);

      return Promise.resolve(result);
    },
  } satisfies Mem0OssEngine);
}

function providerConfig(options: {
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(options.model === undefined ? {} : {model: options.model}),
    ...(options.apiKey === undefined ? {} : {apiKey: options.apiKey}),
    ...(options.baseUrl === undefined ? {} : {baseURL: options.baseUrl}),
  });
}
