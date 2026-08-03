import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  createAcceptedRoleModelDecisionResult,
  createDecisionContext,
  createDefaultRoleModelPluginToolDefinitions,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelPluginToolDefinitions,
  createRoleModelToolObservation,
  createVisibleReplyCharacterDecision,
  isRoleModelRawOutputReplayableDecisionEvidence,
  parseRoleModelDecision,
  roleModelDecisionContractVersion,
  roleModelMalformedOutputRejectionReason,
  type RoleModelPluginToolDefinition,
  roleModelTerminalEmptyOutputRejectionDetails,
  roleModelUnsupportedEffectRejectionReason,
  visibleReplyModelToolName,
} from '../../src/role-model/index.ts';
import {characterStatePatchModelToolName} from '../../src/plugins/api/contract.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {runtimePluginListToolName} from '../../src/plugins/api/contract.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';

describe('role-model contracts', () => {
  it('accepts an approval-gated config-write definition without an identity carve-out', () => {
    const definitions = createRoleModelPluginToolDefinitions([
      {
        pluginId: 'settings.arbitrary.fixture',
        name: 'settings.arbitrary.update',
        description: 'Update one arbitrary settings field after approval.',
        inputContract: {
          type: 'object',
          fields: [],
          additionalFields: false,
        },
        validationOwner: 'plugin_host',
        requiresConfirmation: true,
        sourceReferencesRequired: false,
      },
    ]);

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      pluginId: 'settings.arbitrary.fixture',
      name: 'settings.arbitrary.update',
    });
  });

  it.each([
    ['input', Number.NaN],
    ['output', Number.POSITIVE_INFINITY],
  ] as const)(
    'rejects non-finite tool observation %s at the public constructor',
    (surface, nonFiniteValue) => {
      expect(() =>
        createRoleModelToolObservation({
          round: 1,
          pluginId: 'memory',
          toolName: 'memory.search',
          input: {
            query: 'Mira',
            ...(surface === 'input' ? {score: nonFiniteValue} : {}),
          },
          result: {
            status: 'accepted',
            output:
              surface === 'output'
                ? {score: nonFiniteValue}
                : {summary: 'found'},
          },
        }),
      ).toThrow('must be finite JSON.');
    },
  );

  it('redacts credentials in public tool observations', () => {
    const observation = createRoleModelToolObservation({
      round: 1,
      pluginId: 'memory',
      toolName: 'memory.search',
      input: {
        query: 'Authorization: ApiKey input-secret',
        authorization: 'Bearer input-token',
        aws_secret_access_key: 'aws-secret',
        ssh_private_key_pem: 'ssh-secret',
        oauth_client_secret_value: 'oauth-secret',
        endpoint: 'cockroachdb://user:pass@example.test/db',
      },
      result: {
        status: 'rejected',
        reason: 'handler_failed token=reason-secret',
        message: 'Cookie: session=message-secret',
      },
    });
    const serialized = JSON.stringify(observation);

    expect(serialized).not.toContain('input-secret');
    expect(serialized).not.toContain('input-token');
    expect(serialized).not.toContain('reason-secret');
    expect(serialized).not.toContain('message-secret');
    expect(serialized).not.toContain('aws-secret');
    expect(serialized).not.toContain('ssh-secret');
    expect(serialized).not.toContain('oauth-secret');
    expect(serialized).not.toContain('user:pass');
    expect(observation).toMatchObject({
      input: {
        query: 'Authorization: [redacted]',
        authorization: '[redacted]',
        aws_secret_access_key: '[redacted]',
        ssh_private_key_pem: '[redacted]',
        oauth_client_secret_value: '[redacted]',
        endpoint: 'cockroachdb://[redacted]@example.test/db',
      },
      result: {
        status: 'rejected',
        reason: 'handler_failed token=[redacted]',
        message: 'Cookie: [redacted]',
      },
    });
  });

  it.each([
    'Adapter raw output must include string rawOutputText.',
    'Role-model adapter provider exchange is malformed.',
    'Adapter rejection must be replayable from rawOutputText.',
    'Role-model adapter native tool-call argument errors are malformed.',
    'providerMetadata.request.messageCount must be finite JSON.',
    'providerMetadata.response.status must be finite JSON.',
  ])('replays malformed adapter evidence detail %s', details => {
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: '',
        providerMetadata: undefined,
        decisionResult: createRejectedRoleModelDecisionResult(
          roleModelMalformedOutputRejectionReason,
          details,
        ),
      }),
    ).toBe(true);
  });

  it('keeps the real host default allowed tools unique and ordered', () => {
    const pluginHost = createDefaultProject02PluginHost();
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_default_allowed_tools',
      traceId: 'trace_default_allowed_tools',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const inputEnvelope = createRoleModelInputEnvelope({
      event: createUserMessageRuntimeEvent('hello', identity),
      decisionContext: createDecisionContext({
        sessionId: 'session-default-allowed-tools',
        characterSnapshot: testCharacterProfile,
      }),
      pluginToolDefinitions: pluginHost.pluginToolDefinitions(),
    });

    expect(inputEnvelope.allowedTools).toEqual([
      visibleReplyModelToolName,
      runtimePluginListToolName,
      characterStatePatchModelToolName,
    ]);
  });

  it('redacts credentials throughout shared provider exchange snapshots', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_provider_exchange_redaction',
      traceId: 'trace_provider_exchange_redaction',
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const inputEnvelope = createRoleModelInputEnvelope({
      event: createUserMessageRuntimeEvent('hello', identity),
      decisionContext: createDecisionContext({
        sessionId: 'session-provider-exchange-redaction',
        characterSnapshot: testCharacterProfile,
      }),
      pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
    });
    const snapshot = createRoleModelIOSnapshot({
      ...identity,
      sessionId: 'session-provider-exchange-redaction',
      inputEnvelope,
      rawOutputText: JSON.stringify({
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {text: 'api_key=raw-output-secret'},
          },
        ],
      }),
      providerExchange: {
        provider: {
          name: 'nvidia',
          model: 'model?token=model-secret',
          endpoint: 'https://user:pass@example.test/chat',
        },
        capabilities: {
          supportsNativeTools: true,
          supportsDeveloperOrSystemContext: true,
          preferredModelContextRole: 'developer',
          supportsStrictToolSchema: true,
          supportsReasoning: false,
          reasoningParameterStyle: 'none',
          requiresReasoningBlockRoundTrip: false,
          supportsToolChoice: true,
          supportsParallelToolCalls: false,
        },
        reasoning: {mode: 'none', params: {}},
        renderedMessages: [
          {role: 'user', content: 'Authorization: Bearer message-secret'},
        ],
        renderedTools: [],
        toolNameMappings: [],
        requestBody: {cookie: 'session=request-secret'},
        nativeToolResultMessages: [],
        responseBody: {access_token: 'response-secret'},
      },
    });
    const serialized = JSON.stringify(snapshot.providerExchange);

    expect(snapshot.rawOutputText).toContain('api_key=[redacted]');
    expect(snapshot.rawOutputText).not.toContain('raw-output-secret');
    expect(serialized).toContain('[redacted]');
    for (const secret of [
      'model-secret',
      'user:pass',
      'message-secret',
      'request-secret',
      'response-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('redacts accepted decision text at the public snapshot constructor', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_decision_constructor_redaction',
      traceId: 'trace_decision_constructor_redaction',
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const snapshot = createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: 'session-decision-constructor-redaction',
      result: createAcceptedRoleModelDecisionResult(
        createVisibleReplyCharacterDecision(
          'Authorization: ApiKey decision-secret',
        ),
        {nonCommittedText: 'api_key=snapshot-secret'},
      ),
    });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).toContain('Authorization: [redacted]');
    expect(serialized).not.toContain('decision-secret');
    expect(serialized).not.toContain('snapshot-secret');
  });

  it('redacts non-committed text at the public result constructor', () => {
    const result = createAcceptedRoleModelDecisionResult(
      createVisibleReplyCharacterDecision('hello'),
      {
        nonCommittedText: 'Authorization: ApiKey folded-secret',
      },
    );

    expect(result.nonCommittedText).toBe('Authorization: [redacted]');
    expect(JSON.stringify(result)).not.toContain('folded-secret');
  });

  it('rejects duplicate explicit allowed tools', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_duplicate_allowed_tools',
      traceId: 'trace_duplicate_allowed_tools',
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    expect(() =>
      createRoleModelInputEnvelope({
        event: createUserMessageRuntimeEvent('hello', identity),
        decisionContext: createDecisionContext({
          sessionId: 'session-duplicate-allowed-tools',
          characterSnapshot: testCharacterProfile,
        }),
        allowedTools: [visibleReplyModelToolName, visibleReplyModelToolName],
        pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
      }),
    ).toThrow('Role-model allowedTools must not contain duplicates.');
  });

  it('accepts several visible replies in one model response', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {name: visibleReplyModelToolName, input: {text: 'first'}},
          {name: visibleReplyModelToolName, input: {text: 'second'}},
        ],
      }),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected several replies to parse.');
    }

    expect(result.decision.toolCalls.map(call => call.input['text'])).toEqual([
      'first',
      'second',
    ]);
  });

  it('stamps accepted versionless model output with the internal decision version', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello',
            },
          },
        ],
      }),
    );

    expect(result).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello',
            },
          },
        ],
      },
    });
  });

  it('ignores model-supplied version and keeps the internal decision version', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        version: 'mvp-008.runtime_plugin.v2',
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello',
            },
          },
        ],
      }),
    );

    expect(result).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello',
            },
          },
        ],
      },
    });
  });

  it('accepts character_state.patch as executable plugin-owned input', () => {
    const pluginHost = createDefaultProject02PluginHost();
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {
            name: characterStatePatchModelToolName,
            input: {
              mood: 'angry',
            },
          },
        ],
      }),
      [characterStatePatchModelToolName],
      pluginHost.pluginToolDefinitions(),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: [
          {
            name: characterStatePatchModelToolName,
            input: {
              mood: 'angry',
            },
          },
        ],
      },
    });
  });

  it('accepts top-level text only when no tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [],
        text: 'folded model note',
      }),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: [],
      },
      nonCommittedText: 'folded model note',
    });
  });

  it('redacts credentials in parsed top-level text', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [],
        text: 'api_key=parsed-secret',
      }),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      nonCommittedText: 'api_key=[redacted]',
    });
    expect(JSON.stringify(result)).not.toContain('parsed-secret');
  });

  it('rejects empty top-level text when no tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [],
        text: '',
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: roleModelTerminalEmptyOutputRejectionDetails,
      },
    });
  });

  it('rejects whitespace-only top-level text when no tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [],
        text: ' \n\t ',
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: roleModelTerminalEmptyOutputRejectionDetails,
      },
    });
  });

  it('replays final visible replies with prior required plugin observations from the input envelope', () => {
    const requiredToolName = 'memory.lookup';
    const pluginToolDefinitions = [
      ...createDefaultRoleModelPluginToolDefinitions(),
      {
        pluginId: 'memory',
        name: requiredToolName,
        description: 'Look up relevant memory before answering.',
        inputContract: {
          type: 'object',
          fields: [],
          additionalFields: true,
        },
        validationOwner: 'plugin_host',
        requiresConfirmation: false,
        sourceReferencesRequired: false,
      },
    ] satisfies readonly RoleModelPluginToolDefinition[];
    const toolObservations = [
      {
        round: 1,
        pluginId: 'memory',
        toolName: requiredToolName,
        input: {
          query: 'Mira',
        },
        result: {
          status: 'accepted',
          output: {
            summary: 'Mira likes concise replies.',
          },
        },
      },
    ] as const;
    const allowedTools = [visibleReplyModelToolName, requiredToolName];
    const rawOutputText = JSON.stringify({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Got it.',
          },
        },
      ],
    });
    const decisionResult = parseRoleModelDecision(
      rawOutputText,
      allowedTools,
      pluginToolDefinitions,
      toolObservations,
    );

    expect(decisionResult).toMatchObject({
      status: 'accepted',
    });
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText,
        providerMetadata: undefined,
        decisionResult,
        allowedTools,
        pluginToolDefinitions,
        toolObservations,
      }),
    ).toBe(true);
  });

  it('rejects top-level text when tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'committed reply',
            },
          },
        ],
        text: 'second non-committed reply',
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Decision text is only allowed when toolCalls is empty.',
      },
    });
  });

  it('accepts executable tools omitted from allowedTools; routing enforces the allowlist', () => {
    const memoryUnknownTool = {
      pluginId: 'memory',
      name: 'memory.unknown',
      description: 'Exercise a defined but unavailable memory tool.',
      inputContract: {
        type: 'object',
        fields: [],
        additionalFields: true,
      },
      validationOwner: 'plugin_host',
      requiresConfirmation: false,
      sourceReferencesRequired: false,
    } satisfies RoleModelPluginToolDefinition;
    const result = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: 'memory.unknown',
            input: {
              query: 'Mira',
            },
          },
        ],
      }),
      [visibleReplyModelToolName],
      [...createDefaultRoleModelPluginToolDefinitions(), memoryUnknownTool],
    );

    expect(result).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: [{name: 'memory.unknown', input: {query: 'Mira'}}],
      },
    });
  });

  it('rejects the removed legacy action decision shape', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: visibleReplyModelToolName,
          text: 'hello',
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelUnsupportedEffectRejectionReason,
      },
    });
  });
});
