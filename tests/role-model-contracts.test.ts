import { describe, expect, it } from 'vitest';

import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';
import {
  isRoleModelRawOutputReplayableDecisionEvidence,
  parseRoleModelDecision,
  roleModelDecisionContractVersion,
  roleModelMalformedOutputRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  roleModelUnsupportedEffectRejectionReason
} from '../src/role-model/contracts.ts';
import type { RoleModelPluginToolDefinition } from '../src/role-model/contracts.ts';
import { createDefaultProject02PluginHost } from '../src/plugins/host.ts';

describe('role-model contracts', () => {
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
      {
        pluginId: 'memory',
        name: requiredToolName,
        description: 'Look up relevant memory before answering.',
        requiredForUserTurn: true,
        maxCallsPerUserTurn: 1,
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
