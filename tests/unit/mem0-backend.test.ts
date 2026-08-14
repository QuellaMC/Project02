import {describe, expect, it} from 'vitest';

import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {createTestTempRoot} from '../support/temp-root.ts';

import {
  createDefaultMem0OssEngineLoader,
  createMem0OssBackend,
  createMem0PlatformBackend,
  createMem0ServerBackend,
  mem0OssEmbedderDimsForModel,
  mem0OssDefaultEmbedderModel,
  mem0OssOpenAiEndpoint,
  mem0OssEngineConfig,
  Mem0RequestError,
  type Mem0FetchFunction,
  type Mem0OssEngine,
} from '../../src/plugins/packages/mem0/backend.ts';

type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly redirect: string;
};

function recordingFetch(response: unknown, status = 200) {
  const requests: RecordedRequest[] = [];
  const fetchFn: Mem0FetchFunction = (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      redirect: init.redirect,
      ...(init.body === undefined ? {} : {body: JSON.parse(init.body)}),
    });

    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(response),
    });
  };

  return {requests, fetchFn};
}

const abortSignal = new AbortController().signal;

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('mem0 backend transports', () => {
  it('refuses a redirect and reports it as its own HTTP status', async () => {
    const {requests, fetchFn} = recordingFetch({results: []});

    await createMem0ServerBackend({
      baseUrl: 'http://127.0.0.1:8765',
      apiKey: 'm0sk_user_key',
      fetchFn,
    }).search({
      query: 'tea',
      userId: 'user-1',
      agentId: 'mira',
      limit: 5,
      signal: abortSignal,
    });

    // An X-API-Key header survives a redirect where Authorization would
    // not, and a 307 resends the body: following one would hand another
    // origin the credential and the conversation together.
    expect(requests[0]?.redirect).toBe('manual');

    // The endpoint answered, so the operator hears the 301 -- pointing at
    // the URL to fix -- rather than a fake outage.
    const redirecting = recordingFetch(undefined, 301);

    await expect(
      createMem0ServerBackend({
        baseUrl: 'http://127.0.0.1:8765',
        fetchFn: redirecting.fetchFn,
      }).ping({signal: abortSignal}),
    ).rejects.toMatchObject({
      failureKind: 'http',
      message: 'mem0 ping failed: HTTP 301.',
    });
  });

  it('speaks the platform v3 wire contract with Token auth', async () => {
    const {requests, fetchFn} = recordingFetch({
      results: [
        {id: 'row-1', memory: 'Prefers tea.', score: 0.83},
        {id: 42, memory: 'Numeric id row.'},
      ],
    });
    const backend = createMem0PlatformBackend({
      apiKey: 'platform-key',
      fetchFn,
    });

    const hits = await backend.search({
      query: 'tea',
      userId: 'user-1',
      agentId: 'mira',
      limit: 5,
      signal: abortSignal,
    });

    expect(requests[0]).toMatchObject({
      url: 'https://api.mem0.ai/v3/memories/search/',
      method: 'POST',
      headers: {Authorization: 'Token platform-key'},
      body: {
        query: 'tea',
        filters: {user_id: 'user-1', agent_id: 'mira'},
        top_k: 5,
      },
    });
    expect(hits).toEqual([
      {id: 'row-1', text: 'Prefers tea.', score: 0.83},
      {id: '42', text: 'Numeric id row.'},
    ]);
  });

  it('reports a row it cannot read instead of an empty result', async () => {
    const {fetchFn} = recordingFetch({
      results: [{error: 'schema mismatch'}],
    });
    const backend = createMem0PlatformBackend({apiKey: 'k', fetchFn});

    // A backend whose rows have moved must not look like a memory store
    // with nothing to match.
    await expect(
      backend.search({
        query: 'tea',
        userId: 'user-1',
        agentId: 'mira',
        limit: 5,
        signal: abortSignal,
      }),
    ).rejects.toMatchObject({failureKind: 'malformed_response'});
  });

  it('maps the platform async add acknowledgement to a queued-write reference', async () => {
    const {requests, fetchFn} = recordingFetch({
      event_id: 'evt-123',
      status: 'PENDING',
    });
    const backend = createMem0PlatformBackend({
      apiKey: 'platform-key',
      fetchFn,
    });

    const references = await backend.add({
      messages: [{role: 'user', content: 'remember this'}],
      userId: 'user-1',
      agentId: 'mira',
      runId: 'session-1',
      infer: true,
      signal: abortSignal,
    });

    expect(requests[0]).toMatchObject({
      url: 'https://api.mem0.ai/v3/memories/add/',
      method: 'POST',
      body: {
        messages: [{role: 'user', content: 'remember this'}],
        user_id: 'user-1',
        agent_id: 'mira',
        run_id: 'session-1',
        infer: true,
      },
    });
    expect(references).toEqual([
      {
        kind: 'external_contract',
        id: 'evt-123',
        title: 'Queued mem0 memory write',
      },
    ]);
  });

  it('speaks the self-hosted server contract with flat ids and stored-memory references', async () => {
    const {requests, fetchFn} = recordingFetch({
      results: [{id: 'stored-1'}, {id: 'stored-2'}],
    });
    const backend = createMem0ServerBackend({
      baseUrl: 'http://127.0.0.1:8765/',
      apiKey: 'server-jwt',
      fetchFn,
    });

    const references = await backend.add({
      messages: [{role: 'user', content: 'remember this'}],
      userId: 'user-1',
      agentId: 'mira',
      infer: false,
      signal: abortSignal,
    });

    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:8765/memories',
      method: 'POST',
      headers: {Authorization: 'Bearer server-jwt'},
      body: {
        user_id: 'user-1',
        agent_id: 'mira',
        infer: false,
      },
    });
    expect(references).toEqual([
      {kind: 'memory', id: 'stored-1', title: 'Mem0 memory'},
      {kind: 'memory', id: 'stored-2', title: 'Mem0 memory'},
    ]);
  });

  it('accepts only its own backend’s answer shape for an add', async () => {
    // A platform answer without a receipt proves no queue; a server answer
    // with a receipt (or an unreadable row) is a wrong deployment. Either
    // way the write must not be reported as saved or on its way.
    const platform = createMem0PlatformBackend({
      apiKey: 'k',
      fetchFn: recordingFetch({results: [{id: 'stored-1'}]}).fetchFn,
    });
    const serverWithReceipt = createMem0ServerBackend({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: recordingFetch({event_id: 'evt-1'}).fetchFn,
    });
    const serverWithBrokenRow = createMem0ServerBackend({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: recordingFetch({
        results: [{id: 'stored-1'}, {error: 'schema mismatch'}],
      }).fetchFn,
    });
    const add = {
      messages: [{role: 'user' as const, content: 'remember this'}],
      userId: 'user-1',
      agentId: 'mira',
      infer: false,
      signal: abortSignal,
    };

    await expect(platform.add(add)).rejects.toMatchObject({
      failureKind: 'malformed_response',
    });
    await expect(serverWithReceipt.add(add)).rejects.toMatchObject({
      failureKind: 'malformed_response',
    });
    await expect(serverWithBrokenRow.add(add)).rejects.toMatchObject({
      failureKind: 'malformed_response',
    });
  });

  it('selects X-API-Key auth for m0sk_ server keys and accepts bare-array responses', async () => {
    const {requests, fetchFn} = recordingFetch([
      {id: 'hit-1', memory: 'Server row.'},
    ]);
    const backend = createMem0ServerBackend({
      baseUrl: 'http://127.0.0.1:8765',
      apiKey: 'm0sk_user_key',
      fetchFn,
    });

    const hits = await backend.search({
      query: 'row',
      userId: 'user-1',
      agentId: 'mira',
      limit: 3,
      signal: abortSignal,
    });

    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:8765/search',
      headers: {'X-API-Key': 'm0sk_user_key'},
      body: {query: 'row', user_id: 'user-1', agent_id: 'mira', limit: 3},
    });
    expect(requests[0]?.headers['Authorization']).toBeUndefined();
    expect(hits).toEqual([{id: 'hit-1', text: 'Server row.'}]);
  });

  it('pings the platform validation endpoint and the server root', async () => {
    const platform = recordingFetch({});
    const server = recordingFetch({});

    await createMem0PlatformBackend({
      apiKey: 'platform-key',
      fetchFn: platform.fetchFn,
    }).ping({signal: abortSignal});
    await createMem0ServerBackend({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: server.fetchFn,
    }).ping({signal: abortSignal});

    expect(platform.requests[0]).toMatchObject({
      url: 'https://api.mem0.ai/v1/ping/',
      method: 'GET',
    });
    expect(server.requests[0]).toMatchObject({
      url: 'http://127.0.0.1:8765/',
      method: 'GET',
    });
  });

  it('reports a body abandoned mid-read as cancelled, not as unreadable', async () => {
    const controller = new AbortController();
    const stalledBody: Mem0FetchFunction = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => {
          // The headers arrived; the body stalls until the deadline.
          controller.abort();

          return Promise.reject(new Error('aborted'));
        },
      });

    // The request may already have committed remotely, so an abandoned
    // read must not read as a broken deployment.
    await expect(
      createMem0ServerBackend({
        baseUrl: 'http://127.0.0.1:8765',
        fetchFn: stalledBody,
      }).add({
        messages: [{role: 'user', content: 'remember this'}],
        userId: 'user-1',
        agentId: 'mira',
        infer: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({failureKind: 'cancelled'});
  });

  it('reports an unreadable success body instead of an empty result set', async () => {
    const brokenBody: Mem0FetchFunction = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      });
    const backend = createMem0ServerBackend({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: brokenBody,
    });

    // An operator must be able to tell a broken deployment from an empty
    // memory store.
    await expect(
      backend.search({
        query: 'tea',
        userId: 'user-1',
        agentId: 'mira',
        limit: 5,
        signal: abortSignal,
      }),
    ).rejects.toMatchObject({
      failureKind: 'malformed_response',
      message:
        'mem0 search failed: backend returned an unreadable response body.',
    });
    // Health only needs the status line, so it tolerates an empty body.
    await expect(backend.ping({signal: abortSignal})).resolves.toMatchObject({
      verified: true,
      summary: expect.stringContaining('Mem0 server reachable') as string,
    });
  });

  it('translates failures into bounded errors that never carry the credential', async () => {
    const httpFailure = recordingFetch({detail: 'nope'}, 401);
    const backend = createMem0PlatformBackend({
      apiKey: 'super-secret-key',
      fetchFn: httpFailure.fetchFn,
    });
    const networkBackend = createMem0PlatformBackend({
      apiKey: 'super-secret-key',
      fetchFn: () => Promise.reject(new Error('socket to super-secret-key')),
    });

    const httpError = await backend
      .ping({signal: abortSignal})
      .then(() => undefined)
      .catch((error: unknown) => error);
    const networkError = await networkBackend
      .ping({signal: abortSignal})
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(httpError).toBeInstanceOf(Mem0RequestError);
    expect(httpError).toMatchObject({
      failureKind: 'http',
      message: 'mem0 ping failed: HTTP 401.',
    });
    expect(networkError).toBeInstanceOf(Mem0RequestError);
    expect(networkError).toMatchObject({
      failureKind: 'network',
      message: 'mem0 ping failed: backend unreachable.',
    });
    expect(errorMessageOf(httpError)).not.toContain('super-secret-key');
    expect(errorMessageOf(networkError)).not.toContain('super-secret-key');
  });
});

