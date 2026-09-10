import {describe, expect, it} from 'vitest';
import {createJsonStringFieldScanner} from '../../src/role-model/providers/reply-draft.ts';

/** Inputs and the value the scanner must decode from them, whole or in any two pieces. */
const cases: readonly (readonly [string, string])[] = [
  ['{"text": "hello"}', 'hello'],
  ['{"text":"a\\"b\\\\c\\/d\\n\\t\\b\\f\\r"}', 'a"b\\c/d\n\t\b\f\r'],
  ['{ "text" : "caf\\u00e9 \\ud83d\\ude00!" }', 'café 😀!'],
  ['{"text": "done"} and whatever follows', 'done'],
  ['{"other": "x", "text": "y"}', ''],
  ['{"text": 5}', ''],
  ['{"text": "bad \\q escape"}', 'bad '],
  ['not json at all', ''],
  ['', ''],
];

describe('JSON string field scanner', () => {
  it.each(cases)('decodes %j whole', (input, expected) => {
    expect(createJsonStringFieldScanner('text').push(input)).toBe(expected);
  });

  it.each(cases)(
    'decodes %j the same at every split point',
    (input, expected) => {
      for (let split = 0; split <= input.length; split += 1) {
        const scanner = createJsonStringFieldScanner('text');

        expect(
          scanner.push(input.slice(0, split)) +
            scanner.push(input.slice(split)),
        ).toBe(expected);
      }
    },
  );

  it('holds a cut escape and a lone high surrogate until they are whole', () => {
    const scanner = createJsonStringFieldScanner('text');

    expect(scanner.push('{"text":"a\\u00')).toBe('a');
    expect(scanner.push('e9\\ud8')).toBe('é');
    expect(scanner.push('3d')).toBe('');
    expect(scanner.push('\\ude00 b"}')).toBe('😀 b');
    expect(scanner.push('{"text":"again"}')).toBe('');
  });
});
