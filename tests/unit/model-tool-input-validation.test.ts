import {describe, expect, it} from 'vitest';
import {validateModelToolInputAgainstContract} from '../../src/role-model/api/index.ts';

describe('model tool input validation', () => {
  it('does not satisfy a prototype-named required field with the inherited value', () => {
    const result = validateModelToolInputAgainstContract({
      toolName: 'memory.capture',
      input: {},
      inputContract: {
        type: 'object',
        properties: {toString: {type: 'string' as const}},
        required: ['toString'],
        additionalProperties: false,
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      details: 'memory.capture input missing required field "toString".',
    });
  });

  it('phrases a union type failure with every allowed type', () => {
    const result = validateModelToolInputAgainstContract({
      toolName: 'memory.capture',
      input: {score: 'high'},
      inputContract: {
        type: 'object',
        properties: {score: {type: ['number', 'null']}},
        required: ['score'],
        additionalProperties: false,
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      details: 'memory.capture input field "score" must be number or null.',
    });
  });
});
