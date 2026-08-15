import {describe, expect, it} from 'vitest';

import {createNvidiaRoleModelProviderAdapter} from '../../src/role-model/providers/nvidia.ts';
import type {NvidiaFetchClient} from '../../src/role-model/providers/nvidia-transport.ts';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('NVIDIA plain text completion', () => {
  it('asks the same model without tools or thinking and returns the scrubbed text', async () => {
    let captured: {url: string; body: unknown} | undefined;
    const fetchClient: NvidiaFetchClient = (url, request) => {
      captured = {url, body: JSON.parse(request.body)};

      return jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                '<think>planning</think>  Mike wants a hike; I suggested Ridge Loop.  ',
            },
          },
        ],
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      model: 'nvidia/test-model',
      endpoint: 'https://example.test/v1/chat/completions',
      fetchClient,
    });

    const result = await adapter.completeText?.({
      instructions: 'Condense.',
      input: '<conversation>...</conversation>',
      maxOutputChars: 6000,
    });

    expect(result).toEqual({
      status: 'completed',
      text: 'Mike wants a hike; I suggested Ridge Loop.',
      provider: {name: 'nvidia', model: 'nvidia/test-model'},
    });
    expect(captured?.url).toBe('https://example.test/v1/chat/completions');
    expect(captured?.body).toMatchObject({
      model: 'nvidia/test-model',
      messages: [
        {role: 'system', content: 'Condense.'},
        {role: 'user', content: '<conversation>...</conversation>'},
      ],
      stream: false,
      max_tokens: 3000,
      chat_template_kwargs: {enable_thinking: false},
    });
    expect(captured?.body).not.toHaveProperty('tools');
  });

  it('reports every failure instead of throwing, with the key redacted', async () => {
    const request = {
      instructions: 'Condense.',
      input: 'x',
      maxOutputChars: 100,
    };
    const withFetch = (fetchClient: NvidiaFetchClient) =>
      createNvidiaRoleModelProviderAdapter({
        apiKey: 'sk-secret',
        fetchClient,
      }).completeText?.(request);

    expect(
      await createNvidiaRoleModelProviderAdapter({
        fetchClient: () => jsonResponse({}),
      }).completeText?.(request),
    ).toEqual({status: 'failed', reason: 'NVIDIA provider has no API key.'});
    expect(
      await withFetch(() => jsonResponse({error: 'nope'}, 503)),
    ).toMatchObject({
      status: 'failed',
    });
    expect(
      await withFetch(() =>
        jsonResponse({
          choices: [{message: {role: 'assistant', content: '   '}}],
        }),
      ),
    ).toEqual({
      status: 'failed',
      reason: 'NVIDIA completion returned no text.',
    });
    expect(
      await withFetch(() => Promise.reject(new Error('boom sk-secret'))),
    ).toEqual({status: 'failed', reason: 'boom [redacted]'});
  });
});
