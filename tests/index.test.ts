import { describe, expect, it } from 'vitest';

import {
  createDeterministicLocalRoleModelAdapter,
  parseRoleModelDecision,
  projectHealth,
  roleModelDecisionContractVersion,
  visibleReplyModelToolName
} from '../src/index.ts';

describe('projectHealth', () => {
  it('reports the TypeScript baseline is callable', () => {
    expect(projectHealth()).toEqual({
      status: 'ok',
      runtime: 'typescript'
    });
  });
});

describe('public role-model loop exports', () => {
  it('exposes the local adapter and parser through the package surface', () => {
    expect(createDeterministicLocalRoleModelAdapter()).toHaveProperty('invoke');
    expect(
      parseRoleModelDecision(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: visibleReplyModelToolName,
              input: {
                text: 'hello'
              }
            }
          ]
        })
      )
    ).toEqual({
      status: 'accepted',
      decision: {
        version: 'mvp-006.tool_calls.v1',
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
});
