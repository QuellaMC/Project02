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
 * One seam, two wire contracts: the platform API (v3, Token auth, async
 * add acknowledgements) and the self-hosted server (unversioned paths,
 * Bearer/X-API-Key auth, synchronous extraction results).
 */
export type Mem0Backend = {
  search(options: Mem0SearchOptions): Promise<readonly Mem0MemoryHit[]>;
  add(
    options: Mem0AddOptions,
  ): Promise<readonly RuntimePluginSourceReference[]>;
  ping(options: {readonly signal: AbortSignal}): Promise<void>;
};

export type Mem0FetchFunction = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export type Mem0RequestFailureKind = 'http' | 'network' | 'malformed_response';

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

      return addReferencesFromResponse(response, 'add');
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

      return addReferencesFromResponse(response, 'add');
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
    rows.flatMap(row => {
      if (!isRecord(row)) {
        return [];
      }

      const id = stringId(row['id']);
      const text = firstString(row['memory'], row['text']);

      if (id === undefined || text === undefined) {
        return [];
      }

      const score = row['score'];

      return [
        Object.freeze({
          id,
          text,
          ...(typeof score === 'number' ? {score} : {}),
        } satisfies Mem0MemoryHit),
      ];
    }),
  );
}

function addReferencesFromResponse(
  value: unknown,
  operation: string,
): readonly RuntimePluginSourceReference[] {
  if (isRecord(value)) {
    const eventId = stringId(value['event_id']);

    // The platform add API acknowledges asynchronously with an event id;
    // stored memory ids only exist after server-side processing.
    if (eventId !== undefined) {
      return Object.freeze([
        {
          kind: 'external_contract',
          id: eventId,
          title: 'Queued mem0 memory write',
        },
      ]);
    }
  }

  return Object.freeze(
    requiredResultRows(value, operation).flatMap(row => {
      const id = isRecord(row) ? stringId(row['id']) : undefined;

      return id === undefined
        ? []
        : [{kind: 'memory' as const, id, title: 'Mem0 memory'}];
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
