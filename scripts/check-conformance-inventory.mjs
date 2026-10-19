// The inventory is the conformance suite's index: each test is titled
// `<row id>: <sentence>` after the row it proves, and a row is done only
// when a test names it. A title must be a plain string literal, so a
// search for a row id finds its test; a file is read as TypeScript, so a
// test in a comment or a string is no test; and the suite is flat, so no
// block above a test can park it.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import ts from 'typescript';

const SUITE_DIRECTORY = 'tests/conformance';
const INVENTORY_FILE = `${SUITE_DIRECTORY}/inventory.csv`;
const COLUMNS = [
  'id',
  'area',
  'statement',
  'boundary',
  'source_tests',
  'coverage_today',
  'blackbox',
  'notes',
  'test_location',
  'stage',
  'status',
];
const COLUMN_VALUES = {
  test_location: ['conformance', 'rust-unit', 'client-ts', 'retired'],
  stage: ['0', '2'],
  status: ['todo', 'done'],
};

// What a call's root name opens: a test, or a block that could park every test under it.
const ROOTS = new Map([
  ['it', 'test'],
  ['test', 'test'],
  ['describe', 'block'],
  ['suite', 'block'],
]);
// The modifiers applied with their own arguments before the titled call.
const MODIFIERS_WITH_ARGUMENTS = new Set(['each', 'for', 'skipIf', 'runIf']);
// Of those, the ones whose argument is a table of cases.
const TABLE_MODIFIERS = new Set(['each', 'for']);
// The modifiers under which a test proves nothing: it never runs, or it passes by failing.
const PARKING_MODIFIERS = new Set(['skip', 'todo', 'fails']);
const TITLE_SHAPE = /^([^\s:]+): \S/;

// RFC 4180: a quoted field may hold commas, line breaks and doubled quotes.
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n') {
      records.push([...record, field]);
      record = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  if (field !== '' || record.length > 0) {
    records.push([...record, field]);
  }
  return records;
}

/** The names along a callee such as `it.skip`, `it.each([...])` or `it.each\`...\``, root first. */
function calleeNames(expression) {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const names = calleeNames(expression.expression);

    return names === undefined ? undefined : [...names, expression.name.text];
  }
  if (ts.isCallExpression(expression)) {
    return calleeNames(expression.expression);
  }
  if (ts.isTaggedTemplateExpression(expression)) {
    return calleeNames(expression.tag);
  }
  return undefined;
}

/** Whether the call carries the title, rather than being the `.each([...])` or `.skipIf(cond)` applied before it. */
function titled(call) {
  if (
    ts.isCallExpression(call.expression) ||
    ts.isTaggedTemplateExpression(call.expression)
  ) {
    return true;
  }
  return !MODIFIERS_WITH_ARGUMENTS.has(calleeNames(call.expression)?.at(-1));
}

function isFunction(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isIdentifier(node)
  );
}

/** Whether the test has no body to run: Vitest takes such a test as todo. */
function bodiless(call) {
  return !call.arguments.some(isFunction);
}

/** The options a test was given: its second argument when a third follows, or an object literal there. */
function optionsOf(call) {
  const [, second, third] = call.arguments;

  return third !== undefined ||
    (second !== undefined && ts.isObjectLiteralExpression(second))
    ? second
    : undefined;
}

/** Whether the test's options park it: skip, todo or fails set to anything but false, or options the checker cannot read. */
function parkedByOptions(options) {
  if (options === undefined) {
    return false;
  }
  return (
    !ts.isObjectLiteralExpression(options) ||
    options.properties.some(
      property =>
        (ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          PARKING_MODIFIERS.has(property.name.text) &&
          property.initializer.kind !== ts.SyntaxKind.FalseKeyword) ||
        (ts.isShorthandPropertyAssignment(property) &&
          PARKING_MODIFIERS.has(property.name.text)),
    )
  );
}

/** Whether the call's table of cases, if it has one, holds none: then nothing runs. */
function runsNoCase(call) {
  const applied = call.expression;

  if (ts.isCallExpression(applied)) {
    const [table] = applied.arguments;

    return (
      TABLE_MODIFIERS.has(calleeNames(applied)?.at(-1)) &&
      (table === undefined ||
        !ts.isArrayLiteralExpression(table) ||
        table.elements.length === 0)
    );
  }
  if (ts.isTaggedTemplateExpression(applied)) {
    const {template} = applied;
    const text = ts.isTemplateExpression(template)
      ? template.head.text +
        template.templateSpans.map(span => `${span.literal.text}`).join('')
      : template.text;

    // The first non-empty line is the header.
    return text.split('\n').filter(line => line.trim() !== '').length < 2;
  }
  return false;
}

