import {afterEach, describe, expect, it, vi} from 'vitest';

import {createGatewayClient} from './client.ts';

describe('gateway client paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a path parameter as one segment, whatever it holds', async () => {
    const requested: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        requested.push(input);

        return Promise.resolve(
          new Response(JSON.stringify({messages: [], hasMore: false}), {
            status: 200,
            headers: {'content-type': 'application/json'},
          }),
        );
      }),
    );

    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:7777',
      token: 'token-1',
    });

    await client.history('conv a/b?c#d', {limit: 2});

    expect(requested).toEqual([
      'http://127.0.0.1:7777/api/conversations/conv%20a%2Fb%3Fc%23d/messages?limit=2',
    ]);
  });
});
