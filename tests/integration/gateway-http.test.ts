import {mkdirSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {join} from 'node:path';

import {Hono} from 'hono';
import {describe, expect, it, vi} from 'vitest';

import {createGatewayApp} from '../../src/gateway/http/app.ts';
import type {ApiEnv} from '../../src/gateway/http/env.ts';
import {createEventStreams} from '../../src/gateway/http/events.ts';
import {
  createGateway,
  type GatewayEvent,
  type GatewayEventListener,
} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {
  createRoleModelAdapterFromCharacterAgent,
  type RoleModelAdapter,
} from '../../src/role-model/index.ts';
import {ensureInitializedProject02Store} from '../../src/runtime/config/index.ts';
import {
  createConfirmationHome,
  createGatewayTestHome,
  openDirect,
} from '../support/gateway-fixtures.ts';
import {
  frameData,
  listen,
  startTestGatewayServer,
  subscribeToEvents,
  testGatewayToken as token,
} from '../support/gateway-http.ts';
import {createScriptedAdapter} from '../support/scripted-adapter.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function replyAdapter(): RoleModelAdapter {
  return {
    invoke: () => ({
      rawOutputText: JSON.stringify({
        toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
      }),
    }),
  };
}

type RequestOptions = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};

async function createHttpHarness(
  options: {
    readonly stopping?: () => boolean;
    readonly uiRoot?: string;
  } = {},
) {
  const homeRoot = join(createTestTempRoot('project02-gateway-http-'), 'home');

  await ensureInitializedProject02Store({homeRoot});

  const gateway = createGateway({
    location: {storeRoot: homeRoot},
    roleModelAdapter: replyAdapter(),
    createPluginHost: () => createRuntimePluginHost({plugins: []}),
  });
  const app = createGatewayApp({
    gateway,
    token,
    events: createEventStreams(gateway),
    lifecycle: {stopping: options.stopping ?? (() => false)},
    ...(options.uiRoot === undefined ? {} : {uiRoot: options.uiRoot}),
  });
  // Every request names the loopback host and carries the token unless a
  // case overrides one of them.
  const request = (path: string, init: RequestOptions = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        host: '127.0.0.1:1',
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
      ...(init.body === undefined ? {} : {body: init.body}),
    });
  const post = (path: string, body: unknown, headers = {}) =>
    request(path, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...headers},
      body: JSON.stringify(body),
    });

  return {gateway, app, request, post, homeRoot};
}

async function errorOf(response: Response): Promise<{code: string}> {
  const body = (await response.json()) as {error: {code: string}};

  return body.error;
}

