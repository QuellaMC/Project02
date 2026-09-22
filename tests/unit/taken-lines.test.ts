import {writeFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {
  readTakenLines,
  takenLinesPath,
  writeTakenLines,
} from '../../src/runtime/storage/index.ts';
import {takenLine} from '../../src/runtime/storage/taken-lines.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('taken lines', () => {
  it("keeps each closed segment's user lines by client id, answers a lookup across segments, and reads a missing or unreadable record as nothing", () => {
    const record = {
      storeRoot: createTestTempRoot('project02-taken-lines-'),
      conversationId: 'conv-1',
    };

    expect(readTakenLines(record)).toEqual(new Map());

    const lines = new Map([
      [
        1,
        new Map([
          ['msg-a', 'm-1'],
          ['msg-b', 'm-2'],
        ]),
      ],
      [2, new Map([['msg-c', 'm-3']])],
    ]);

    writeTakenLines(record, lines);
    expect(readTakenLines(record)).toEqual(lines);
    expect(takenLine(lines, 'msg-c')).toBe('m-3');
    expect(takenLine(lines, 'msg-z')).toBeUndefined();

    // The segments are the truth: a record that is not the file's shape
    // is no record, and the driver builds it again from them.
    writeFileSync(takenLinesPath(record), '{"segments": {"x": {"msg-a": 1}}}');
    expect(readTakenLines(record)).toEqual(new Map());
    writeFileSync(takenLinesPath(record), 'not json');
    expect(readTakenLines(record)).toEqual(new Map());
  });
});
