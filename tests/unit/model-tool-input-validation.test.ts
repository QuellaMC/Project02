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

  it('enforces schema keywords beyond the old field vocabulary', () => {
    const result = validateModelToolInputAgainstContract({
      toolName: 'memory.capture',
      input: {note: ''},
      inputContract: {
        type: 'object',
        properties: {note: {type: 'string', minLength: 1}},
        required: ['note'],
        additionalProperties: false,
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      details:
        'memory.capture input field "note" must NOT have fewer than 1 characters.',
    });
  });

  const closedBranchA = {
    type: 'object',
    properties: {a: {type: 'string'}},
    required: ['a'],
    additionalProperties: false,
  } as const;
  const closedBranchB = {
    type: 'object',
    properties: {b: {type: 'string'}},
    required: ['b'],
    additionalProperties: false,
  } as const;

  it.each([
    [
      'inline branches',
      {
        type: 'object',
        properties: {pick: {oneOf: [closedBranchA, closedBranchB]}},
        required: ['pick'],
        additionalProperties: false,
      },
    ],
    [
      '$ref branches',
      {
        type: 'object',
        properties: {
          pick: {oneOf: [{$ref: '#/$defs/a'}, {$ref: '#/$defs/b'}]},
        },
        required: ['pick'],
        additionalProperties: false,
        $defs: {a: closedBranchA, b: closedBranchB},
      },
    ],
  ] as const)(
    'phrases a mixed-branch oneOf failure with %s as the combinator, not the branches',
    (_case, inputContract) => {
      const result = validateModelToolInputAgainstContract({
        toolName: 'memory.capture',
        input: {pick: {a: 'x', b: 'y'}},
        inputContract,
      });

      expect(result).toMatchObject({
        status: 'rejected',
        details:
          'memory.capture input field "pick" must match exactly one schema in oneOf.',
      });
    },
  );

  it('names the offending key in a property-name failure', () => {
    const result = validateModelToolInputAgainstContract({
      toolName: 'memory.capture',
      input: {Bad: 1},
      inputContract: {
        type: 'object',
        propertyNames: {pattern: '^[a-z]+$'},
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      details:
        'memory.capture input property name "Bad" must match pattern "^[a-z]+$".',
    });
  });

  it('phrases a const failure with the required value', () => {
    const result = validateModelToolInputAgainstContract({
      toolName: 'memory.capture',
      input: {mode: 'fast'},
      inputContract: {
        type: 'object',
        properties: {mode: {const: 'safe'}},
        required: ['mode'],
        additionalProperties: false,
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      details: 'memory.capture input field "mode" must be safe.',
    });
  });

  it('decodes JSON Pointer escapes in rejection field paths', () => {
    const result = validateModelToolInputAgainstContract({
      toolName: 'memory.capture',
      input: {'a/b': 'high'},
      inputContract: {
        type: 'object',
        properties: {'a/b': {type: 'number'}},
        required: ['a/b'],
        additionalProperties: false,
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      details: 'memory.capture input field "a/b" must be number.',
    });
  });

  it('phrases structured enum alternatives as their JSON text', () => {
    const result = validateModelToolInputAgainstContract({
      toolName: 'memory.capture',
      input: {mode: {kind: 'c'}},
      inputContract: {
        type: 'object',
        properties: {mode: {enum: [{kind: 'a'}, {kind: 'b'}]}},
        required: ['mode'],
        additionalProperties: false,
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      details:
        'memory.capture input field "mode" must be one of: {"kind":"a"}, {"kind":"b"}.',
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
