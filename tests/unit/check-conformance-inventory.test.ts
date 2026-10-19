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
        row('lifecycle.g', 'conformance', 'done'),
        row('turns.d', 'conformance', 'todo'),
        row('page.e', 'client-ts', 'todo'),
      ],
      'tests/conformance/lifecycle/address.test.ts': [
        "import {it, test} from 'vitest';",
        "it('lifecycle.a: says ready, then serves', () => {});",
        'it(',
        `  "lifecycle.b: a title that wrapped, and that's quoted",`,
        '  () => {},',
        ');',
        "it.each<[string, string]>([['a', ')']])('turns.d: %s', () => {});",
        "it('lifecycle.g: a body and a timeout', () => {}, 120_000);",
        'it.each`',
        '  a',
        '  ${1}',
        "`('turns.d: a tagged table, $a', () => {});",
        "test.skip('turns.d: skipped for now', () => {});",
      ],
      'tests/conformance/other.test.ts': [
        "import {it} from './helpers.ts';",
        "it('lifecycle.a: a call to another it is no test', () => {});",
      ],
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'conformance-inventory: 6 test(s) name rows of ' +
        'tests/conformance/inventory.csv; conformance rows done/todo by ' +
        'area: lifecycle 2/1, turns 0/1.\n',
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
        row('lifecycle.f', 'conformance', 'todo').replace('A statement.', ''),
        row('', 'conformance', 'todo'),
        row('turns.f', 'retired', 'todo'),
        row('turns.g', 'conformance', 'done'),
        row('turns.h', 'conformance', 'done'),
      ],
      'tests/conformance/turns.test.ts': [
        "import {describe, it, test} from 'vitest';",
        "import {it as check} from 'vitest';",
        "import * as v from 'vitest';",
        'it(`lifecycle.c: a template literal`, () => {});',
        'it(title, () => {});',
        "it('lifecycle.c: ' + 'joined', () => {});",
        "it('no row id here', () => {});",
        "it('lifecycle.z: names no row', () => {});",
        "it('turns.f: names a retired row', () => {});",
        "it.skip('turns.g: parked, so no proof', () => {});",
        "it.fails('turns.h: passes by failing, so no proof', () => {});",
        "// it('lifecycle.z: a test in a comment is no test', () => {});",
        "const text = `it('lifecycle.z: a test in a string is no test', () => {});`;",
        "describe.skip('a block that parks every test under it', () => {});",
        'describe.skip.each`',
        '  a',
        '  ${1}',
        "`('a tagged block parks them too', () => {});",
        "it.each([])('turns.g: an empty table runs no case', () => {});",
        "it('turns.g: parked by its options', {skip: true}, () => {});",
        "it('turns.g: a test with no body is todo');",
        'const options = {skip: true};',
        "it('turns.g: parked behind a variable', options, () => {});",
        "it('turns.g: parked behind a spread', {...options}, () => {});",
        'const cases: never[] = [];',
        "it.each(cases)('turns.g: a table behind a variable', () => {});",
        "it.each([...cases])('turns.g: a table spread in', () => {});",
        'if (false) {',
        "  it('turns.i: below the top level', () => {});",
        '}',
        "it('lifecycle.c: one test of the row', () => {});",
        "it('lifecycle.c: a second test of the row', () => {});",
        "it.runIf(false)('turns.g: a test on a condition proves nothing', () => {});",
        'it.each`',
        '  a',
        "`('turns.h: a header alone runs no case', () => {});",
        "it('turns.g: two arguments, the second a name', options);",
      ],
    });

    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n')).toEqual([
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.c is the id of two rows.',
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.d has status "finished", which is none of todo, done.',
      'conformance-inventory: tests/conformance/inventory.csv: the row starting "lifecycle.e" has 3 field(s), not 11.',
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.f has no statement.',
      'conformance-inventory: tests/conformance/inventory.csv: a row has no id: ",,A statement.,WIRE,-,none,yes,,conformance,0,todo".',
      "conformance-inventory: tests/conformance/turns.test.ts:2: vitest's it is imported under another name, which the index cannot follow.",
      'conformance-inventory: tests/conformance/turns.test.ts:3: vitest is imported as a namespace, which the index cannot follow.',
      'conformance-inventory: tests/conformance/turns.test.ts:4: the title is not a plain string literal.',
      'conformance-inventory: tests/conformance/turns.test.ts:5: the title is not a plain string literal.',
      'conformance-inventory: tests/conformance/turns.test.ts:6: the title is not a plain string literal.',
      'conformance-inventory: tests/conformance/turns.test.ts:7: the title "no row id here" is not "<row id>: <sentence>".',
      'conformance-inventory: tests/conformance/turns.test.ts:8: lifecycle.z is not a conformance row of tests/conformance/inventory.csv.',
      'conformance-inventory: tests/conformance/turns.test.ts:9: turns.f is not a conformance row of tests/conformance/inventory.csv.',
      'conformance-inventory: tests/conformance/turns.test.ts:29: a test below the top level; the suite is flat.',
      'conformance-inventory: tests/conformance/turns.test.ts:32: a second test of lifecycle.c; one behavior, one test.',
      'conformance-inventory: tests/conformance/turns.test.ts:14: a describe block; the suite is flat, so no block above a test can park it.',
      'conformance-inventory: tests/conformance/turns.test.ts:15: a describe block; the suite is flat, so no block above a test can park it.',
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.a is done, but no test in tests/conformance names it.',
      'conformance-inventory: tests/conformance/inventory.csv: lifecycle.b is done, but its test_location is rust-unit, not conformance.',
      'conformance-inventory: tests/conformance/inventory.csv: turns.g is done, but every test naming it in tests/conformance is skipped, runs no case or expects to fail.',
      'conformance-inventory: tests/conformance/inventory.csv: turns.h is done, but every test naming it in tests/conformance is skipped, runs no case or expects to fail.',
      '',
    ]);
    expect(result.status).toBe(1);
  });

  it('reads no row of an inventory with a quote inside an unquoted field', () => {
    const result = check({
      'tests/conformance/inventory.csv': [
        header,
        row('lifecycle.a', 'conformance', 'todo').replace('todo', 'to"do"'),
      ],
    });

    expect(result.stderr).toBe(
      'conformance-inventory: tests/conformance/inventory.csv:2: a quote inside an unquoted field.\n',
    );
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
