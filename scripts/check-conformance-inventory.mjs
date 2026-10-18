// The inventory is the conformance suite's index: each test is titled
// `<row id>: <sentence>` after the row it proves, and a row is done only
// when a test names it. A title must be a plain string literal, so a
// search for a row id finds its test.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

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

// `it` or `test` at the start of a line, with any modifiers and type
// arguments.
const TEST_CALL = /^[ \t]*(?:it|test)((?:\.\w+)*)(?:<[^\n]*?>)?\(/gm;
// The modifiers that take an argument list before the one with the title.
const ARGUMENTS_BEFORE_TITLE = /\.(?:each|for|skipIf|runIf)\b/;
// The modifiers under which a test proves nothing: it never runs, or it passes by failing.
const PROVES_NOTHING = /\.(?:skip|todo|fails)\b/;
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

function skipSpace(source, index) {
  const space = /\s*/y;

  space.lastIndex = index;
  space.exec(source);
  return space.lastIndex;
}

function pastString(source, index) {
  let end = index + 1;

  while (end < source.length && source[end] !== source[index]) {
    end += source[end] === '\\' ? 2 : 1;
  }
  return end + 1;
}

function pastArguments(source, index) {
  let depth = 1;
  let end = index;

  while (depth > 0 && end < source.length) {
    const character = source[end];

    if (["'", '"', '`'].includes(character)) {
      end = pastString(source, end);
      continue;
    }
    if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    }
    end += 1;
  }
  return end;
}

/** Each test's line, and its title when that is a plain string literal. */
function testCalls(source) {
  return [...source.matchAll(TEST_CALL)].map(match => {
    let start = skipSpace(source, match.index + match[0].length);

    if (ARGUMENTS_BEFORE_TITLE.test(match[1])) {
      const next = skipSpace(source, pastArguments(source, start));

      start =
        source[next] === '(' ? skipSpace(source, next + 1) : source.length;
    }

    const quote = source[start];
    const end =
      quote === "'" || quote === '"' ? pastString(source, start) : start;
    const closed = /\s*[,)]/y;

    closed.lastIndex = end;
    return {
      line: source.slice(0, match.index).split('\n').length,
      disabled: PROVES_NOTHING.test(match[1]),
      title:
        end > start && closed.test(source)
          ? source.slice(start + 1, end - 1)
          : undefined,
    };
  });
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
  const parked = new Set();
  let tests = 0;

  for (const file of testFiles) {
    for (const {line, disabled, title} of testCalls(
      readFileSync(file, 'utf8'),
    )) {
      const id = title?.match(TITLE_SHAPE)?.[1];

      tests += 1;
      if (title === undefined) {
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
      } else if (disabled) {
        parked.add(id);
      } else {
        tested.add(id);
      }
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
        parked.has(row.id)
          ? `${INVENTORY_FILE}: ${row.id} is done, but every test naming it ` +
              `in ${SUITE_DIRECTORY} is skipped or expects to fail.`
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
