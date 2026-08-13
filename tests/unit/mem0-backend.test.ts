import {describe, expect, it} from 'vitest';

import {
  createMem0PlatformBackend,
  createMem0ServerBackend,
  Mem0RequestError,
  type Mem0FetchFunction,
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

describe('mem0 backend transports', () => {
  it('refuses to follow a redirect away from the configured origin', async () => {
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
    expect(requests[0]?.redirect).toBe('error');
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
    await expect(backend.ping({signal: abortSignal})).resolves.toBeUndefined();
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