describe('mem0 embedded engine backend', () => {
  it('builds the engine config with plugin-scoped storage and cloud defaults', () => {
    const config = mem0OssEngineConfig({
      llmApiKey: 'llm-key',
      llmBaseUrl: mem0OssOpenAiEndpoint,
      embedderApiKey: 'llm-key',
      embedderBaseUrl: mem0OssOpenAiEndpoint,
      storageDir: '/store/plugin-data/mem0/oss',
    });

    expect(config).toEqual({
      customInstructions:
        'Refer to people by the names used in the conversation; never call anyone "user" or "assistant".',
      llm: {
        provider: 'openai',
        config: {apiKey: 'llm-key', baseURL: mem0OssOpenAiEndpoint},
      },
      embedder: {
        provider: 'openai',
        config: {apiKey: 'llm-key', baseURL: mem0OssOpenAiEndpoint},
      },
      vectorStore: {
        provider: 'memory',
        config: {
          collectionName: 'memories_a370387dd58d',
          dimension: 1536,
          dbPath: '/store/plugin-data/mem0/oss/vectors.db',
        },
      },
      historyStore: {
        provider: 'sqlite',
        config: {historyDbPath: '/store/plugin-data/mem0/oss/history.db'},
      },
      disableHistory: false,
    });
  });

  it('serves keyless local endpoints with a placeholder key and model-derived dimensions', () => {
    const local = mem0OssEngineConfig({
      llmModel: 'llama3.2',
      llmBaseUrl: 'http://localhost:1234/v1',
      embedderModel: 'text-embedding-nomic-embed-text-v1.5',
      embedderBaseUrl: 'http://localhost:1234/v1',
      storageDir: '/store/plugin-data/mem0/oss',
    });
    const overridden = mem0OssEngineConfig({
      llmApiKey: 'k',
      llmBaseUrl: mem0OssOpenAiEndpoint,
      embedderApiKey: 'k',
      embedderBaseUrl: mem0OssOpenAiEndpoint,
      embedderModel: 'text-embedding-3-large',
      embedderDims: 999,
      storageDir: '/store/plugin-data/mem0/oss',
    });

    expect(local).toMatchObject({
      llm: {
        provider: 'openai',
        config: {
          model: 'llama3.2',
          baseURL: 'http://localhost:1234/v1',
          apiKey: 'no-key-required',
        },
      },
      vectorStore: {config: {dimension: 768}},
    });
    expect(overridden).toMatchObject({
      embedder: {config: {model: 'text-embedding-3-large'}},
      vectorStore: {config: {dimension: 999}},
    });
    expect(mem0OssEmbedderDimsForModel('text-embedding-3-large')).toBe(3072);
    expect(mem0OssEmbedderDimsForModel('mxbai-embed-large')).toBe(1024);
    expect(mem0OssEmbedderDimsForModel('all-minilm')).toBe(384);
    expect(mem0OssEmbedderDimsForModel(undefined)).toBe(1536);
    expect(mem0OssEmbedderDimsForModel('unknown-model')).toBe(1536);
  });

  it('translates search and add through the engine with one memoized construction', async () => {
    let constructions = 0;
    const calls: unknown[] = [];
    const engine: Mem0OssEngine = {
      add(messages, options) {
        calls.push({kind: 'add', messages, options});

        return Promise.resolve({results: [{id: 'stored-1'}]});
      },
      search(query, options) {
        calls.push({kind: 'search', query, options});

        return Promise.resolve({
          results: [{id: 'row-1', memory: 'Prefers tea.', score: 0.7}],
        });
      },
    };
    const backend = createMem0OssBackend({
      loadEngine: () => {
        constructions += 1;

        return Promise.resolve(engine);
      },
    });

    await backend.ping({signal: abortSignal});
    const hits = await backend.search({
      query: 'tea',
      userId: 'user-1',
      agentId: 'mira',
      limit: 4,
      signal: abortSignal,
    });
    const references = await backend.add({
      messages: [{role: 'user', content: 'remember this'}],
      userId: 'user-1',
      agentId: 'mira',
      runId: 'session-1',
      infer: true,
      signal: abortSignal,
    });

    expect(constructions).toBe(1);
    expect(calls).toEqual([
      {
        kind: 'search',
        query: 'tea',
        options: {topK: 4, filters: {user_id: 'user-1', agent_id: 'mira'}},
      },
      {
        kind: 'add',
        messages: [{role: 'user', content: 'remember this'}],
        options: {
          userId: 'user-1',
          agentId: 'mira',
          runId: 'session-1',
          infer: true,
        },
      },
    ]);
    expect(hits).toEqual([{id: 'row-1', text: 'Prefers tea.', score: 0.7}]);
    expect(references).toEqual([
      {kind: 'memory', id: 'stored-1', title: 'Mem0 memory'},
    ]);
  });

  it('claims readiness only after the model and the embedder have both answered', async () => {
    let extractNothing = true;
    const backend = createMem0OssBackend({
      loadEngine: () =>
        Promise.resolve({
          add() {
            return Promise.resolve({
              results: extractNothing ? [] : [{id: 'stored-1'}],
            });
          },
          search() {
            return Promise.resolve({results: []});
          },
        }),
    });
    const capture = {
      messages: [{role: 'user' as const, content: 'remember this'}],
      userId: 'user-1',
      agentId: 'mira',
      infer: true,
      signal: abortSignal,
    };

    // Construction wires clients without contacting them.
    expect(await backend.ping({signal: abortSignal})).toMatchObject({
      verified: false,
    });

    // An extraction that stored nothing never reached the embedder, so
    // health must not call the embedder proven on the strength of it.
    await backend.add(capture);
    expect(await backend.ping({signal: abortSignal})).toMatchObject({
      verified: false,
    });

    // A search proves the embedder; with the model already proven above,
    // readiness is now real work, not inference.
    await backend.search({
      query: 'tea',
      userId: 'user-1',
      agentId: 'mira',
      limit: 4,
      signal: abortSignal,
    });
    extractNothing = false;
    expect(await backend.ping({signal: abortSignal})).toMatchObject({
      verified: true,
    });
  });

  it('bounds engine failures so third-party errors never leave the adapter', async () => {
    const backend = createMem0OssBackend({
      loadEngine: () =>
        Promise.resolve({
          add() {
            return Promise.reject(
              new Error('401 from https://api.openai.com/v1 with sk-secret'),
            );
          },
          search() {
            return Promise.reject(
              new Error('response body: {"messages":["private text"]}'),
            );
          },
        }),
    });

    // SDK errors can carry endpoints, response bodies, conversation text,
    // or credential fragments; only the bounded form may reach evidence.
    const addError = await backend
      .add({
        messages: [{role: 'user', content: 'remember this'}],
        userId: 'user-1',
        agentId: 'mira',
        infer: false,
        signal: abortSignal,
      })
      .then(() => undefined)
      .catch((error: unknown) => error);
    const searchError = await backend
      .search({
        query: 'tea',
        userId: 'user-1',
        agentId: 'mira',
        limit: 4,
        signal: abortSignal,
      })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(addError).toBeInstanceOf(Mem0RequestError);
    expect(addError).toMatchObject({failureKind: 'engine'});
    expect(searchError).toBeInstanceOf(Mem0RequestError);
    expect(errorMessageOf(addError)).not.toContain('sk-secret');
    expect(errorMessageOf(searchError)).not.toContain('private text');

    // A SQLite failure names itself instead: its message carries no
    // config, and no endpoint or key change repairs a full disk or a
    // held lock -- at operation time exactly as at load time.
    const diskFull = Object.assign(
      new Error('SQLITE_FULL: database or disk is full'),
      {name: 'SqliteError'},
    );
    const storageError = await createMem0OssBackend({
      loadEngine: () =>
        Promise.resolve({
          add() {
            return Promise.reject(diskFull);
          },
          search() {
            return Promise.reject(diskFull);
          },
        }),
    })
      .add({
        messages: [{role: 'user', content: 'remember this'}],
        userId: 'user-1',
        agentId: 'mira',
        infer: false,
        signal: abortSignal,
      })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(errorMessageOf(storageError)).toContain('database or disk is full');
    expect(errorMessageOf(storageError)).not.toContain('endpoint');
  });

  it('never starts engine work under an already-aborted signal', async () => {
    let started = 0;
    const backend = createMem0OssBackend({
      loadEngine: () =>
        Promise.resolve({
          add() {
            started += 1;

            return new Promise<never>(() => {});
          },
          search() {
            started += 1;

            return new Promise<never>(() => {});
          },
        }),
    });
    const controller = new AbortController();

    controller.abort();

    // A queued job whose scope already expired must settle as cancelled
    // without touching the model or the store at all -- health included,
    // which opens the store on its way to loading the engine.
    await expect(
      backend.add({
        messages: [{role: 'user', content: 'remember this'}],
        userId: 'user-1',
        agentId: 'mira',
        infer: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({failureKind: 'cancelled'});
    await expect(
      backend.ping({signal: controller.signal}),
    ).rejects.toMatchObject({failureKind: 'cancelled'});
    expect(started).toBe(0);
  });

  it('keeps one caller\u2019s deadline off another caller\u2019s load', async () => {
    let releaseLoad: (engine: Mem0OssEngine) => void = () => undefined;
    const backend = createMem0OssBackend({
      loadEngine: () =>
        new Promise<Mem0OssEngine>(resolve => {
          releaseLoad = resolve;
        }),
    });
    const abandoned = new AbortController();
    const search = {
      query: 'tea',
      userId: 'user-1',
      agentId: 'mira',
      limit: 4,
    };

    // One engine serves every caller, so the first call's scope expiring
    // must not fail a second whose own scope is still good.
    const first = backend.search({...search, signal: abandoned.signal});
    const second = backend.search({...search, signal: abortSignal});

    abandoned.abort();
    await expect(first).rejects.toMatchObject({failureKind: 'cancelled'});

    releaseLoad({
      add: () => Promise.resolve({results: []}),
      search: () => Promise.resolve({results: [{id: 'row-1', memory: 'ok'}]}),
    });

    await expect(second).resolves.toEqual([{id: 'row-1', text: 'ok'}]);
  });

  it('keeps embedded writes in turn order past an abandoned wait', async () => {
    const started: string[] = [];
    let releaseFirst: (value: unknown) => void = () => undefined;
    const backend = createMem0OssBackend({
      loadEngine: () =>
        Promise.resolve({
          add(messages) {
            const text =
              Array.isArray(messages) && isRecord(messages[0])
                ? String(messages[0]['content'])
                : '';

            started.push(text);

            return text === 'first'
              ? new Promise(resolve => {
                  releaseFirst = resolve;
                })
              : Promise.resolve({results: [{id: `stored-${text}`}]});
          },
          search() {
            return Promise.resolve({results: []});
          },
        }),
    });
    const abandoned = new AbortController();
    const addOf = (content: string, signal: AbortSignal) =>
      backend.add({
        messages: [{role: 'user' as const, content}],
        userId: 'user-1',
        agentId: 'mira',
        infer: true,
        signal,
      });

    // The first caller stops waiting, but the engine cannot cancel the
    // write: the second must still run after it, never beside it -- an
    // older turn finishing late must not overwrite a newer one.
    const first = addOf('first', abandoned.signal);
    const second = addOf('second', abortSignal);

    abandoned.abort();
    await expect(first).rejects.toMatchObject({failureKind: 'cancelled'});
    expect(started).toEqual(['first']);

    releaseFirst({results: [{id: 'stored-first'}]});
    await expect(second).resolves.toEqual([
      {kind: 'memory', id: 'stored-second', title: 'Mem0 memory'},
    ]);
    expect(started).toEqual(['first', 'second']);
  });

  it('retiring the backend stops a load no caller could', () => {
    let loaderSignal: AbortSignal | undefined;
    const backend = createMem0OssBackend({
      loadEngine: ({signal}) => {
        loaderSignal = signal;

        return new Promise<Mem0OssEngine>(() => {});
      },
    });

    void backend.ping({signal: abortSignal});

    // No caller deadline reaches the shared load; only the end of the
    // backend itself does, so teardown stops it from building stores a
    // replacement provider is about to open.
    expect(loaderSignal?.aborted).toBe(false);
    backend.retire?.();
    expect(loaderSignal?.aborted).toBe(true);
  });

  it('retries engine construction after a failed load instead of caching the rejection', async () => {
    let attempts = 0;
    const backend = createMem0OssBackend({
      loadEngine: () => {
        attempts += 1;

        if (attempts === 1) {
          return Promise.reject(
            new TypeError('mem0ai/oss Memory did not construct an engine.'),
          );
        }

        return Promise.resolve({
          add: () => Promise.resolve({results: []}),
          search: () => Promise.resolve({results: []}),
        });
      },
    });

    await expect(backend.ping({signal: abortSignal})).rejects.toThrow(
      'did not construct',
    );
    // Health must not claim reachability the engine never established.
    // Nothing was contacted, so the check cannot report the engine
    // healthy on its own.
    await expect(backend.ping({signal: abortSignal})).resolves.toMatchObject({
      verified: false,
      summary: expect.stringContaining(
        'contacted on first capture or recall',
      ) as string,
    });
    expect(attempts).toBe(2);
  });

  it('starts a new vector collection when the embedder identity changes', () => {
    const base = {
      llmApiKey: 'k',
      llmBaseUrl: mem0OssOpenAiEndpoint,
      embedderBaseUrl: mem0OssOpenAiEndpoint,
      storageDir: '/store',
    };
    const collectionOf = (settings: Record<string, unknown>) => {
      const store = mem0OssEngineConfig({...base, ...settings})[
        'vectorStore'
      ] as {readonly config: {readonly collectionName: string}};

      return store.config.collectionName;
    };

    // Writing down a default must not move the collection: the effective
    // embedder is what names it.
    expect(collectionOf({})).toBe(
      collectionOf({
        embedderModel: mem0OssDefaultEmbedderModel,
        embedderBaseUrl: 'https://api.openai.com/v1/',
      }),
    );

    // Vectors only compare within the embedder that made them, and the
    // embedder is reloadable: mixing two spaces in one collection ranks
    // nonsense, and a width change breaks inserts outright.
    expect(collectionOf({embedderModel: 'text-embedding-3-small'})).not.toBe(
      collectionOf({embedderModel: 'text-embedding-3-large'}),
    );
    expect(collectionOf({embedderDims: 768})).not.toBe(
      collectionOf({embedderDims: 1536}),
    );
    expect(
      collectionOf({embedderBaseUrl: 'http://127.0.0.1:11434/v1'}),
    ).not.toBe(collectionOf({}));
  });

  it('stops waiting on the engine when the caller gives up', async () => {
    const controller = new AbortController();
    const backend = createMem0OssBackend({
      loadEngine: () =>
        Promise.resolve({
          add: () => new Promise(() => undefined),
          search: () => new Promise(() => undefined),
        }),
    });

    const write = backend.add({
      messages: [{role: 'user', content: 'remember this'}],
      userId: 'user-1',
      agentId: 'mira',
      infer: true,
      signal: controller.signal,
    });

    controller.abort();

    // The engine takes no signal of its own, so a stalled model request
    // would otherwise hold the shutdown that abandoned it.
    await expect(write).rejects.toMatchObject({failureKind: 'cancelled'});
  });

  it('keeps the engine databases owner-only', async () => {
    const storageDir = join(
      createTestTempRoot('mem0-oss-perms-'),
      'plugin-data',
      'mem0',
      'oss',
    );

    await createDefaultMem0OssEngineLoader({
      llmApiKey: 'k',
      llmBaseUrl: mem0OssOpenAiEndpoint,
      embedderBaseUrl: mem0OssOpenAiEndpoint,
      storageDir,
    })({signal: abortSignal});

    // The engine writes these with the process umask; they hold the same
    // private material as the runtime's own owner-only stores.
    expect(statSync(storageDir).mode & 0o777).toBe(0o700);
    for (const entry of readdirSync(storageDir)) {
      expect(statSync(join(storageDir, entry)).mode & 0o777).toBe(0o600);
    }
  });

  it('defaults the engine analytics off before the module loads', async () => {
    const previous = process.env['MEM0_TELEMETRY'];
    delete process.env['MEM0_TELEMETRY'];

    try {
      const engine = await createDefaultMem0OssEngineLoader({
        llmApiKey: 'k',
        llmBaseUrl: mem0OssOpenAiEndpoint,
        embedderBaseUrl: mem0OssOpenAiEndpoint,
        storageDir: createTestTempRoot('mem0-telemetry-'),
      })({signal: abortSignal});

      expect(process.env['MEM0_TELEMETRY']).toBe('false');
      expect(typeof engine.search).toBe('function');
    } finally {
      if (previous === undefined) {
        delete process.env['MEM0_TELEMETRY'];
      } else {
        process.env['MEM0_TELEMETRY'] = previous;
      }
    }
  });
});
