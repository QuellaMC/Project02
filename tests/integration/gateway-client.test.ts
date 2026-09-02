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
    env: {},
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

    await expect(client.health()).resolves.toMatchObject({protocolVersion: 1});
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
    await expect(
      createGatewayClient({baseUrl: 'http://127.0.0.1:1', token}).health(),
    ).rejects.toMatchObject({status: 0, code: 'unreachable'});
    await close();
  });

  it('follows the stream across a reconnect and bootstraps on every ready', async () => {
    const {gateway, server, client, close} = await startServer();
    const readies: boolean[] = [];
    const events: GatewayEvent[] = [];
    const abort = new AbortController();
    const following = client.events(event => events.push(event), {
      signal: abort.signal,
      retryMs: 20,
      onReady: ({reconnected}) => readies.push(reconnected),
    });

    await vi.waitFor(() => {
      expect(readies).toEqual([false]);
    });

    // The daemon ends every stream; the client comes back on its own.
    server.events.closeAll();
    await vi.waitFor(() => {
      expect(readies).toEqual([false, true]);
    });

    await gateway.startCharacter('mira');
    await vi.waitFor(() => {
      expect(events.map(event => event.kind)).toContain('state_changed');
    });

    abort.abort();
    await expect(following).resolves.toBeUndefined();
    await close();
  });
});
