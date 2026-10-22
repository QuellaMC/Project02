import {describe, expect, it} from 'vitest';

import {readTestDurations} from '../../src/frontends/telegram/test-durations.ts';

const keys = ['pairing', 'heartbeat', 'grace'] as const;

describe('the test durations variable', () => {
  it('sets the keys it names, and none when it is absent', () => {
    expect(readTestDurations({}, keys)).toEqual({durations: new Map()});
    expect(
      readTestDurations(
        {PROJECT02_TEST_DURATIONS: 'pairing=2000,heartbeat=100'},
        keys,
      ),
    ).toEqual({
      durations: new Map([
        ['pairing', 2000],
        ['heartbeat', 100],
      ]),
    });
  });

  it.each([
    [
      'nap=5',
      'PROJECT02_TEST_DURATIONS: unknown key "nap"; the keys here are pairing, heartbeat, grace.',
    ],
    [
      'pairing=5,pairing=6',
      'PROJECT02_TEST_DURATIONS: key "pairing" is given twice.',
    ],
    [
      'pairing=1.5',
      'PROJECT02_TEST_DURATIONS: key "pairing" needs a whole number of milliseconds above 0, not "1.5".',
    ],
    [
      'heartbeat=0',
      'PROJECT02_TEST_DURATIONS: key "heartbeat" needs a whole number of milliseconds above 0, not "0".',
    ],
  ])('refuses %s, naming the key', (value, refusal) => {
    expect(readTestDurations({PROJECT02_TEST_DURATIONS: value}, keys)).toEqual({
      refusal,
    });
  });
});
