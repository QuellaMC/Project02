import { describe, expect, it } from 'vitest';

import {
  createDecisionContext,
  createNvidiaRoleModelProviderAdapter,
  createNvidiaRoleModelProviderConfigFromEnv,
  createRoleModelInputEnvelope,
  createUserMessageRuntimeEvent,
  defaultNvidiaChatCompletionsEndpoint,
  defaultNvidiaRoleModelName,
  nvidiaApiKeyEnvName,
  parseRoleModelDecision,
  renderNvidiaMessages,
  roleModelDecisionContractVersion,
  roleModelProviderErrorRejectionReason,
  roleModelVisibleReplyActionName,
  type NvidiaFetchRequest,
  type NvidiaFetchResponse
} from '../src/index.ts';

describe('NVIDIA role-model provider adapter', () => {
  it('renders the provider prompt with allowed tools and no prose contract ambiguity', () => {
    const envelope = createTestEnvelope();
    const messages = renderNvidiaMessages(envelope);
    const userPayload = JSON.parse(messages[1]?.content ?? '{}') as {
      readonly allowedTools?: readonly string[];
      readonly outputContract?: {
        readonly version?: string;
        readonly text?: string;
      };
    };

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('Return only the CharacterDecision JSON object');
    expect(messages[0]?.content).toContain(
      '{"name":"visible_reply","input":{"text":"..."}}'
    );
    expect(messages[0]?.content).toContain('Do not use "tool"');
    expect(userPayload.allowedTools).toEqual([
      roleModelVisibleReplyActionName,
      'character_state.patch'
    ]);
    expect(userPayload.outputContract?.version).toBe(
      roleModelDecisionContractVersion
    );
    expect(userPayload.outputContract?.text).toContain(
      '{"name":"visible_reply","input":{"text":"one visible reply line"}}'
    );
    expect(userPayload.outputContract?.text).toContain('not "tool"');
  });

  it('returns clear provider rejection evidence when the API key is missing', async () => {
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: ''
    });
    const result = await adapter.invoke(createTestEnvelope());

    expect(result.rawOutputText).toBe('');
    expect(result.providerMetadata).toMatchObject({
      provider: 'nvidia',
      model: defaultNvidiaRoleModelName,
      request: {
        endpoint: defaultNvidiaChatCompletionsEndpoint,
        stream: false
      },
      error: {
        code: 'missing_api_key',
        message: `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`
      }
    });
    expect(result.rejection).toEqual({
      reason: roleModelProviderErrorRejectionReason,
      details: `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`
    });
  });

  it('uses a fake fetch client for non-streaming request shape and response parsing', async () => {
    const observedRequests: NvidiaFetchRequest[] = [];
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret-token',
      fetchClient: (_url, request) => {
        observedRequests.push(request);
        return Promise.resolve(createJsonResponse(200, {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: roleModelDecisionContractVersion,
                  toolCalls: [
                    {
                      name: roleModelVisibleReplyActionName,
                      input: {
                        text: 'provider reply'
                      }
                    }
                  ]
                })
              }
            }
          ]
        }));
      }
    });
    const output = await adapter.invoke(createTestEnvelope());
    const parsed = parseRoleModelDecision(output.rawOutputText);

    expect(observedRequests).toHaveLength(1);
    expect(JSON.parse(observedRequests[0]?.body ?? '{}')).toMatchObject({
      model: defaultNvidiaRoleModelName,
      stream: false
    });
    expect(observedRequests[0]?.headers['authorization']).toBe(
      'Bearer secret-token'
    );
    expect(output.providerMetadata).toMatchObject({
      provider: 'nvidia',
      response: {
        status: 200
      }
    });
    expect(JSON.stringify(output.providerMetadata)).not.toContain('secret-token');
    expect(parsed).toMatchObject({
      status: 'accepted'
    });
  });

  it('maps provider HTTP errors without logging secrets', async () => {
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret-token',
      fetchClient: () =>
        Promise.resolve(createJsonResponse(401, {
          error: {
            message: 'invalid api key secret-token'
          }
        }))
    });
    const output = await adapter.invoke(createTestEnvelope());

    expect(output.rejection).toEqual({
      reason: roleModelProviderErrorRejectionReason,
      details: 'NVIDIA provider error: invalid api key [redacted]'
    });
    expect(output.providerMetadata).toMatchObject({
      error: {
        code: 'http_error',
        message: 'NVIDIA provider error: invalid api key [redacted]'
      }
    });
    expect(JSON.stringify(output)).not.toContain('secret-token');
  });

  it('redacts secrets from thrown client errors', async () => {
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret-token',
      fetchClient: () => {
        throw new Error('network failed with secret-token');
      }
    });
    const output = await adapter.invoke(createTestEnvelope());

    expect(output.rejection).toEqual({
      reason: roleModelProviderErrorRejectionReason,
      details: 'network failed with [redacted]'
    });
    expect(output.providerMetadata).toMatchObject({
      error: {
        code: 'provider_error',
        message: 'network failed with [redacted]'
      }
    });
    expect(JSON.stringify(output)).not.toContain('secret-token');
  });

  it('maps malformed and empty successful provider responses to provider errors', async () => {
    const malformedAdapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret-token',
      fetchClient: () =>
        Promise.resolve(createJsonResponse(200, {
          choices: []
        }))
    });
    const emptyAdapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret-token',
      fetchClient: () =>
        Promise.resolve(createJsonResponse(200, {
          choices: [
            {
              message: {
                content: ''
              }
            }
          ]
        }))
    });

    await expect(malformedAdapter.invoke(createTestEnvelope())).resolves.toMatchObject({
      rawOutputText: '',
      rejection: {
        reason: roleModelProviderErrorRejectionReason,
        details: 'NVIDIA response must include at least one choice.'
      },
      providerMetadata: {
        error: {
          code: 'malformed_response',
          message: 'NVIDIA response must include at least one choice.'
        }
      }
    });
    await expect(emptyAdapter.invoke(createTestEnvelope())).resolves.toMatchObject({
      rawOutputText: '',
      rejection: {
        reason: roleModelProviderErrorRejectionReason,
        details: 'NVIDIA response content is empty.'
      },
      providerMetadata: {
        error: {
          code: 'empty_output',
          message: 'NVIDIA response content is empty.'
        }
      }
    });
  });

  it('loads provider config from environment without requiring committed secrets', () => {
    expect(
      createNvidiaRoleModelProviderConfigFromEnv({
        NVIDIA_API_KEY: 'env-key',
        NVIDIA_MODEL: 'custom-model'
      })
    ).toEqual({
      apiKey: 'env-key',
      model: 'custom-model'
    });
  });
});

function createTestEnvelope() {
  return createRoleModelInputEnvelope({
    event: createUserMessageRuntimeEvent('hello', {
      eventId: 'evt_provider',
      traceId: 'trace_provider',
      createdAt: '2026-06-10T00:00:00.000Z'
    }),
    decisionContext: createDecisionContext({
      sessionId: 'mira-local',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      }
    })
  });
}

function createJsonResponse(status: number, body: unknown): NvidiaFetchResponse {
  return Object.freeze({
    ok: status >= 200 && status < 300,
    status,
    json() {
      return Promise.resolve(body);
    },
    text() {
      return Promise.resolve(JSON.stringify(body));
    }
  } satisfies NvidiaFetchResponse);
}