/** Each titled test call, with its title when that is a plain string literal, and each block, by line. */
function scan(file, source) {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tests = [];
  const blocks = [];
  const visit = node => {
    if (ts.isCallExpression(node) && titled(node)) {
      const [root = '', ...modifiers] = calleeNames(node.expression) ?? [];
      const line =
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      const [title] = node.arguments;

      if (ROOTS.get(root) === 'block') {
        blocks.push(line);
      } else if (ROOTS.get(root) === 'test') {
        tests.push({
          line,
          nested: !(
            ts.isExpressionStatement(node.parent) &&
            ts.isSourceFile(node.parent.parent)
          ),
          parked:
            modifiers.some(name => PARKING_MODIFIERS.has(name)) ||
            parkedByOptions(optionsOf(node)) ||
            bodiless(node) ||
            runsNoCase(node),
          title:
            title !== undefined && ts.isStringLiteral(title)
              ? title.text
              : undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(tree);
  return {tests, blocks};
}

function reportFailures(failures) {
  for (const failure of failures) {
    process.stderr.write(`conformance-inventory: ${failure}\n`);
  }
  process.exitCode = 1;
}

function main() {
  const [header = [], ...records] = parseCsv(
    readFileSync(INVENTORY_FILE, 'utf8'),
  );

  if (header.join(',') !== COLUMNS.join(',')) {
    reportFailures([
      `${INVENTORY_FILE} must open with the header ${COLUMNS.join(',')}.`,
    ]);
    return;
  }

  const failures = [];
  const rows = new Map();

  for (const record of records) {
    if (record.length !== COLUMNS.length) {
      failures.push(
        `${INVENTORY_FILE}: the row starting "${record[0]}" has ` +
          `${record.length} field(s), not ${COLUMNS.length}.`,
      );
      continue;
    }

    const row = Object.fromEntries(
      COLUMNS.map((column, index) => [column, record[index]]),
    );

    if (rows.has(row.id)) {
      failures.push(`${INVENTORY_FILE}: ${row.id} is the id of two rows.`);
    }
    rows.set(row.id, row);

    if (row.statement === '') {
      failures.push(`${INVENTORY_FILE}: ${row.id} has no statement.`);
    }

    for (const [column, values] of Object.entries(COLUMN_VALUES)) {
      if (!values.includes(row[column])) {
        failures.push(
          `${INVENTORY_FILE}: ${row.id} has ${column} "${row[column]}", ` +
            `which is none of ${values.join(', ')}.`,
        );
      }
    }
  }

  const testFiles = readdirSync(SUITE_DIRECTORY, {recursive: true})
    .filter(path => path.endsWith('.test.ts'))
    .sort()
    .map(path => join(SUITE_DIRECTORY, path));
  const tested = new Set();
  const parkedRows = new Set();
  let tests = 0;

  for (const file of testFiles) {
    const {tests: calls, blocks} = scan(file, readFileSync(file, 'utf8'));

    for (const {line, nested, parked, title} of calls) {
      const id = title?.match(TITLE_SHAPE)?.[1];

      tests += 1;
      if (nested) {
        failures.push(
          `${file}:${line}: a test below the top level; the suite is flat.`,
        );
      } else if (title === undefined) {
        failures.push(
          `${file}:${line}: the title is not a plain string literal.`,
        );
      } else if (id === undefined) {
        failures.push(
          `${file}:${line}: the title "${title}" is not ` +
            '"<row id>: <sentence>".',
        );
      } else if (rows.get(id)?.test_location !== 'conformance') {
        failures.push(
          `${file}:${line}: ${id} is not a conformance row of ` +
            `${INVENTORY_FILE}.`,
        );
      } else if (parked) {
        parkedRows.add(id);
      } else {
        tested.add(id);
      }
    }
    for (const line of blocks) {
      failures.push(
        `${file}:${line}: a describe block; the ` +
          'suite is flat, so no block above a test can park it.',
      );
    }
  }

  for (const row of rows.values()) {
    if (row.status !== 'done') {
      continue;
    }
    if (row.test_location !== 'conformance') {
      failures.push(
        `${INVENTORY_FILE}: ${row.id} is done, but its test_location is ` +
          `${row.test_location}, not conformance.`,
      );
    } else if (!tested.has(row.id)) {
      failures.push(
        parkedRows.has(row.id)
          ? `${INVENTORY_FILE}: ${row.id} is done, but every test naming it ` +
              `in ${SUITE_DIRECTORY} is skipped, runs no case or expects to fail.`
          : `${INVENTORY_FILE}: ${row.id} is done, but no test in ` +
              `${SUITE_DIRECTORY} names it.`,
      );
    }
  }

  if (failures.length > 0) {
    reportFailures(failures);
    return;
  }

  const areas = new Map();

  for (const row of rows.values()) {
    if (row.test_location === 'conformance') {
      const counts = areas.get(row.area) ?? {done: 0, todo: 0};

      counts[row.status] += 1;
      areas.set(row.area, counts);
    }
  }
  process.stdout.write(
    `conformance-inventory: ${tests} test(s) name rows of ` +
      `${INVENTORY_FILE}; conformance rows done/todo by area: ` +
      [...areas]
        .map(([area, {done, todo}]) => `${area} ${done}/${todo}`)
        .join(', ') +
      '.\n',
  );
}

main();
