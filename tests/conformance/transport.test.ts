import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {bearer, exchange, jsonFrom, type Exchange} from './harness/http.ts';
import {configJson, createHome} from './harness/home.ts';
import {reply, startModelServer} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

/** The answer's status and its body as JSON. */
async function answered(
  sent: Promise<Exchange>,
): Promise<{readonly status: number; readonly body: unknown}> {
  const answer = await sent;

  return {
    status: answer.status,
    body: JSON.parse(await answer.whole()) as unknown,
  };
}

function refused(status: number, code: string) {
  return {status, body: {error: {code}}};
}

it('transport.host-check: an /api request naming a host that is not loopback is refused 421 misdirected_host', async () => {
  const daemon = await startDaemon(createHome());

  expect(
    await answered(
      exchange(daemon, {
        path: '/api/health',
        headers: {...bearer(daemon), host: 'evil.example'},
      }),
    ),
  ).toMatchObject(refused(421, 'misdirected_host'));
});

it('transport.auth-bearer: an /api request without the token or with a wrong one is 401 unauthorized, and one whose Authorization is malformed is 400 invalid_request', async () => {
  const daemon = await startDaemon(createHome());
  const health = (headers: Readonly<Record<string, string>>) =>
    answered(exchange(daemon, {path: '/api/health', headers}));

  expect(await health({})).toMatchObject(refused(401, 'unauthorized'));
  expect(await health({authorization: 'Bearer wrong-token'})).toMatchObject(
    refused(401, 'unauthorized'),
  );
  expect(await health({authorization: 'Bearer not a token!'})).toMatchObject(
    refused(400, 'invalid_request'),
  );
});

it("transport.origin-check: a request from a foreign Origin is 403 forbidden_origin, and the daemon's own origin passes", async () => {
  const daemon = await startDaemon(createHome());
  const from = (origin: string) =>
    answered(
      exchange(daemon, {
        path: '/api/health',
        headers: {...bearer(daemon), origin},
      }),
    );

  expect(await from('http://evil.example')).toMatchObject(
    refused(403, 'forbidden_origin'),
  );
  expect(await from(daemon.origin)).toMatchObject({status: 200});
});

it('transport.no-store: every /api answer carries Cache-Control: no-store, the refusals and the event stream included', async () => {
  const daemon = await startDaemon(createHome());
  const answers = await Promise.all([
    exchange(daemon, {path: '/api/health', headers: bearer(daemon)}),
    exchange(daemon, {
      method: 'POST',
      path: '/api/conversations/open',
      headers: jsonFrom(daemon),
      body: '{',
    }),
    exchange(daemon, {path: '/api/health'}),
    exchange(daemon, {path: '/api/missing', headers: bearer(daemon)}),
    exchange(daemon, {
      path: '/api/health',
      headers: {...bearer(daemon), host: 'evil.example'},
    }),
    exchange(daemon, {
      path: '/api/health',
      headers: {...bearer(daemon), origin: 'http://evil.example'},
    }),
    exchange(daemon, {
      method: 'POST',
      path: '/api/turns',
      headers: jsonFrom(daemon),
      body: 'x'.repeat(64 * 1024 + 1),
    }),
    exchange(daemon, {path: '/api/events', headers: bearer(daemon)}),
  ]);

  expect(
    answers.map(answer => [answer.status, answer.headers['cache-control']]),
  ).toEqual([
    [200, 'no-store'],
    [400, 'no-store'],
    [401, 'no-store'],
    [404, 'no-store'],
    [421, 'no-store'],
    [403, 'no-store'],
    [413, 'no-store'],
    [200, 'no-store'],
  ]);
});

