import { describe, expect, it } from 'vitest';

import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';
import {
  createDefaultRoleModelPluginToolDefinitions,
  createDecisionContext,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  isRoleModelRawOutputReplayableDecisionEvidence,
  parseRoleModelDecision,
  roleModelDecisionContractVersion,
  roleModelDuplicateToolCallRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  roleModelUnsupportedEffectRejectionReason
} from '../src/role-model/contracts.ts';
import type { RoleModelPluginToolDefinition } from '../src/role-model/contracts.ts';
import { createDefaultProject02PluginHost } from '../src/plugins/host.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';

describe('role-model contracts', () => {
  it.each([
    'Adapter raw output must include string rawOutputText.',
    'Role-model adapter provider exchange is malformed.',
    'Adapter rejection must be replayable from rawOutputText.',
    'Role-model adapter native tool-call argument errors are malformed.',
    'providerMetadata.request.messageCount must be finite JSON.',
    'providerMetadata.response.status must be finite JSON.'
  ])('replays malformed adapter evidence detail %s', (details) => {
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: '',
        providerMetadata: undefined,
        decisionResult: createRejectedRoleModelDecisionResult(
          roleModelMalformedOutputRejectionReason,
          details
        )
      })
    ).toBe(true);
  });

  it('keeps the real host default allowed tools unique and ordered', () => {
    const pluginHost = createDefaultProject02PluginHost();
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_default_allowed_tools',
      traceId: 'trace_default_allowed_tools',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const inputEnvelope = createRoleModelInputEnvelope({
      event: createUserMessageRuntimeEvent('hello', identity),
      decisionContext: createDecisionContext({
        sessionId: 'session-default-allowed-tools',
        characterSnapshot: {
          id: 'mira',
          displayName: 'Mira'
        }
      }),
      pluginToolDefinitions: pluginHost.pluginToolDefinitions()
    });

    expect(inputEnvelope.allowedTools).toEqual([
      visibleReplyModelToolName,
      'plugin.list',
      characterStatePatchModelToolName
    ]);
    expect(
      inputEnvelope.toolDefinitions.find(
        (definition) => definition.name === visibleReplyModelToolName
      )?.callLimit
    ).toEqual({
      scope: 'model_response',
      maxCalls: 1
    });
  });

  it('rejects duplicate explicit allowed tools', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_duplicate_allowed_tools',
      traceId: 'trace_duplicate_allowed_tools',
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    expect(() =>
      createRoleModelInputEnvelope({
        event: createUserMessageRuntimeEvent('hello', identity),
        decisionContext: createDecisionContext({
          sessionId: 'session-duplicate-allowed-tools',
          characterSnapshot: {
            id: 'mira',
            displayName: 'Mira'
          }
        }),
        allowedTools: [visibleReplyModelToolName, visibleReplyModelToolName]
      })
    ).toThrow('Role-model allowedTools must not contain duplicates.');
  });

  it('allows one visible reply per model response', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: { text: 'first' }
          },
          {
            name: visibleReplyModelToolName,
            input: { text: 'second' }
          }
        ]
      })
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelDuplicateToolCallRejectionReason,
        details: 'Decision must not include duplicate visible_reply tool calls.'
      }
    });
  });

  it('stamps accepted versionless model output with the internal decision version', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello'
            }
          }
        ]
      })
    );

    expect(result).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello'
            }
          }
        ]
      }
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
              text: 'hello'
            }
          }
        ]
      })
    );

    expect(result).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello'
            }
          }
        ]
      }
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
              mood: 'angry'
            }
          }
        ]
      }),
      [characterStatePatchModelToolName],
      pluginHost.pluginToolDefinitions()
    );

    expect(result).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: [
          {
            name: characterStatePatchModelToolName,
            input: {
              mood: 'angry'
            }
          }
        ]
      }
    });
  });

  it('accepts top-level text only when no tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [],
        text: 'folded model note'
      })
    );

    expect(result).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: []
      },
      nonCommittedText: 'folded model note'
    });
  });

  it('rejects empty top-level text when no tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [],
        text: ''
      })
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: roleModelTerminalEmptyOutputRejectionDetails
      }
    });
  });

  it('rejects whitespace-only top-level text when no tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [],
        text: ' \n\t '
      })
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: roleModelTerminalEmptyOutputRejectionDetails
      }
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
        requiredForUserTurn: true,
        callLimit: {
          scope: 'user_turn',
          maxCalls: 1
        },
        inputContract: {
          type: 'object',
          fields: [],
          additionalFields: true
        },
        validationOwner: 'plugin_host',
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      }
    ] satisfies readonly RoleModelPluginToolDefinition[];
    const toolObservations = [
      {
        round: 1,
        pluginId: 'memory',
        toolName: requiredToolName,
        input: {
          query: 'Mira'
        },
        result: {
          status: 'accepted',
          output: {
            summary: 'Mira likes concise replies.'
          }
        }
      }
    ] as const;
    const allowedTools = [visibleReplyModelToolName, requiredToolName];
    const rawOutputText = JSON.stringify({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Got it.'
          }
        }
      ]
    });
    const decisionResult = parseRoleModelDecision(
      rawOutputText,
      allowedTools,
      pluginToolDefinitions,
      toolObservations
    );

    expect(decisionResult).toMatchObject({
      status: 'accepted'
    });
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText,
        providerMetadata: undefined,
        decisionResult,
        allowedTools,
        pluginToolDefinitions,
        toolObservations
      })
    ).toBe(true);
  });

  it('rejects top-level text when tool calls are present', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'committed reply'
            }
          }
        ],
        text: 'second non-committed reply'
      })
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Decision text is only allowed when toolCalls is empty.'
      }
    });
  });

  it('accepts undeclared executable tools for loop routing', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: 'memory.unknown',
            input: {
              query: 'Mira'
            }
          }
        ]
      })
    );

    expect(result).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: [
          {
            name: 'memory.unknown',
            input: {
              query: 'Mira'
            }
          }
        ]
      }
    });
  });

  it('rejects the removed legacy action decision shape', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: visibleReplyModelToolName,
          text: 'hello'
        }
      })
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelUnsupportedEffectRejectionReason
      }
    });
  });
});
