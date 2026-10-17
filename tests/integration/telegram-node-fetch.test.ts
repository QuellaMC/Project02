import {Hono} from 'hono';
import {describe, expect, it, vi} from 'vitest';

import {gatewayProtocolVersion} from '../../src/gateway/api/index.ts';
import {createGatewayClient} from '../../src/gateway/client/index.ts';
import {createGateway} from '../../src/gateway/index.ts';
import {createNodeFetch} from '../../src/frontends/telegram/node-fetch.ts';
import {createGatewayTestHome} from '../support/gateway-fixtures.ts';
import {
  listen,
  startTestGatewayServer,
  testGatewayToken as token,
} from '../support/gateway-http.ts';

describe('the connector fetch over node:http', () => {
  it('sends a request whole and hands the answer back whole', async () => {
    let received: unknown;
    const app = new Hono().post('/echo', async c => {
      received = {
        method: c.req.method,
        type: c.req.header('content-type'),
        asked: c.req.header('x-asked'),
        body: await c.req.json<unknown>(),
      };

      return c.json({echoed: true}, 201, {'x-answered': 'yes'});
    });
    const server = await listen(app);
    const response = await createNodeFetch()(`${server.baseUrl}/echo`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-asked': 'please'},
      body: JSON.stringify({hello: 'world'}),
    });

    expect(received).toEqual({
      method: 'POST',
      type: 'application/json',
      asked: 'please',
      body: {hello: 'world'},
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-answered')).toBe('yes');
    await expect(response.json()).resolves.toEqual({echoed: true});
    await server.close();
  });

  it('waits for an answer the server holds', async () => {
    const app = new Hono().get('/held', async c => {
      await new Promise(resolve => setTimeout(resolve, 300));

      return c.text('worth the wait');
    });
    const server = await listen(app);
    const response = await createNodeFetch()(`${server.baseUrl}/held`);

    await expect(response.text()).resolves.toBe('worth the wait');
    await server.close();
  });

  it("carries the gateway client's verbs, and its event stream as each frame arrives", async () => {
    const gateway = createGateway({
      location: {storeRoot: await createGatewayTestHome()},
    });
    const server = await startTestGatewayServer({gateway});
    const client = createGatewayClient({
      baseUrl: server.baseUrl,
      token,
      fetch: createNodeFetch(),
    });
    const kinds: string[] = [];
    const abort = new AbortController();
    let listening = false;

    await expect(client.health()).resolves.toMatchObject({
      protocolVersion: gatewayProtocolVersion,
    });

    const following = client.events(event => kinds.push(event.kind), {
      signal: abort.signal,
      onReady: () => {
        listening = true;
      },
    });

    await vi.waitFor(() => {
      expect(listening).toBe(true);
    });
    await expect(
      client.requestPairing('telegram', {
        id: '123456789',
        label: 'Alice (@alice)',
      }),
    ).resolves.toMatchObject({status: 'pending'});
    await vi.waitFor(() => {
      expect(kinds).toEqual(['pairing_requested']);
    });
    abort.abort();
    await following;
    await server.close();
    await gateway.stop();
  });

  it('lets an abort end an exchange the server holds, and sends nothing for a signal that already fired', async () => {
    let requests = 0;
    let clientGone = false;
    const app = new Hono().get('/api/health', c => {
      requests += 1;
      c.req.raw.signal.addEventListener('abort', () => {
        clientGone = true;
      });

      return new Promise<Response>(() => undefined);
    });
    const server = await listen(app);
    const client = createGatewayClient({
      baseUrl: server.baseUrl,
      token,
      fetch: createNodeFetch(),
    });
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
    await vi.waitFor(() => {
      expect(clientGone).toBe(true);
    });

    const fired = new AbortController();

    fired.abort();
    await expect(
      createNodeFetch()(`${server.baseUrl}/api/health`, {signal: fired.signal}),
    ).rejects.toMatchObject({name: 'AbortError'});
    expect(requests).toBe(1);
    await server.close();
  });
});
