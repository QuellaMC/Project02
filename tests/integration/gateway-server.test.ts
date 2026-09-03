import {connect, createServer} from 'node:net';

import {describe, expect, it, vi} from 'vitest';

import {createGatewayServer} from '../../src/gateway/http/server.ts';
import {createGateway} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {
  createGatewayTestHome,
  openDirect,
} from '../support/gateway-fixtures.ts';
import {
  subscribeToEvents,
  testGatewayToken as token,
} from '../support/gateway-http.ts';

const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

/** An adapter whose one reply waits until the test releases it. */
function heldAdapter(): {
  readonly adapter: RoleModelAdapter;
  readonly invoked: () => number;
  release(): void;
} {
  let invocations = 0;
  let release = (): void => undefined;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });

  return {
    adapter: {
      async invoke() {
        invocations += 1;
        await held;

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [{name: 'visible_reply', input: {text: 'late reply'}}],
          }),
        };
      },
    },
    invoked: () => invocations,
    release: () => {
      release();
    },
  };
}

function gatewayOver(homeRoot: string, adapter: RoleModelAdapter) {
  return createGateway({
    location: {storeRoot: homeRoot},
    env: {},
    roleModelAdapter: adapter,
    createPluginHost: () => createRuntimePluginHost({plugins: []}),
  });
}

describe('gateway server lifecycle', () => {
  it('falls back to a free port when the asked-for one is busy', async () => {
    const blocker = createServer();

    await new Promise<void>(resolve => {
      blocker.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });

    const blocked = blocker.address();

    if (blocked === null || typeof blocked === 'string') {
      throw new Error('no blocker address');
    }

    const gateway = gatewayOver(
      await createGatewayTestHome(),
      heldAdapter().adapter,
    );
    const server = await createGatewayServer({
      gateway,
      token,
      port: blocked.port,
    });

    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(blocked.port);

    const health = await fetch(
      `http://127.0.0.1:${String(server.port)}/api/health`,
      {
        headers,
      },
    );

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({protocolVersion: 1});

    await server.close();
    await new Promise<void>(resolve => {
      blocker.close(() => {
        resolve();
      });
    });
  });

  it('does not wait on a client that stalled mid-body when it shuts down', async () => {
    const gateway = gatewayOver(
      await createGatewayTestHome(),
      heldAdapter().adapter,
    );
    const server = await createGatewayServer({gateway, token, port: 0});
    const stalled = connect(server.port, '127.0.0.1');

    await new Promise<void>(resolve => {
      stalled.once('connect', () => {
        resolve();
      });
    });
    // Headers promise a body that never fully comes.
    stalled.write(
      `POST /api/turns HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"conv`,
    );
    await new Promise(resolve => setTimeout(resolve, 100));

    const started = Date.now();

    await server.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    stalled.destroy();
  });

  it('drains an accepted turn behind a 503 for newcomers, ending the streams first', async () => {
    const homeRoot = await createGatewayTestHome();
    const held = heldAdapter();
    const gateway = gatewayOver(homeRoot, held.adapter);

    await gateway.startCharacter('mira');

    const ref = await openDirect(gateway, 'mira');
    const server = await createGatewayServer({gateway, token, port: 0});
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const events = await subscribeToEvents(baseUrl);

    await events.next(frame => frame.event === 'ready');

    const turn = fetch(`${baseUrl}/api/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'last words',
        source: 'web',
        clientMessageId: 'msg-last',
      }),
    });

    await vi.waitFor(() => {
      expect(held.invoked()).toBe(1);
    });

    const closing = server.close();

    // The stream ends at once; the socket stays up while the turn drains.
    await events.ended;

    const late = await fetch(`${baseUrl}/api/health`, {headers});

    expect(late.status).toBe(503);
    await expect(late.json()).resolves.toEqual({
      error: {code: 'unavailable', message: 'The daemon is stopping.'},
    });

    held.release();
    await expect((await turn).json()).resolves.toMatchObject({
      status: 'completed',
    });
    await closing;
    await expect(fetch(`${baseUrl}/api/health`, {headers})).rejects.toThrow();

    // The leases went with it: a fresh gateway takes the conversation over.
    const fresh = gatewayOver(homeRoot, heldAdapter().adapter);

    await fresh.startCharacter('mira');
    await expect(fresh.openDirectConversation('mira')).resolves.toMatchObject({
      status: 'opened',
      conversationId: ref.conversationId,
    });
    await fresh.stop();
  });
});
