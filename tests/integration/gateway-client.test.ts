import {getEventListeners} from 'node:events';

import {Hono} from 'hono';
import {stream, streamSSE} from 'hono/streaming';
import {describe, expect, it, vi} from 'vitest';

import {
  createGatewayClient,
  GatewayClientError,
} from '../../src/gateway/client/index.ts';
import {createGateway, type GatewayEvent} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {createGatewayTestHome} from '../support/gateway-fixtures.ts';
import {
  listen,
  startTestGatewayServer,
  testGatewayToken as token,
} from '../support/gateway-http.ts';

function replyAdapter(text = 'a reply'): RoleModelAdapter {
  return {
    invoke: () => ({
      rawOutputText: JSON.stringify({
        toolCalls: [{name: 'visible_reply', input: {text}}],
      }),
    }),
  };
}

async function startServer() {
  const gateway = createGateway({
    location: {storeRoot: await createGatewayTestHome()},
    roleModelAdapter: replyAdapter(),
    createPluginHost: () => createRuntimePluginHost({plugins: []}),
  });
  const server = await startTestGatewayServer({gateway});

  return {
    gateway,
    server,
    client: createGatewayClient({url: `${server.baseUrl}/#token=${token}`}),
    close: async () => {
      await server.close();
      await gateway.stop();
    },
  };
}