it("transport.error-envelope: every transport refusal is the envelope {error: {code, message}} and nothing more, and a verb's domain outcome never is", async () => {
  const daemon = await startDaemon(createHome());
  const refusals = await Promise.all(
    [
      {path: '/api/health'},
      {path: '/api/health', headers: {...bearer(daemon), host: 'evil.example'}},
      {
        path: '/api/health',
        headers: {...bearer(daemon), origin: 'http://evil.example'},
      },
      {path: '/api/missing', headers: bearer(daemon)},
      {
        method: 'POST',
        path: '/api/turns',
        headers: jsonFrom(daemon),
        body: '{not json',
      },
      {
        method: 'POST',
        path: '/api/turns',
        headers: jsonFrom(daemon),
        body: JSON.stringify({text: 'x'.repeat(65 * 1024)}),
      },
    ].map(async sent => (await answered(exchange(daemon, sent))).body),
  );

  for (const envelope of refusals) {
    expect(envelope).toEqual({
      error: {
        code: expect.any(String) as string,
        message: expect.any(String) as string,
      },
    });
  }

  const outcome = await wireOf(daemon).open('ghost');

  expect(outcome).toMatchObject({
    status: 'refused',
    reason: 'unknown_character',
  });
  expect(outcome).not.toHaveProperty('error');
});

it('transport.domain-outcomes-200: every verb answers its outcome under 200, the refusals among them as much as the successes', async () => {
  // Every call of the wire fails on any status but 200.
  const wire = wireOf(await startDaemon(createHome(), fixedReplies));

  expect(await wire.health()).toMatchObject({protocolVersion: 7});
  expect(await wire.start('mira')).toMatchObject({status: 'settled'});

  const opened = await wire.open('mira');

  if (opened.status !== 'opened') {
    throw new Error(`Mira has no conversation: ${JSON.stringify(opened)}.`);
  }

  expect(
    await wire.turn({
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text: 'Hello.',
      source: 'web',
      clientMessageId: 'hello',
    }),
  ).toMatchObject({status: 'completed'});
  expect(await wire.history(opened.conversationId)).toMatchObject({
    status: 'ok',
  });
  expect(await wire.history(opened.conversationId, {limit: 0})).toMatchObject({
    status: 'refused',
    reason: 'invalid_page',
  });
  expect(await wire.pending()).toEqual([]);
  expect(await wire.answer('nothing-waits', 'approved')).toEqual({
    status: 'unknown',
  });

  const view = (await wire.configView({scope: 'global'})) as {
    status: string;
    fingerprint: string;
  };

  expect(view).toMatchObject({status: 'ok'});
  expect(
    await wire.configChange({
      target: {scope: 'global'},
      expectedFingerprint: view.fingerprint,
      operation: {
        kind: 'set',
        path: 'project02.userDisplayName',
        value: 'Robin',
      },
    }),
  ).toMatchObject({status: 'applied'});
});

it('transport.invalid-request-400: a body that is not JSON, one without the JSON content type, and one of the wrong shape are 400 invalid_request', async () => {
  const daemon = await startDaemon(createHome());
  const line = {
    conversationId: 'conv',
    senderId: 'local-user',
    text: 'Hello.',
    source: 'web',
    clientMessageId: 'hello',
  };
  const malformed = [
    {path: '/api/turns', body: '{not json'},
    {
      path: '/api/conversations/open',
      body: JSON.stringify({characterId: 'mira'}),
      headers: bearer(daemon),
    },
    {path: '/api/turns', body: JSON.stringify({conversationId: 'conv'})},
    {path: '/api/turns', body: JSON.stringify({...line, source: 'web ui'})},
    {
      path: '/api/config',
      body: JSON.stringify({
        target: {scope: 'global'},
        expectedFingerprint: 'fingerprint',
        operation: {kind: 'set', path: 'project02.enabled'},
      }),
    },
  ];

  for (const sent of malformed) {
    expect(
      await answered(
        exchange(daemon, {method: 'POST', headers: jsonFrom(daemon), ...sent}),
      ),
      sent.body,
    ).toMatchObject(refused(400, 'invalid_request'));
  }

  expect(
    await answered(
      exchange(daemon, {
        path: '/api/config?scope=character',
        headers: bearer(daemon),
      }),
    ),
  ).toMatchObject(refused(400, 'invalid_request'));
});

