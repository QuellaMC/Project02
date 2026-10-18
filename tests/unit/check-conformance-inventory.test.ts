import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';

const script = fileURLToPath(
  new URL('../../scripts/check-conformance-inventory.mjs', import.meta.url),
);
const header =
  'id,area,statement,boundary,source_tests,coverage_today,blackbox,notes,' +
  'test_location,stage,status';

function row(id: string, testLocation: string, status: string): string {
  const area = id.split('.')[0] ?? '';

  return `${id},${area},A statement.,WIRE,-,none,yes,,${testLocation},0,${status}`;
}

/** Runs the check in a directory of its own holding these files. */
function check(files: Readonly<Record<string, readonly string[]>>) {
  const root = createTestTempRoot('project02-conformance-inventory-');

  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), `${lines.join('\n')}\n`);
  }

  return spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8'});
}

describe('the conformance inventory check', () => {
  it('passes when every title names a conformance row and every done row has a test, counting each area', () => {
    const result = check({
      'tests/conformance/inventory.csv': [
        header,
        'lifecycle.a,lifecycle,"Says ""ready"", then serves.",PROCESS,-,none,yes,,conformance,0,done',
        row('lifecycle.b', 'conformance', 'todo'),
        row('lifecycle.c', 'rust-unit', 'todo'),
        row('turns.d', 'conformance', 'todo'),
        row('page.e', 'client-ts', 'todo'),
      ],
      'tests/conformance/lifecycle/address.test.ts': [
        "it('lifecycle.a: says ready, then serves', () => {});",
        'it(',
        `  "lifecycle.b: a title that wrapped, and that's quoted",`,
        '  () => {},',
        ');',
        "it.each<[string, string]>([['a', ')']])('turns.d: %s', () => {});",
        "test.skip('turns.d: skipped for now', () => {});",
      ],
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'conformance-inventory: 4 test(s) name rows of ' +
        'tests/conformance/inventory.csv; conformance rows done/todo by ' +
        'area: lifecycle 1/1, turns 0/1.\n',
    );
    expect(result.status).toBe(0);
  });

  it('names every row and title that breaks the index, and fails', () => {
    const result = check({
      'tests/conformance/inventory.csv': [
        header,
        row('lifecycle.a', 'conformance', 'done'),
        row('lifecycle.b', 'rust-unit', 'done'),
        row('lifecycle.c', 'conformance', 'todo'),
        row('lifecycle.c', 'conformance', 'todo'),
        row('lifecycle.d', 'conformance', 'finished'),
        'lifecycle.e,lifecycle,A statement.',
        row('turns.f', 'retired', 'todo'),
      ],
      'tests/conformance/turns.test.ts': [
        'it(`lifecycle.c: a template literal`, () => {});',
        'it(title, () => {});',
        "it('lifecycle.c: ' + 'joined', () => {});",
        "it('no row id here', () => {});",
        "it('lifecycle.z: names no row', () => {});",
        "it('turns.f: names a retired row', () => {});",
      ],
    });

    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n')).toEqual([
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.c is the id of two rows.',
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.d has status "finished", which is none of todo, done.',
      'conformance-inventory: tests/conformance/inventory.csv: the row starting "lifecycle.e" has 3 field(s), not 11.',
      'conformance-inventory: tests/conformance/turns.test.ts:1: the title is not a plain string literal.',
      'conformance-inventory: tests/conformance/turns.test.ts:2: the title is not a plain string literal.',
      'conformance-inventory: tests/conformance/turns.test.ts:3: the title is not a plain string literal.',
      'conformance-inventory: tests/conformance/turns.test.ts:4: the title "no row id here" is not "<row id>: <sentence>".',
      'conformance-inventory: tests/conformance/turns.test.ts:5: lifecycle.z is not a conformance row of tests/conformance/inventory.csv.',
      'conformance-inventory: tests/conformance/turns.test.ts:6: turns.f is not a conformance row of tests/conformance/inventory.csv.',
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.a is done, but no test in tests/conformance names it.',
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.b is done, but its test_location is rust-unit, not conformance.',
      '',
    ]);
    expect(result.status).toBe(1);
  });

  it('reads no row of an inventory whose header is not its eleven columns', () => {
    const result = check({
      'tests/conformance/inventory.csv': [
        'id,area,statement',
        'lifecycle.a,lifecycle,A statement.',
      ],
    });

    expect(result.stderr).toBe(
      `conformance-inventory: tests/conformance/inventory.csv must open with the header ${header}.\n`,
    );
    expect(result.status).toBe(1);
  });
});