describe('gateway reference client', () => {
  it('drives a conversation end to end from the printed URL', async () => {
    const {client, close} = await startServer();

    await expect(client.health()).resolves.toMatchObject({protocolVersion: 4});
    await expect(client.startCharacter('mira')).resolves.toMatchObject({
      status: 'settled',
      character: {id: 'mira', state: 'ready'},
    });

    const opened = await client.openDirectConversation('mira');

    if (opened.status !== 'opened') {
      expect.fail(opened.message);
    }

    await expect(
      client.deliver({
        conversationId: opened.conversationId,
        senderId: opened.userParticipantId,
        text: 'hello',
        source: 'web',
        clientMessageId: 'msg-1',
      }),
    ).resolves.toMatchObject({status: 'completed'});

    const history = await client.history(opened.conversationId, {limit: 1});

    expect(history).toMatchObject({
      status: 'ok',
      messages: [{role: 'character', text: 'a reply'}],
    });
    expect(history.status === 'ok' && history.earlier).toBeTypeOf('string');
    await expect(client.pendingConfirmations()).resolves.toEqual([]);
    await expect(client.answerConfirmation('nope', 'denied')).resolves.toEqual({
      status: 'unknown',
    });

    const view = await client.configView({scope: 'global'});

    if (view.status !== 'ok') {
      expect.fail(view.message);
    }

    await expect(
      client.applyConfigChange({
        target: {scope: 'global'},
        expectedFingerprint: view.fingerprint,
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Web',
        },
      }),
    ).resolves.toMatchObject({status: 'applied'});
    await close();
  });

  it('reports a transport refusal as the envelope, and refuses a URL without a token', async () => {
    const {server, close} = await startServer();
    const wrong = createGatewayClient({baseUrl: server.baseUrl, token: 'nope'});

    await expect(wrong.health()).rejects.toMatchObject({
      name: 'GatewayClientError',
      status: 401,
      code: 'unauthorized',
    });
    await expect(
      wrong.events(() => undefined, {signal: new AbortController().signal}),
    ).rejects.toBeInstanceOf(GatewayClientError);
    expect(() => createGatewayClient({url: server.baseUrl})).toThrow(/#token/u);
    expect(() =>
      createGatewayClient({baseUrl: 'https://127.0.0.1:4310', token}),
    ).toThrow(/http:\/\//u);
    // A URL in an error never carries its token.
    expect(() =>
      createGatewayClient({url: `http://example.com:4310/#token=${token}`}),
    ).toThrow(/this machine.*example\.com:4310\/$/u);
    expect(() =>
      createGatewayClient({url: `http://example.com:4310/#token=${token}`}),
    ).not.toThrow(new RegExp(token, 'u'));
    // The URL parser drops a newline; the message must not keep what
    // followed it either.
    expect(() =>
      createGatewayClient({
        url: `http://example.com:4310/#token=${token}\nmore`,
      }),
    ).not.toThrow(new RegExp(token, 'u'));
    expect(() =>
      createGatewayClient({baseUrl: server.baseUrl, token: 'bad\ntoken'}),
    ).toThrow(/not a usable header value/u);
    await expect(
      createGatewayClient({baseUrl: 'http://127.0.0.1:1', token}).health(),
    ).rejects.toMatchObject({status: 0, code: 'unreachable'});
    await close();
  });

  it('waits for an async bootstrap before handing on events, and fails with it', async () => {
    const {gateway, client, close} = await startServer();
    const order: string[] = [];
    const abort = new AbortController();
    const following = client.events(event => order.push(event.kind), {
      signal: abort.signal,
      onReady: async () => {
        // Something happens on the daemon while the snapshots are read.
        await gateway.startCharacter('mira');
        await new Promise(resolve => setTimeout(resolve, 50));
        order.push('bootstrap');
      },
    });

    await vi.waitFor(() => {
      expect(order).toContain('state_changed');
    });
    expect(order[0]).toBe('bootstrap');
    abort.abort();
    await following;

    await expect(
      client.events(() => undefined, {
        signal: new AbortController().signal,
        onReady: () => Promise.reject(new Error('snapshot failed')),
      }),
    ).rejects.toThrow('snapshot failed');
    // A bootstrap's own request can fail with the transport's shape; that
    // is the bootstrap's failure, and no reconnect hides it.
    await expect(
      client.events(() => undefined, {
        signal: new AbortController().signal,
        onReady: () =>
          Promise.reject(
            new GatewayClientError(0, 'unreachable', 'a verb of the bootstrap'),
          ),
      }),
    ).rejects.toMatchObject({
      code: 'unreachable',
      message: 'a verb of the bootstrap',
    });
    await close();
  });

  it('says when the daemon severs the stream, and comes back when it returns on its port', async () => {
    const {gateway, server, client, close} = await startServer();
    const stream: string[] = [];
    const abort = new AbortController();
    const following = client.events(() => undefined, {
      signal: abort.signal,
      retryMs: 20,
      onReady: ({reconnected}) => {
        stream.push(reconnected ? 'back' : 'ready');
      },
      onLost: () => {
        stream.push('lost');
      },
    });

    await vi.waitFor(() => {
      expect(stream).toEqual(['ready']);
    });
    // Severed, not ended: the socket is torn down under the stream.
    await server.close();

    const returned = await startTestGatewayServer({gateway, port: server.port});

    await vi.waitFor(() => {
      expect(stream).toEqual(['ready', 'lost', 'back']);
    });
    abort.abort();
    await following;
    await returned.close();
    await close();
  });

  it('lets an abort interrupt a bootstrap that never finishes', async () => {
    const {client, close} = await startServer();
    const abort = new AbortController();
    let bootstrapping = false;
    const following = client.events(() => undefined, {
      signal: abort.signal,
      onReady: () => {
        bootstrapping = true;

        return new Promise<void>(() => undefined);
      },
    });

    await vi.waitFor(() => {
      expect(bootstrapping).toBe(true);
    });
    abort.abort();
    await expect(following).resolves.toBeUndefined();
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    await close();
  });

  it('lets go of each finished stream, so reconnects never pile up abort listeners', async () => {
    const {gateway, server: first, client} = await startServer();
    const readies: boolean[] = [];
    const abort = new AbortController();
    const following = client.events(() => undefined, {
      signal: abort.signal,
      retryMs: 10,
      onReady: ({reconnected}) => {
        readies.push(reconnected);
      },
    });
    let server = first;

    // The daemon goes away and comes back on its port, four times over.
    for (let round = 1; round <= 4; round += 1) {
      await vi.waitFor(() => {
        expect(readies).toHaveLength(round);
      });
      await server.close();
      server = await startTestGatewayServer({gateway, port: server.port});
    }

    await vi.waitFor(() => {
      expect(readies).toHaveLength(5);
    });
    expect(getEventListeners(abort.signal, 'abort').length).toBeLessThanOrEqual(
      1,
    );
    abort.abort();
    await following;
    await server.close();
    await gateway.stop();
  });

  it('follows the stream across a reconnect and bootstraps on every ready', async () => {
    const {gateway, server, client} = await startServer();
    const readies: boolean[] = [];
    const events: GatewayEvent[] = [];
    const abort = new AbortController();
    const following = client.events(event => events.push(event), {
      signal: abort.signal,
      retryMs: 20,
      onReady: ({reconnected}) => {
        readies.push(reconnected);
      },
    });

    await vi.waitFor(() => {
      expect(readies).toEqual([false]);
    });

    // The daemon ends every stream and returns; the client comes back on
    // its own.
    await server.close();

    const returned = await startTestGatewayServer({gateway, port: server.port});

    await vi.waitFor(() => {
      expect(readies).toEqual([false, true]);
    });

    await gateway.startCharacter('mira');
    await vi.waitFor(() => {
      expect(events.map(event => event.kind)).toContain('state_changed');
    });

    abort.abort();
    await expect(following).resolves.toBeUndefined();
    await returned.close();
    await gateway.stop();
  });
});

describe('gateway reference client error boundary', () => {
  it('reports a body that is not JSON as a client error, not a raw throw', async () => {
    const app = new Hono().get('/api/health', c => c.text('not json'));
    const server = await listen(app);
    const client = createGatewayClient({baseUrl: server.baseUrl, token});

    await expect(client.health()).rejects.toMatchObject({
      name: 'GatewayClientError',
      status: 200,
      code: 'malformed_response',
    });
    await server.close();
  });

  it('cancels a snapshot request on abort instead of holding its socket', async () => {
    let requests = 0;
    const app = new Hono().get('/api/health', () => {
      requests += 1;

      return new Promise<Response>(() => undefined);
    });
    const server = await listen(app);
    const client = createGatewayClient({baseUrl: server.baseUrl, token});
    const abort = new AbortController();
    const health = client.health({signal: abort.signal});

    await vi.waitFor(() => {
      expect(requests).toBe(1);
    });
    abort.abort();
    await expect(health).rejects.toMatchObject({
      name: 'GatewayClientError',
      status: 0,
      code: 'aborted',
    });
    await server.close();
  });

  it("reports an abort as the caller's own, even once the headers had arrived", async () => {
    let answering = false;
    const app = new Hono().get('/api/health', c =>
      stream(c, async body => {
        answering = true;
        await body.write('{');
        await new Promise<void>(() => undefined);
      }),
    );
    const server = await listen(app);
    const client = createGatewayClient({baseUrl: server.baseUrl, token});
    const abort = new AbortController();
    const health = client.health({signal: abort.signal});

    await vi.waitFor(() => {
      expect(answering).toBe(true);
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    abort.abort();
    await expect(health).rejects.toMatchObject({
      name: 'GatewayClientError',
      status: 0,
      code: 'aborted',
    });
    await server.close();
  });

  it('never opens the stream for a signal that was already aborted', async () => {
    let requests = 0;
    const app = new Hono().get('/api/events', c => {
      requests += 1;

      return c.text('unexpected');
    });
    const server = await listen(app);
    const client = createGatewayClient({baseUrl: server.baseUrl, token});
    const abort = new AbortController();

    abort.abort();
    await expect(
      client.events(() => undefined, {signal: abort.signal}),
    ).resolves.toBeUndefined();
    expect(requests).toBe(0);
    await server.close();
  });

  it('closes the socket when the stream is unusable, for a wrong protocol or a bad frame', async () => {
    for (const [frame, code] of [
      // The version before this one: a daemon that has not been restarted.
      ['event: ready\ndata: {"protocolVersion":1}\n\n', 'protocol_mismatch'],
      ['event: ready\ndata: not json\n\n', 'malformed_event'],
    ] as const) {
      let aborted = 0;
      const app = new Hono().get('/api/events', c =>
        streamSSE(c, async stream => {
          const connection = {open: true};

          stream.onAbort(() => {
            connection.open = false;
            aborted += 1;
          });
          await stream.write(frame);

          while (connection.open) {
            await stream.sleep(20);
          }
        }),
      );
      const server = await listen(app);
      const client = createGatewayClient({baseUrl: server.baseUrl, token});

      await expect(
        client.events(() => undefined, {signal: new AbortController().signal}),
      ).rejects.toMatchObject({name: 'GatewayClientError', code});
      await vi.waitFor(() => {
        expect(aborted).toBe(1);
      });
      await server.close();
    }
  });
});
