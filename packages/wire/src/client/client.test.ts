import {afterEach, describe, expect, it, vi} from 'vitest';

import {createGatewayClient} from './client.ts';

/** A request as the platform's fetch was handed it. */
type Sent = {
  readonly url: string;
  readonly method: string | undefined;
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
        requested.push({url: input, method: init?.method, body: init?.body});

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

  it('sends a character file as the file holds it', async () => {
    const requested = recordRequests();
    const file = '{\n  "format": "project02.character.v1"\n}\n';

    await client().previewCharacter(file);
    await client().addCharacter(file);

    expect(requested).toEqual([
      {
        url: 'http://127.0.0.1:7777/api/character-preview',
        method: 'POST',
        body: file,
      },
      {url: 'http://127.0.0.1:7777/api/characters', method: 'POST', body: file},
    ]);
  });
});
