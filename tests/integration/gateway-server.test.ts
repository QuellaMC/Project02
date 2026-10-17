import {connect, createServer} from 'node:net';

import {describe, expect, it, vi} from 'vitest';

import {createGatewayServer} from '../../src/gateway/http/server.ts';
import {createGateway, type HistoryOutcome} from '../../src/gateway/index.ts';
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
    await expect(health.json()).resolves.toMatchObject({protocolVersion: 7});

    await server.close();
    await new Promise<void>(resolve => {
      blocker.close(() => {
        resolve();
      });
    });
  });

  it('lets go of the gateway when the socket cannot be bound', async () => {
    const gateway = gatewayOver(
      await createGatewayTestHome(),
      heldAdapter().adapter,
    );
    let subscriptions = 0;
    const counted = {
      ...gateway,
      events: (listener: Parameters<typeof gateway.events>[0]) => {
        subscriptions += 1;

        const unsubscribe = gateway.events(listener);

        return () => {
          subscriptions -= 1;
          unsubscribe();
        };
      },
    };

    await expect(
      createGatewayServer({gateway: counted, token, port: 65_536}),
    ).rejects.toThrow();
    expect(subscriptions).toBe(0);
    await gateway.stop();
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

  it('cuts a client that stopped taking a large answer once the grace is up', async () => {
    const gateway = gatewayOver(
      await createGatewayTestHome(),
      heldAdapter().adapter,
    );
    // A history page far larger than the socket buffers hold, so an unread
    // answer stalls.
    const page: HistoryOutcome = {
      status: 'ok',
      conversationId: 'conv',
      characterId: 'mira',
      messages: Array.from({length: 16}, (_, index) => ({
        messageId: `conv.1:message-${String(index + 1)}`,
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'x'.repeat(1024 * 1024),
        committedAt: '2026-09-02T00:00:00.000Z',
      })),
    };
    const server = await createGatewayServer({
      gateway: {...gateway, history: () => Promise.resolve(page)},
      token,
      port: 0,
    });
    const stalled = connect(server.port, '127.0.0.1');

    // A complete request, and then not one byte of the answer is read.
    stalled.pause();
    await new Promise<void>(resolve => {
      stalled.once('connect', () => {
        resolve();
      });
    });
    stalled.write(
      `GET /api/conversations/conv/messages HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    await new Promise(resolve => setTimeout(resolve, 200));

    // Measured on the monotonic clock: the wall clock is adjusted under
    // WSL2 and has read a two-second wait as less.
    const started = performance.now();

    await server.close();

    const waited = performance.now() - started;

    // The answer was given its grace, and then the socket was cut.
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(5_000);
    stalled.destroy();
  }, 10_000);

  it('drains an accepted turn behind a 503 for newcomers, with the stream still carrying its reply', async () => {
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

    // Newcomers are refused at once; the socket and the stream stay up
    // while the turn drains.
    const late = await fetch(`${baseUrl}/api/health`, {headers});

    expect(late.status).toBe(503);
    await expect(late.json()).resolves.toEqual({
      error: {code: 'unavailable', message: 'The daemon is stopping.'},
    });

    held.release();
    await expect((await turn).json()).resolves.toMatchObject({
      status: 'completed',
    });
    // The reply rode the stream, which ends only after the turn is done.
    await events.next(frame => frame.event === 'turn_completed');
    await events.ended;
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
