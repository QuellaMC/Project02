import {describe, expect, it} from 'vitest';

import {readCompleteJsonLines} from '../../src/runtime/storage/json-lines.ts';

describe('append-only JSONL reading', () => {
  it('drops only what a crash left after the final newline', () => {
    expect(readCompleteJsonLines('{"a":1}\n{"b":2}\n')).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
    expect(readCompleteJsonLines('{"a":1}\n{"b')).toEqual(['{"a":1}']);
    expect(readCompleteJsonLines('{"a":1}\n   ')).toEqual(['{"a":1}']);
    expect(readCompleteJsonLines('')).toEqual([]);
  });

  it.each([
    ['a committed blank record', '{"a":1}\n\n{"b":2}\n'],
    ['a committed unparseable record', '{"a":1}\n{"b\n{"c":3}\n'],
    ['a blank record before the torn tail', '{"a":1}\n\n{"b'],
  ])('reports %s rather than a short history', (_description, content) => {
    expect(() => readCompleteJsonLines(content)).toThrow(
      /line 2 is not valid JSON/iu,
    );
  });
});
