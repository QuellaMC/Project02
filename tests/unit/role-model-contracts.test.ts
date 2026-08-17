import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  createDecisionContext,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createConversationToolRound,
  createRoleModelPluginToolDefinitions,
  isRoleModelRawOutputReplayableDecisionEvidence,
  parseRoleModelDecision,
  roleModelDecisionContractVersion,
  roleModelMalformedOutputRejectionReason,
  roleModelProviderErrorRejectionReason,
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
          properties: {},
          required: [],
          additionalProperties: false,
        },
        validationOwner: 'plugin_host',
        requiresConfirmation: true,
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
    'normalizes a non-finite tool round %s to null',
    (surface, nonFiniteValue) => {
      const round = createConversationToolRound({
        round: 1,
        interimReplies: [],
        toolCalls: [
          {
            toolCallId: 'call-1',
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
          },
        ],
      });
      const call = round.toolCalls[0];
      const recorded =
        surface === 'input'
          ? call?.input
          : call?.result.status === 'accepted'
            ? call.result.output
            : undefined;

      expect(recorded).toMatchObject({score: null});
    },
  );

  it('replays a provider error that left no raw output', () => {
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: '',
        decisionResult: createRejectedRoleModelDecisionResult(
          roleModelProviderErrorRejectionReason,
          'upstream 503',
        ),
      }),
    ).toBe(true);
  });

  it('does not replay a rejection its raw output re-parses differently', () => {
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: JSON.stringify({
          toolCalls: [{name: visibleReplyModelToolName, input: {text: 'hi'}}],
        }),
        decisionResult: createRejectedRoleModelDecisionResult(
          roleModelMalformedOutputRejectionReason,
          'Adapter output must be valid JSON.',
        ),
      }),
    ).toBe(false);
  });

  it('offers visible_reply ahead of the host plugin tools', () => {
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
    expect(
      inputEnvelope.pluginToolDefinitions.map(definition => definition.name),
    ).not.toContain(visibleReplyModelToolName);
    expect(inputEnvelope.toolDefinitions.map(tool => tool.name)).toEqual(
      inputEnvelope.allowedTools,
    );
  });

  it('refuses a plugin tool that takes a built-in name', () => {
    expect(() =>
      createRoleModelPluginToolDefinitions([
        {
          pluginId: 'impostor.fixture',
          name: visibleReplyModelToolName,
          description: 'A plugin cannot speak for the character.',
          inputContract: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
          validationOwner: 'plugin_host',
          requiresConfirmation: false,
        },
      ]),
    ).toThrow('is a built-in model tool and cannot be provided by a plugin');
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

  it('keeps the model text next to its tool calls', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
        text: 'Let me check what I remember.',
      }),
    );

    expect(result).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
        text: 'Let me check what I remember.',
      },
    });
  });

  it('drops blank text next to tool calls', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [{name: visibleReplyModelToolName, input: {text: 'hi'}}],
        text: ' \n\t ',
      }),
    );

    expect(result).toMatchObject({status: 'accepted'});
    expect(
      result.status === 'accepted' ? result.decision : undefined,
    ).not.toHaveProperty('text');
  });

  it('refuses a round that neither replies nor calls a tool', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({toolCalls: [], text: 'folded model note'}),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details:
          'Decision toolCalls must not be empty: reply with visible_reply or call a tool.',
      },
    });
  });

  it('refuses a blank visible_reply', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [{name: visibleReplyModelToolName, input: {text: '   '}}],
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'visible_reply text must not be empty.',
      },
    });
  });

  it('hands a native tool call with non-object arguments back as malformed output', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [{name: 'memory.search', input: '{"query": nope'}],
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details:
          'Decision toolCalls[0].input for tool "memory.search" must be a JSON object; the tool call\'s arguments were not one.',
      },
    });
  });

  it('replays an accepted decision from its raw output', () => {
    const rawOutputText = JSON.stringify({
      toolCalls: [{name: visibleReplyModelToolName, input: {text: 'Got it.'}}],
      text: 'a note',
    });
    const decisionResult = parseRoleModelDecision(rawOutputText);

    expect(decisionResult).toMatchObject({status: 'accepted'});
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText,
        decisionResult,
      }),
    ).toBe(true);
  });

  it('rejects a tool input the JSON boundary cannot carry as a malformed call', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {
            name: 'memory.capture',
            input: Object.fromEntries(
              Array.from({length: 257}, (_value, index) => [
                `field${String(index)}`,
                index,
              ]),
            ),
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details:
          'Model tool "memory.capture" input exceeds the JSON container entry limit.',
      },
    });
  });

  it('rejects a decision carrying unsupported top-level fields', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [{name: visibleReplyModelToolName, input: {text: 'hello'}}],
        sideEffect: 'write a file',
      }),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Decision includes unsupported fields: sideEffect.',
      },
    });
  });
});
