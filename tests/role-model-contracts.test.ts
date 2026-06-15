import { describe, expect, it } from 'vitest';

import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';
import {
  parseRoleModelDecision,
  roleModelDecisionContractVersion,
  roleModelUnsupportedEffectRejectionReason,
  roleModelUnknownToolRejectionReason
} from '../src/role-model/contracts.ts';
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
        version: 'mvp-007.runtime_plugin.v1',
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

  it('rejects undeclared executable tools before loop routing', () => {
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
      status: 'rejected',
      rejection: {
        reason: roleModelUnknownToolRejectionReason
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
