import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {bearer, exchange, type Exchange} from './harness/http.ts';
import {createHome} from './harness/home.ts';

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

it("transport.auth-bearer: /api answers only a request carrying the token in its Authorization header, to a loopback host, from no page or the daemon's own: one without it, with a wrong one or with it in a cookie or the query is 401, another Host 421 and a foreign Origin 403, and no answer carries a CORS header", async () => {
  const daemon = await startDaemon(createHome());
  const health = (
    headers: Readonly<Record<string, string>>,
    path = '/api/health',
  ) => answered(exchange(daemon, {path, headers}));

  expect(await health({})).toMatchObject(refused(401, 'unauthorized'));
  expect(await health({authorization: 'Bearer wrong-token'})).toMatchObject(
    refused(401, 'unauthorized'),
  );
  expect(await health({cookie: `token=${daemon.token}`})).toMatchObject(
    refused(401, 'unauthorized'),
  );
  expect(await health({}, `/api/health?token=${daemon.token}`)).toMatchObject(
    refused(401, 'unauthorized'),
  );
  expect(await health({...bearer(daemon), host: 'evil.example'})).toMatchObject(
    refused(421, 'misdirected_host'),
  );
  expect(
    await health({...bearer(daemon), origin: 'http://evil.example'}),
  ).toMatchObject(refused(403, 'forbidden_origin'));

  const [preflight, ownPage] = await Promise.all([
    exchange(daemon, {
      method: 'OPTIONS',
      path: '/api/health',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    }),
    exchange(daemon, {
      path: '/api/health',
      headers: {...bearer(daemon), origin: daemon.origin},
    }),
  ]);

  expect(ownPage.status).toBe(200);

  for (const answer of [preflight, ownPage]) {
    expect(
      Object.keys(answer.headers).filter(name =>
        name.startsWith('access-control-'),
      ),
    ).toEqual([]);
  }
});
