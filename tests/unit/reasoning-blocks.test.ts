import {describe, expect, it} from 'vitest';
import {
  createReasoningBlockFilter,
  scrubReasoningBlocks,
  type ScrubReasoningBlocksResult,
} from '../../src/role-model/api/reasoning.ts';

const accepted = (text: string): ScrubReasoningBlocksResult => ({
  status: 'accepted',
  text,
});
const rejected: ScrubReasoningBlocksResult = {status: 'rejected'};

/** The grammar, whole: what the parser and the adapters rely on. */
const cases: readonly (readonly [string, ScrubReasoningBlocksResult])[] = [
  ['<think>plan</think>Hello', accepted('Hello')],
  ['a <reasoning kind="x">\nplan\n</reasoning> b', accepted('a  b')],
  ['<THINK>plan</Think>Hello', accepted('Hello')],
  ['< think >plan</ think >Hello', accepted('Hello')],
  ['<think>a<think>b</think>c', accepted('c')],
  ['<think>a</reasoning>b</think>c', accepted('c')],
  ['<thinking>x</thinking>', accepted('<thinking>x</thinking>')],
  ['x < y and a<b', accepted('x < y and a<b')],
  ['<thin', accepted('<thin')],
  ['plain text', accepted('plain text')],
  ['<think>still thinking about it', rejected],
  ['<think/>', rejected],
  ['a </think> b', rejected],
  ['<think>a</think>b</think>', rejected],
  ['<think>a</think foo>b', rejected],
];

describe('reasoning blocks', () => {
  it.each(cases)('reads %j the same way whole', (input, expected) => {
    expect(scrubReasoningBlocks(input)).toEqual(expected);
  });

  it.each(cases)(
    'reads %j the same way at every split point',
    (input, expected) => {
      for (let split = 0; split <= input.length; split += 1) {
        const filter = createReasoningBlockFilter();
        const passed =
          filter.push(input.slice(0, split)) + filter.push(input.slice(split));
        const ended = filter.end();

        expect(
          ended.status === 'rejected' ? ended : accepted(passed + ended.text),
        ).toEqual(expected);
      }
    },
  );

  it('passes text before a tag before the tag is complete, and holds only what could still be one', () => {
    const filter = createReasoningBlockFilter();

    expect(filter.push('hello <thi')).toBe('hello ');
    expect(filter.push('nk>hid')).toBe('');
    expect(filter.push('den</think> wor')).toBe(' wor');
    expect(filter.push('ld <')).toBe('ld ');
    expect(filter.push('3')).toBe('<3');
    expect(filter.end()).toEqual(accepted(''));
  });

  it('releases a held tail as text, and rejects a block left open at the end', () => {
    const held = createReasoningBlockFilter();

    expect(held.push('a <thin')).toBe('a ');
    expect(held.end()).toEqual(accepted('<thin'));

    const open = createReasoningBlockFilter();

    expect(open.push('a <think>b</thi')).toBe('a ');
    expect(open.end()).toEqual(rejected);
  });
});