it('transport.body-limit: a request body over 64 KiB is 413 payload_too_large, while one of 64 KiB is read', async () => {
  const daemon = await startDaemon(createHome());
  const ofBytes = (bytes: number) =>
    JSON.stringify({text: 'x'.repeat(bytes - '{"text":""}'.length)});
  const post = (body: string) =>
    exchange(daemon, {
      method: 'POST',
      path: '/api/turns',
      headers: jsonFrom(daemon),
      body,
    });

  expect(await answered(post(ofBytes(64 * 1024 + 1)))).toMatchObject(
    refused(413, 'payload_too_large'),
  );
  // Read through: the text inside is measured and refused for its own
  // length, which a body cut short could never be.
  expect(await answered(post(ofBytes(64 * 1024)))).toMatchObject({
    status: 400,
    body: {
      error: {
        code: 'invalid_request',
        message: expect.stringContaining('message.text') as string,
      },
    },
  });
});

it('transport.unknown-route-404: an unknown /api route, /api itself included, is 404 not_found in the envelope, behind the same auth', async () => {
  const daemon = await startDaemon(createHome());

  for (const path of ['/api/missing', '/api']) {
    expect(
      await answered(exchange(daemon, {path, headers: bearer(daemon)})),
      path,
    ).toMatchObject(refused(404, 'not_found'));
    expect(await answered(exchange(daemon, {path})), path).toMatchObject(
      refused(401, 'unauthorized'),
    );
  }
});

it('transport.stopping-503: once stopping, every new /api request is 503 unavailable, "The daemon is stopping.", while the accepted turn drains', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId, userParticipantId} = await conversationOf(
    wire,
    'mira',
  );
  const held = model.hold();
  const turn = say('Still there?', 'in-flight');

  await held.arrived();
  daemon.signal('SIGINT');
  await daemon.printed('Stopping; finishing what is in flight.');

  const late = await Promise.all(
    [
      {path: '/api/health', headers: bearer(daemon)},
      {path: '/api/events', headers: bearer(daemon)},
      {path: '/api/missing'},
      {
        method: 'POST',
        path: '/api/turns',
        headers: jsonFrom(daemon),
        body: JSON.stringify({
          conversationId,
          senderId: userParticipantId,
          text: 'Too late.',
          source: 'web',
          clientMessageId: 'late',
        }),
      },
    ].map(sent => exchange(daemon, sent)),
  );

  for (const answer of late) {
    expect(answer.status).toBe(503);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(await answer.whole())).toEqual({
      error: {code: 'unavailable', message: 'The daemon is stopping.'},
    });
  }

  held.release(reply('Still here.'));
  expect(await turn).toMatchObject({status: 'completed'});
  expect(await daemon.exit()).toBe(0);
});

it('transport.no-cors: the daemon sends no CORS headers, and takes the token from no cookie and no query string', async () => {
  const daemon = await startDaemon(createHome());
  const [preflight, ownPage, cookie, query] = await Promise.all([
    exchange(daemon, {
      method: 'OPTIONS',
      path: '/api/health',
      headers: {
        origin: daemon.origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    }),
    exchange(daemon, {
      path: '/api/health',
      headers: {...bearer(daemon), origin: daemon.origin},
    }),
    exchange(daemon, {
      path: '/api/health',
      headers: {cookie: `token=${daemon.token}`},
    }),
    exchange(daemon, {path: `/api/health?token=${daemon.token}`}),
  ]);

  for (const answer of [preflight, ownPage, cookie, query]) {
    expect(
      Object.keys(answer.headers).filter(name =>
        name.startsWith('access-control-'),
      ),
    ).toEqual([]);
  }

  expect(cookie.status).toBe(401);
  expect(query.status).toBe(401);
});
