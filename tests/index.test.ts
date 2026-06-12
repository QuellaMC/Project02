import { describe, expect, it } from 'vitest';

import {
  createDeterministicLocalRoleModelAdapter,
  parseRoleModelDecision,
  projectHealth,
  roleModelVisibleReplyActionName
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
          action: {
            type: roleModelVisibleReplyActionName,
            text: 'hello'
          }
        })
      )
    ).toEqual({
      status: 'accepted',
      decision: {
        version: 'mvp-006.tool_calls.v1',
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'hello'
            }
          }
        ]
      }
    });
  });
});
