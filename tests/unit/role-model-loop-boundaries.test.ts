import {describe, expect, it} from 'vitest';
import {
  defaultRoleModelProviderCapabilities,
  isRoleModelRawOutputReplayableDecisionEvidence,
  type RoleModelAdapter,
  type RoleModelPluginToolDefinition,
  type RoleModelPluginToolHost,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  runRoleModelLoop,
  visibleReplyModelToolName,
} from '../../src/role-model/index.ts';
import {
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolCallResult,
} from '../../src/plugins/api/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  acceptingPluginToolHost,
  createAcceptedToolCallResult,
  createDegradingRejectedMemorySearchPlugin,
  createProviderMetadataAdapter,
  createSequencedAdapter,
  createTestDecisionContext,
  createTestEvent,
  createTestPluginContext,
  memorySearchToolDefinition,
} from '../support/role-model-loop-fixtures.ts';

describe('role-model loop evidence and boundary validation', () => {
  it('dispatches tool input to the host exactly as the model sent it', async () => {
    let dispatchedInput: Readonly<Record<string, unknown>> | undefined;
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_secret_tool_input'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {
                name: 'memory.search',
                input: {
                  query: 'Authorization: Bearer input-secret',
                  access_token: 'structured-secret',
                },
              },
            ],
          },
          {
            toolCalls: [
              {name: 'visible_reply', input: {text: 'Completed safely.'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          dispatchedInput = call.input;
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext('evt_secret_tool_input'),
    });

    expect(result.status).toBe('accepted');
    // The host receives what the model sent, byte for byte.
    expect(dispatchedInput).toEqual({
      access_token: 'structured-secret',
      query: 'Authorization: Bearer input-secret',
    });
  });

  it('continues prompting when the real plugin host degrades optional rejected tool results', async () => {
    let invocations = 0;
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'continued after degraded host result',
              },
            },
          ],
        },
      ],
      () => {
        invocations += 1;
      },
    );
    const plugin = createDegradingRejectedMemorySearchPlugin();
    const pluginToolHost = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id],
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_host_degraded_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: pluginToolHost.pluginToolDefinitions(),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_host_degraded_plugin_tool',
      ),
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]?.result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'degraded',
          policyOutcome: 'optional_degraded',
        },
      ],
    });
  });

  it('normalizes non-finite numbers in accepted plugin tool output from custom hosts', async () => {
    let invocations = 0;
    let handledCalls = 0;
    const eventId = 'evt_non_finite_plugin_output';
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'continued after invalid output',
              },
            },
          ],
        },
      ],
      () => {
        invocations += 1;
      },
    );
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;

        return Object.freeze({
          status: 'accepted',
          output: Object.freeze({
            score: Number.NaN,
            ratio: Number.POSITIVE_INFINITY,
          }),
          evidence: Object.freeze([]),
        } satisfies RuntimePluginToolCallResult);
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', eventId),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(eventId),
    });

    expect(result).toMatchObject({
      status: 'accepted',
    });
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]).toMatchObject({
      callId: `${eventId}.trace_${eventId}.round-1.1.memory.search`,
      result: {
        status: 'accepted',
        output: {score: null, ratio: null},
      },
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.pluginToolResults).toHaveLength(1);
  });

  it('rejects custom-host evidence that does not match the routed call identity', async () => {
    const eventId = 'evt_custom_host_evidence_identity';
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', eventId),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
          },
          {
            toolCalls: [
              {name: 'visible_reply', input: {text: 'Continued safely.'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: {safe: true},
            evidence: [
              {
                eventId: 'wrong-event',
                traceId: 'wrong-trace',
                createdAt: '2026-06-15T00:00:00.000Z',
                kind: 'runtime_plugin_evidence_snapshot',
                pluginId: 'wrong-plugin',
                evidenceKind: 'tool_invocation',
                status: 'accepted',
                summary: 'api_key=must-not-leak',
                redactionLabels: [],
              },
            ],
          } satisfies RuntimePluginToolCallResult);
        },
      }),
      runtimePluginContext: createTestPluginContext(eventId),
    });

    expect(result.pluginToolResults[0]).toMatchObject({
      result: {
        status: 'rejected',
        reason: 'invalid_tool_output',
        message: 'Plugin tool evidence identity must match the routed call.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('rejects custom-host evidence missing its canonical discriminator', async () => {
    const eventId = 'evt_custom_host_evidence_kind';
    const context = createTestPluginContext(eventId);
    const malformedEvidence = {
      eventId: context.eventId,
      traceId: context.traceId,
      createdAt: context.timestamp,
      kind: 'runtime_plugin_evidence_snapshot',
      pluginId: memorySearchToolDefinition.pluginId,
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'looks valid without its kind',
      redactionLabels: [],
    } satisfies RuntimePluginEvidenceSnapshot;
    Reflect.deleteProperty(malformedEvidence, 'kind');
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', eventId),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
          },
          {
            toolCalls: [
              {name: 'visible_reply', input: {text: 'Continued safely.'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: {safe: true},
            evidence: [malformedEvidence],
          } satisfies RuntimePluginToolCallResult);
        },
      }),
      runtimePluginContext: context,
    });

    expect(result.pluginToolResults[0]).toMatchObject({
      result: {
        status: 'rejected',
        reason: 'invalid_tool_output',
        message: 'Plugin evidence snapshot kind is not supported.',
      },
    });
  });

  it('counts successful tool observations toward required plugin tools across the turn', async () => {
    let invocations = 0;
    let handledCalls = 0;
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'memory checked',
              },
            },
          ],
        },
      ],
      () => {
        invocations += 1;
      },
    );
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;

        return createAcceptedToolCallResult();
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_required_observed'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_required_observed'),
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.rounds).toHaveLength(2);
  });

  it('allows multiple required tools to complete in sequential rounds', async () => {
    const handledTools: string[] = [];
    const secondRequiredTool = Object.freeze({
      ...memorySearchToolDefinition,
      name: 'memory.recall',
      description: 'Recall memory.',
    } satisfies RoleModelPluginToolDefinition);
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: memorySearchToolDefinition.name,
              input: {query: 'Mira'},
            },
          ],
        },
        {
          toolCalls: [
            {
              name: secondRequiredTool.name,
              input: {query: 'Mira'},
            },
          ],
        },
        {
          toolCalls: [
            {
              name: visibleReplyModelToolName,
              input: {text: 'Both required lookups completed.'},
            },
          ],
        },
      ],
      () => undefined,
    );
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_sequential_required_tools'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([
        memorySearchToolDefinition,
        secondRequiredTool,
      ]),
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          handledTools.push(call.toolName);
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext(
        'evt_sequential_required_tools',
      ),
    });

    expect(result.status).toBe('accepted');
    expect(handledTools).toEqual(['memory.search', 'memory.recall']);
    expect(result.rounds).toHaveLength(3);
  });

  it('hands a blank visible_reply back to the model as its next round', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('reply blank', 'evt_blank_reply_feedback'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: '   '}},
            ],
          },
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: 'real reply'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: [],
      pluginToolHost: acceptingPluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_blank_reply_feedback'),
    });

    expect(result.status).toBe('accepted');
    expect(result.rounds).toHaveLength(2);
    if (result.status !== 'accepted') {
      throw new Error(
        'Expected the model to get another round after a blank reply.',
      );
    }
    expect(executionResultVisibleReply(result)).toBe('real reply');
  });

  it('tool_rounds_exhausted ends the turn and leaves the parsed round accepted', async () => {
    let handledCalls = 0;
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_rounds_exhausted'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost: Object.freeze({
        handleToolCall() {
          handledCalls += 1;
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext('evt_rounds_exhausted'),
      adapter: createSequencedAdapter(
        [{toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}]}],
        () => undefined,
      ),
      maxToolRounds: 0,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {reason: 'tool_rounds_exhausted'},
      parsedDecisionSnapshot: {result: {status: 'accepted'}},
    });
    if (result.status !== 'rejected') {
      throw new Error('Expected the budget to end the turn.');
    }

    // The parser's verdict stands: the round is what the model said, and the
    // refusal is the runtime's, recorded against the commit.
    expect(handledCalls).toBe(0);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.pluginToolResults).toEqual([]);
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: result.ioSnapshot.rawOutputText,
        decisionResult: result.parsedDecisionSnapshot.result,
      }),
    ).toBe(true);
  });

  it('drops non-finite provider metadata numbers from the snapshot', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_non_finite_provider_metadata'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [],
      pluginToolHost: acceptingPluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_non_finite_provider_metadata',
      ),
      adapter: createProviderMetadataAdapter(
        Object.freeze({
          provider: 'nvidia',
          request: Object.freeze({
            messageCount: Number.NaN,
            stream: false,
          }),
          response: Object.freeze({
            status: Number.POSITIVE_INFINITY,
          }),
        } satisfies RoleModelProviderMetadata),
      ),
    });

    expect(result.ioSnapshot.providerMetadata?.request).not.toHaveProperty(
      'messageCount',
    );
    expect(result.ioSnapshot.providerMetadata?.response).not.toHaveProperty(
      'status',
    );
  });

  it('rejects malformed provider exchange evidence at the adapter boundary', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_malformed_provider_exchange'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [],
      pluginToolHost: acceptingPluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_malformed_provider_exchange',
      ),
      adapter: Object.freeze({
        invoke(_inputEnvelope, invocation) {
          const providerExchange: RoleModelProviderExchangeSnapshot = {
            provider: {
              name: 'nvidia',
            },
            capabilities: defaultRoleModelProviderCapabilities,
            reasoning: {
              mode: 'enabled',
              params: {},
            },
            renderedMessages: invocation.turnContext.messages,
            renderedTools: invocation.turnContext.tools,
            toolNameMappings: [],
            requestBody: {},
            nativeToolResultMessages: [],
          };
          Reflect.deleteProperty(providerExchange, 'reasoning');

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'hello',
                  },
                },
              ],
            }),
            providerExchange,
          };
        },
      } satisfies RoleModelAdapter),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: 'provider_error',
        details: 'Role-model adapter provider exchange is malformed.',
      },
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot).not.toHaveProperty('providerExchange');
  });
});

function executionResultVisibleReply(
  result: Extract<
    Awaited<ReturnType<typeof runRoleModelLoop>>,
    {status: 'accepted'}
  >,
): string | undefined {
  const call = result.decision.toolCalls.find(
    toolCall => toolCall.name === visibleReplyModelToolName,
  );
  const text = call?.input['text'];

  return typeof text === 'string' ? text : undefined;
}