describe('gateway over HTTP', () => {
  it('lets only a loopback host with the right token in, one envelope per refusal', async () => {
    const {request} = await createHttpHarness();

    const noToken = await request('/api/health', {
      headers: {authorization: ''},
    });

    expect(noToken.status).toBe(401);
    expect(await errorOf(noToken)).toMatchObject({code: 'unauthorized'});

    const wrongToken = await request('/api/health', {
      headers: {authorization: 'Bearer definitely-not-the-token'},
    });

    expect(wrongToken.status).toBe(401);

    const malformedToken = await request('/api/health', {
      headers: {authorization: 'Bearer not a token!'},
    });

    expect(malformedToken.status).toBe(400);
    expect(await errorOf(malformedToken)).toMatchObject({
      code: 'invalid_request',
    });

    const foreignHost = await request('/api/health', {
      headers: {host: 'evil.example:80'},
    });

    expect(foreignHost.status).toBe(421);
    expect(await errorOf(foreignHost)).toMatchObject({
      code: 'misdirected_host',
    });

    const foreignOrigin = await request('/api/health', {
      headers: {origin: 'http://evil.example'},
    });

    expect(foreignOrigin.status).toBe(403);
    expect(await errorOf(foreignOrigin)).toMatchObject({
      code: 'forbidden_origin',
    });

    const ownOrigin = await request('/api/health', {
      headers: {origin: 'http://127.0.0.1:1'},
    });

    expect(ownOrigin.status).toBe(200);
    expect(ownOrigin.headers.get('cache-control')).toBe('no-store');
    expect(noToken.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses bodies it cannot read, bodies that are too large, and bodies of the wrong shape', async () => {
    const {request, post} = await createHttpHarness();

    const malformed = await request('/api/turns', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{not json',
    });

    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toMatchObject({code: 'invalid_request'});

    const huge = await post('/api/turns', {
      conversationId: 'c',
      senderId: 'u',
      text: 'x'.repeat(70 * 1024),
      source: 'web',
      clientMessageId: 'm',
    });

    expect(huge.status).toBe(413);
    expect(await errorOf(huge)).toMatchObject({code: 'payload_too_large'});

    const misshaped = await post('/api/turns', {conversationId: 'c'});

    expect(misshaped.status).toBe(400);
    expect(await errorOf(misshaped)).toMatchObject({code: 'invalid_request'});

    const badStamp = await post('/api/turns', {
      conversationId: 'c',
      senderId: 'u',
      text: 'hi',
      source: 'web ui',
      clientMessageId: 'm',
    });

    expect(badStamp.status).toBe(400);

    const noContentType = await request('/api/conversations/open', {
      method: 'POST',
      body: JSON.stringify({characterId: 'mira'}),
    });

    expect(noContentType.status).toBe(400);

    const badTarget = await request('/api/config?scope=character');

    expect(badTarget.status).toBe(400);

    const badChange = await post('/api/config', {
      target: {scope: 'global'},
      expectedFingerprint: 'fp',
      operation: {kind: 'set', path: 'project02.enabled'},
    });

    expect(badChange.status).toBe(400);
    expect(await errorOf(badChange)).toMatchObject({code: 'invalid_request'});
  });

  it('answers every verb with its outcome, verbatim, under a 200', async () => {
    const {request, post, gateway} = await createHttpHarness();

    const health = await request('/api/health');

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      protocolVersion: 5,
      characters: [expect.objectContaining({id: 'mira', state: 'not_started'})],
    });

    const unstarted = await post('/api/conversations/open', {
      characterId: 'mira',
    });

    expect(unstarted.status).toBe(200);
    await expect(unstarted.json()).resolves.toMatchObject({
      status: 'refused',
      reason: 'character_unavailable',
    });

    const started = await post('/api/characters/mira/start', {});

    await expect(started.json()).resolves.toMatchObject({
      status: 'settled',
      character: {id: 'mira', state: 'ready'},
    });

    const opened = (await (
      await post('/api/conversations/open', {characterId: 'mira'})
    ).json()) as {
      status: string;
      conversationId: string;
      userParticipantId: string;
    };

    expect(opened.status).toBe('opened');

    const turn = await post('/api/turns', {
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text: 'hello there',
      source: 'web',
      clientMessageId: 'msg-1',
    });

    expect(turn.status).toBe(200);
    await expect(turn.json()).resolves.toMatchObject({
      status: 'completed',
      messages: [
        expect.objectContaining({text: 'hello there'}),
        expect.objectContaining({text: 'noted'}),
      ],
    });

    const history = await request(
      `/api/conversations/${opened.conversationId}/messages?limit=1`,
    );

    await expect(history.json()).resolves.toMatchObject({
      status: 'ok',
      messages: [expect.objectContaining({text: 'noted'})],
    });

    const badPage = await request(
      `/api/conversations/${opened.conversationId}/messages?limit=abc`,
    );

    expect(badPage.status).toBe(200);
    await expect(badPage.json()).resolves.toMatchObject({
      status: 'refused',
      reason: 'invalid_page',
    });

    await expect((await request('/api/confirmations')).json()).resolves.toEqual(
      [],
    );
    await expect(
      (await post('/api/confirmations/nope', {decision: 'approved'})).json(),
    ).resolves.toEqual({status: 'unknown'});

    const view = (await (
      await request('/api/config?scope=character&characterId=mira')
    ).json()) as {status: string; fingerprint: string};

    expect(view.status).toBe('ok');

    const change = await post('/api/config', {
      target: {scope: 'character', characterId: 'mira'},
      expectedFingerprint: view.fingerprint,
      operation: {kind: 'set', path: 'project02.userDisplayName', value: 'Web'},
    });

    expect(change.status).toBe(200);
    await expect(change.json()).resolves.toMatchObject({status: 'applied'});
    await gateway.stop();
  });

  it('answers an unknown API route with the envelope, behind the same auth', async () => {
    const {request} = await createHttpHarness();

    const missingApi = await request('/api/missing');

    expect(missingApi.status).toBe(404);
    expect(await errorOf(missingApi)).toMatchObject({code: 'not_found'});

    const apiRoot = await request('/api');

    expect(apiRoot.status).toBe(404);
    expect(await errorOf(apiRoot)).toMatchObject({code: 'not_found'});

    const apiRootNoToken = await request('/api', {
      headers: {authorization: ''},
    });

    expect(apiRootNoToken.status).toBe(401);
  });

  it('answers a plain 404 at the root without a UI, and 503 once stopping', async () => {
    let stopping = false;
    const {request} = await createHttpHarness({stopping: () => stopping});

    const root = await request('/', {headers: {authorization: ''}});

    expect(root.status).toBe(404);
    expect(await root.text()).toContain('/api');

    stopping = true;

    const late = await request('/api/health');

    expect(late.status).toBe(503);
    expect(await errorOf(late)).toMatchObject({code: 'unavailable'});
  });

  it('serves the built page from the UI root, public and uncached, and nothing outside it', async () => {
    const uiRoot = join(createTestTempRoot('project02-gateway-ui-'), 'web');

    mkdirSync(join(uiRoot, 'assets'), {recursive: true});
    mkdirSync(join(uiRoot, 'api'), {recursive: true});
    writeFileSync(join(uiRoot, 'index.html'), '<title>Project02</title>');
    writeFileSync(join(uiRoot, 'assets', 'app.js'), 'console.log(1);');
    writeFileSync(join(uiRoot, 'api', 'health'), 'not the API');
    writeFileSync(join(uiRoot, '..', 'outside.txt'), 'private');

    const {request} = await createHttpHarness({uiRoot});
    const anonymous = {authorization: ''};
    const index = await request('/', {headers: anonymous});

    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(await index.text()).toContain('<title>Project02</title>');

    const head = await request('/', {method: 'HEAD', headers: anonymous});

    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const asset = await request('/assets/app.js', {headers: anonymous});

    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toBe('no-store');

    // A file named like an API path never answers for it.
    expect((await request('/api/health', {headers: anonymous})).status).toBe(
      401,
    );

    // A path that climbs out of the root, and one that names nothing, both
    // meet the app's own 404 — never a byte from outside the root.
    const outside = await request('/%2e%2e/outside.txt', {headers: anonymous});

    expect(outside.status).toBe(404);
    expect(await outside.text()).not.toContain('private');

    const missing = await request('/missing.js', {headers: anonymous});

    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({code: 'not_found'});
  });
  it('opens every stream with ready, then carries the turn in order — the draft ahead of the durable reply, whatever breath it comes in', async () => {
    const homeRoot = join(createTestTempRoot('project02-gateway-sse-'), 'home');

    await ensureInitializedProject02Store({homeRoot});

    // The local adapter speaks its reply in word-sized pieces, all in one
    // breath: three hundred frames queued at once, each one frame on the
    // wire, which a reading client takes in order — the stream judges a
    // client by the grace it gives a frame, never by what a burst left
    // waiting.
    const text = Array.from(
      {length: 300},
      (_, word) => `word${String(word)}`,
    ).join(' ');
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
        reply: () => ({text}),
      }),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const server = await startTestGatewayServer({
      gateway,
      streams: {heartbeatMs: 50},
    });
    const events = await subscribeToEvents(server.baseUrl);

    expect(events.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    expect(events.response.headers.get('cache-control')).toBe('no-store');

    const ready = await events.next(frame => frame.event === 'ready');

    // The daemon's state as the stream started listening, in one frame.
    expect(frameData(ready)).toMatchObject({
      protocolVersion: 5,
      health: {characters: [{id: 'mira', state: 'not_started'}]},
      confirmations: [],
      turns: [],
    });
    expect(events.frames[0]).toBe(ready);
    await events.next(frame => frame.comment === 'ping');

    // Every event after the handshake reaches the stream, in order.
    await gateway.startCharacter('mira');

    const ref = await openDirect(gateway, 'mira');

    await gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
      source: 'web',
      clientMessageId: 'msg-1',
    });
    await events.next(frame => frame.event === 'turn_completed');

    const progress = events.frames
      .filter(frame => frame.event !== undefined && frame.event !== 'ready')
      .map(
        frame =>
          frameData(frame) as {
            kind: string;
            progress?: {kind: string; text?: string};
          },
      );

    expect(progress.map(event => event.progress?.kind ?? event.kind)).toEqual([
      'state_changed',
      'state_changed',
      'user_message',
      ...Array<string>(300).fill('reply_delta'),
      'visible_reply',
      'turn_completed',
    ]);
    expect(
      progress
        .filter(event => event.progress?.kind === 'reply_delta')
        .map(event => event.progress?.text)
        .join(''),
    ).toBe(text);
    expect(server.events.openCount()).toBe(1);

    // Shutdown ends the stream, and a stream arriving after that ends at
    // once: its request passed the stopping guard before the guard was set.
    await server.events.closeAll();
    await events.ended;
    expect(server.events.openCount()).toBe(0);

    const late = await subscribeToEvents(server.baseUrl);

    await late.ended;
    expect(late.frames).toEqual([]);
    await server.close();
    await gateway.stop();
  });

  it('hands a stream opened mid-reply the reply so far, named by its line, and lets no other submission end it', async () => {
    const homeRoot = await createGatewayTestHome('project02-gateway-drafts-');
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      roleModelAdapter: createScriptedAdapter({homeRoot, characterId: 'mira'}),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const server = await startTestGatewayServer({gateway});

    await gateway.startCharacter('mira');

    const ref = await openDirect(gateway, 'mira');
    const line = `slowly ${Array.from({length: 120}, (_, word) => `w${String(word)}`).join(' ')}`;
    let deltas = 0;
    const counting = gateway.events(event => {
      if (
        event.kind === 'turn_progress' &&
        event.progress.kind === 'reply_delta'
      ) {
        deltas += 1;
      }
    });
    const turn = gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: line,
      source: 'web',
      clientMessageId: 'msg-slow',
    });

    await vi.waitFor(() => {
      expect(deltas).toBeGreaterThanOrEqual(3);
    });

    // Nobody was listening before this stream: the daemon folded the turn
    // for it all the same.
    const first = await subscribeToEvents(server.baseUrl);
    const ready = frameData(
      await first.next(frame => frame.event === 'ready'),
    ) as {
      turns: {
        characterId: string;
        conversationId: string;
        source: string;
        clientMessageId: string;
        drafts: {draftId: string; text: string}[];
      }[];
    };

    expect(ready.turns).toHaveLength(1);
    expect(ready.turns[0]).toMatchObject({
      characterId: 'mira',
      conversationId: ref.conversationId,
      source: 'web',
      clientMessageId: 'msg-slow',
    });
    expect(ready.turns[0]?.drafts).toHaveLength(1);
    expect(ready.turns[0]?.drafts[0]?.text.startsWith('noted: slowly')).toBe(
      true,
    );
    expect(
      `noted: ${line}`.startsWith(ready.turns[0]?.drafts[0]?.text ?? '?'),
    ).toBe(true);

    // A submission the runtime refuses on the spot completes at once,
    // while the reply is still being written.
    await expect(
      gateway.deliver({
        conversationId: ref.conversationId,
        senderId: 'someone-else',
        text: 'not mine',
        source: 'web',
        clientMessageId: 'msg-other',
      }),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'sender_not_supported',
    });
    await first.next(
      frame =>
        frame.event === 'turn_completed' &&
        (frameData(frame) as {clientMessageId: string}).clientMessageId ===
          'msg-other',
    );

    const second = await subscribeToEvents(server.baseUrl);
    const later = frameData(
      await second.next(frame => frame.event === 'ready'),
    ) as typeof ready;

    expect(later.turns[0]).toMatchObject({clientMessageId: 'msg-slow'});
    expect(later.turns[0]?.drafts[0]?.text.length ?? 0).toBeGreaterThanOrEqual(
      ready.turns[0]?.drafts[0]?.text.length ?? 0,
    );

    await expect(turn).resolves.toMatchObject({status: 'completed'});
    await second.next(
      frame =>
        frame.event === 'turn_completed' &&
        (frameData(frame) as {clientMessageId: string}).clientMessageId ===
          'msg-slow',
    );

    const after = await subscribeToEvents(server.baseUrl);

    expect(
      (
        frameData(await after.next(frame => frame.event === 'ready')) as {
          turns: unknown[];
        }
      ).turns,
    ).toEqual([]);
    counting();
    await first.cancel();
    await second.cancel();
    await after.cancel();
    await server.close();
    await gateway.stop();
  });

  it('lets a client that reconnects mid-confirmation find it in the list and answer it', async () => {
    const {gateway, inspectTone} = await createConfirmationHome();
    const server = await startTestGatewayServer({gateway});
    const first = await subscribeToEvents(server.baseUrl);
    const ref = await openDirect(gateway, 'mira');
    const turn = fetch(`${server.baseUrl}/api/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'please be warmer',
        source: 'web',
        clientMessageId: 'msg-confirm',
      }),
    });

    await first.next(frame => frame.event === 'confirmation_requested');
    await first.cancel();

    // The second connection missed the request; its ready frame has it,
    // stamped with the turn that raised it.
    const second = await subscribeToEvents(server.baseUrl);
    const ready = await second.next(frame => frame.event === 'ready');
    const pending = (
      frameData(ready) as {confirmations: {id: string; turn?: unknown}[]}
    ).confirmations;

    expect(pending).toHaveLength(1);
    expect(pending[0]?.turn).toEqual({
      conversationId: ref.conversationId,
      source: 'web',
      clientMessageId: 'msg-confirm',
    });

    const answered = await fetch(
      `${server.baseUrl}/api/confirmations/${pending[0]?.id ?? ''}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({decision: 'approved'}),
      },
    );

    await expect(answered.json()).resolves.toEqual({status: 'answered'});
    await expect((await turn).json()).resolves.toMatchObject({
      status: 'completed',
    });
    await second.next(
      frame =>
        frame.event === 'confirmation_settled' &&
        (frameData(frame) as {decision: string}).decision === 'approved',
    );
    expect(
      inspectTone().fields.find(field => field.name === 'tone')?.authored.value,
    ).toBe('warm');
    await second.cancel();
    await server.close();
    await gateway.stop();
  });

  it('drops a client that has stopped taking frames, within the grace', async () => {
    // Only the stream is under test: a fan-out the test drives directly.
    const listeners = new Set<GatewayEventListener>();
    const streams = createEventStreams(
      {
        events(listener) {
          listeners.add(listener);

          return () => {
            listeners.delete(listener);
          };
        },
        health: () => ({
          protocolVersion: 5,
          homeRoot: '/nowhere',
          config: {diagnostics: []},
          packages: {diagnostics: []},
          characters: [],
        }),
        pendingConfirmations: () => [],
      },
      {graceMs: 200},
    );
    const app = new Hono<ApiEnv>().get('/api/events', c => streams.handler(c));
    const server = await listen(app);
    const stalled = connect(server.port, '127.0.0.1');

    await new Promise<void>(resolve => {
      stalled.once('connect', () => {
        resolve();
      });
    });
    stalled.write(
      `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\n\r\n`,
    );
    stalled.pause();
    await vi.waitFor(() => {
      expect(streams.openCount()).toBe(1);
    });

    // Frames large enough that the socket's own buffer fills fast.
    const event = {
      kind: 'turn_progress',
      characterId: 'mira',
      conversationId: 'c',
      progress: {
        kind: 'visible_reply',
        messageId: 'm',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'x'.repeat(256 * 1024),
        draftId: '1.0',
      },
    } satisfies GatewayEvent;

    for (let index = 0; index < 64; index += 1) {
      for (const listener of listeners) {
        listener(event);
      }
    }

    await vi.waitFor(
      () => {
        expect(streams.openCount()).toBe(0);
      },
      {timeout: 10_000},
    );
    stalled.destroy();
    await server.close();
  });
});
