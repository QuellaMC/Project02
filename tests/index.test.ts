import { describe, expect, it } from 'vitest';

import {
  createDeterministicLocalRoleModelAdapter
} from '../src/role-model/loop.ts';
import {
  parseRoleModelDecision,
  roleModelDecisionContractVersion
} from '../src/role-model/contracts.ts';
import {
  projectHealth
} from '../src/index.ts';
import {
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';

describe('projectHealth', () => {
  it('reports the TypeScript baseline is callable', () => {
    expect(projectHealth()).toEqual({
      status: 'ok',
      runtime: 'typescript'
    });
  });
});

describe('role-model module smoke', () => {
  it('exposes the local adapter and parser through concrete modules', () => {
    expect(createDeterministicLocalRoleModelAdapter()).toHaveProperty('invoke');
    expect(
      parseRoleModelDecision(
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
      )
    ).toEqual({
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
});
