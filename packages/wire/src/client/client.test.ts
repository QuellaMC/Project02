import {afterEach, describe, expect, it, vi} from 'vitest';

import {createGatewayClient} from './client.ts';

/** A request as the platform's fetch was handed it. */
type Sent = {
  readonly url: string;
  readonly method: string | undefined;
  /** Its content type; null for one with no body. */
  readonly type: string | null;
  readonly body: unknown;
};

describe('gateway client paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Every request the client makes, answered with an empty JSON object. */
  function recordRequests(): readonly Sent[] {
    const requested: Sent[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        requested.push({
          url: input,
          method: init?.method,
          type: new Headers(init?.headers).get('content-type'),
          body: init?.body,
        });

        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: {'content-type': 'application/json'},
          }),
        );
      }),
    );

    return requested;
  }

  function client() {
    return createGatewayClient({
      baseUrl: 'http://127.0.0.1:7777',
      token: 'token-1',
    });
  }

  it('sends a path parameter as one segment, whatever it holds', async () => {
    const requested = recordRequests();

    await client().history('conv a/b?c#d', {limit: 2});
    await client().removeCharacter('nova/../mira');
    await client().phoneScreen('mira', 'clock/..', 'alarms?all');

    expect(requested.map(({url, method}) => ({url, method}))).toEqual([
      {
        url: 'http://127.0.0.1:7777/api/conversations/conv%20a%2Fb%3Fc%23d/messages?limit=2',
        method: 'GET',
      },
      {
        url: 'http://127.0.0.1:7777/api/characters/nova%2F..%2Fmira',
        method: 'DELETE',
      },
      {
        url: 'http://127.0.0.1:7777/api/characters/mira/phone/apps/clock%2F../views/alarms%3Fall',
        method: 'GET',
      },
    ]);
  });

  it('sends a character file and an app file each as the file holds it, under its own type', async () => {
    const requested = recordRequests();
    const character = '{\n  "format": "project02.character.v1"\n}\n';
    const app = 'export const manifest = {};\n';
    const sent = (path: string, type: string, body: string) => ({
      url: `http://127.0.0.1:7777${path}`,
      method: 'POST',
      type,
      body,
    });

    await client().previewCharacter(character);
    await client().addCharacter(character);
    await client().previewApp('mira', app);
    await client().addApp('mira', app);

    expect(requested).toEqual([
      sent('/api/character-preview', 'application/json', character),
      sent('/api/characters', 'application/json', character),
      sent('/api/characters/mira/phone/app-preview', 'text/javascript', app),
      sent('/api/characters/mira/phone/apps', 'text/javascript', app),
    ]);
  });
});
