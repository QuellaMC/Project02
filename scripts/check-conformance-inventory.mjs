// The inventory is the index of the suites that prove behavior: each test
// is titled `<row id>: <sentence>` after the row it proves, and a row is
// done only when a test of the suite for its test_location names it. In
// the TypeScript suites, which prove it from outside, a title must be a
// plain string literal, so a search for a row id finds its test; a file is
// read as TypeScript, so a test in a comment or a string is no test; and
// each suite is flat, so no block above a test can park it. The Rust suite
// is what `cargo test` builds of Cargo's default layout: each crate's
// library, binaries and integration tests where Cargo finds them unasked,
// with every file their modules bring in. There a test's title is the
// first `///` line above its attributes, only a test whose title has that
// shape names a row, `#[ignore]` or a `cfg` other than `cfg(test)` parks
// it, on the test or on any module around it, and only a module may
// enclose it; a file is read as Rust tokens, so there too a test in a
// comment or a string is no test. The check runs where cargo may not be
// installed, so it reads only Cargo's defaults and refuses a manifest key
// that sets where or whether a target's tests run.
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

import ts from 'typescript';

const INVENTORY_FILE = 'tests/conformance/inventory.csv';
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

// How a runner's test files read: the modules its roots come from; what a
// call is by the names along its callee, root first — a test, a block that
// could park every test under it, or neither; the modifiers and options
// under which a test proves nothing, since it never runs, passes by
// failing or runs on a condition; those that park every test of the file
// when they declare none; and how many parameters a body takes before its
// context.
const VITEST = {
  sources: ['vitest'],
  roots: new Set(['it', 'test', 'describe', 'suite']),
  kindOf: ([root]) =>
    root === 'describe' || root === 'suite' ? 'block' : 'test',
  parking: new Set(['skip', 'todo', 'fails', 'skipIf', 'runIf']),
  parkingFile: new Set(),
  contextAt: 0,
};
// The names after Playwright's test that declare one; `step`, `use` and the hooks do not.
const PLAYWRIGHT_DECLARATIONS = new Set(['only', 'skip', 'fixme', 'fail']);
const PLAYWRIGHT = {
  // Its own test, or the one the browser suite's fixture extends it to.
  sources: ['@playwright/test', './fixture.ts'],
  roots: new Set(['test']),
  kindOf: ([, member]) => {
    if (member === 'describe') {
      return 'block';
    }
    return member === undefined || PLAYWRIGHT_DECLARATIONS.has(member)
      ? 'test'
      : undefined;
  },
  // An annotation in a test's details may be any of the others.
  parking: new Set(['skip', 'fixme', 'fail', 'annotation']),
  parkingFile: new Set(['skip', 'fixme', 'fail']),
  // The fixtures come first.
  contextAt: 1,
};
// Each suite proves the rows of one test_location, and its files are read
// as its runner finds them.
const SUITES = [
  {
    directory: 'tests/conformance',
    location: 'conformance',
    scan: directory => scanTypeScriptSuite(directory, '.test.ts', VITEST),
  },
  {
    directory: 'tests/browser',
    location: 'client-ts',
    scan: directory => scanTypeScriptSuite(directory, '.spec.ts', PLAYWRIGHT),
  },
  {
    directory: 'crates',
    location: 'rust-unit',
    scan: scanRustSuite,
  },
];
// The modifiers applied with their own arguments before the titled call.
const MODIFIERS_WITH_ARGUMENTS = new Set(['each', 'for', 'skipIf', 'runIf']);
// Of those, the ones whose argument is a table of cases.
const TABLE_MODIFIERS = new Set(['each', 'for']);
/** An id as a title names it: no whitespace, no colon. */
const ID_CHARACTERS = '[^\\s:]+';
const ID_SHAPE = new RegExp(`^${ID_CHARACTERS}$`);
const TITLE_SHAPE = new RegExp(`^(${ID_CHARACTERS}): \\S`);

// RFC 4180: a quoted field may hold commas, line breaks and doubled quotes;
// a quote anywhere else, or text after a closing quote, is no CSV.
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let closed = false;
  let line = 1;
  const refuse = why => {
    throw new Error(`${INVENTORY_FILE}:${String(line)}: ${why}.`);
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '\n') {
      line += 1;
    }
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        closed = true;
      }
      continue;
    }
    if (
      closed &&
      character !== ',' &&
      character !== '\n' &&
      character !== '\r'
    ) {
      refuse('text after a closing quote');
    }
    closed = false;
    if (character === '"') {
      if (field !== '') {
        refuse('a quote inside an unquoted field');
      }
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

  if (quoted) {
    refuse('a quoted field that never closes');
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

/** Whether the body takes its context, through which it could skip itself under any name: the runner's own parameters and a table's case come first, and `.each` hands nothing else. */
function takesContext(call, modifiers, contextAt) {
  const body = call.arguments.find(
    argument =>
      ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
  );

  if (body === undefined || modifiers.includes('each')) {
    return false;
  }

  // A rest parameter takes whatever follows the case, the context included.
  return (
    body.parameters.length > contextAt + (modifiers.includes('for') ? 1 : 0) ||
    body.parameters.some(parameter => parameter.dotDotDotToken !== undefined)
  );
}

/** Whether the test has no body to run: Vitest takes such a test as todo, and Playwright refuses it. */
function bodiless(call) {
  return !call.arguments.some(isFunction);
}

/**
 * The options a test was given, Playwright's details among them, read as
 * Vitest reads them: after a body, an object literal third (a number there
 * is a timeout); before one, the second argument, which a name also may be
 * when nothing follows it or a body does.
 */
function optionsOf(call) {
  const [, second, third] = call.arguments;

  if (second === undefined) {
    return undefined;
  }
  if (ts.isArrowFunction(second) || ts.isFunctionExpression(second)) {
    return third !== undefined && ts.isObjectLiteralExpression(third)
      ? third
      : undefined;
  }
  if (ts.isIdentifier(second)) {
    if (third === undefined || isFunction(third)) {
      return second;
    }
    return ts.isObjectLiteralExpression(third) ? third : undefined;
  }
  return second;
}

/** Whether the test's options park it: a parking name set to anything but false, or options the checker cannot read. */
function parkedByOptions(options, parking) {
  if (options === undefined) {
    return false;
  }
  if (!ts.isObjectLiteralExpression(options)) {
    return true;
  }
  return options.properties.some(property => {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      return (
        parking.has(property.name.text) &&
        property.initializer.kind !== ts.SyntaxKind.FalseKeyword
      );
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return parking.has(property.name.text);
    }
    // A spread, a computed name or a method: what it sets cannot be read.
    return true;
  });
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
        table.elements.length === 0 ||
        table.elements.some(ts.isSpreadElement))
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

/** Each titled test call, with its title when that is a plain string literal, and each construct the index refuses, by line: a block, and the runner's names imported as a namespace or under another name. */
function scanTypeScript(file, source, runner) {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tests = [];
  const refusals = [];
  const imported = new Set();
  const visit = node => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      runner.sources.includes(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings !== undefined
    ) {
      const source = node.moduleSpecifier.text;
      const bindings = node.importClause.namedBindings;

      if (ts.isNamespaceImport(bindings)) {
        refusals.push({
          line:
            tree.getLineAndCharacterOfPosition(bindings.getStart(tree)).line +
            1,
          why:
            `${source} is imported as a namespace, which the index ` +
            'cannot follow.',
        });
      }

      for (const binding of ts.isNamedImports(bindings)
        ? bindings.elements
        : []) {
        if (
          binding.propertyName === undefined &&
          runner.roots.has(binding.name.text)
        ) {
          imported.add(binding.name.text);
        }
        if (
          binding.propertyName !== undefined &&
          runner.roots.has(binding.propertyName.text)
        ) {
          refusals.push({
            line:
              tree.getLineAndCharacterOfPosition(binding.getStart(tree)).line +
              1,
            why:
              `${source}'s ${binding.propertyName.text} is imported under ` +
              'another name, which the index cannot follow.',
          });
        }
      }
    }
    if (ts.isCallExpression(node) && titled(node)) {
      const names = calleeNames(node.expression) ?? [];
      const [root = '', ...modifiers] = names;

      if (!imported.has(root)) {
        ts.forEachChild(node, visit);
        return;
      }
      const line =
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      const [title] = node.arguments;
      const kind = runner.kindOf(names);
      const nested = !(
        ts.isExpressionStatement(node.parent) &&
        ts.isSourceFile(node.parent.parent)
      );

      if (kind === 'block') {
        refusals.push({
          line,
          why:
            'a describe block; the suite is flat, so no block above a ' +
            'test can park it.',
        });
      } else if (kind === 'test') {
        tests.push({
          line,
          nested,
          parked:
            modifiers.some(name => runner.parking.has(name)) ||
            parkedByOptions(optionsOf(node), runner.parking) ||
            bodiless(node) ||
            takesContext(node, modifiers, runner.contextAt) ||
            runsNoCase(node),
          parksFile:
            !nested &&
            bodiless(node) &&
            modifiers.some(name => runner.parkingFile.has(name)),
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

  const fileParked = tests.some(test => test.parksFile);

  return {
    tests: tests.map(test => ({...test, parked: test.parked || fileParked})),
    refusals,
  };
}

/** Each file of a TypeScript suite, scanned: every one under its directory with the suite's extension. */
function scanTypeScriptSuite(directory, extension, runner) {
  return readdirSync(directory, {recursive: true})
    .filter(path => path.endsWith(extension))
    .sort()
    .map(path => {
      const file = join(directory, path);

      return {
        file,
        ...scanTypeScript(file, readFileSync(file, 'utf8'), runner),
      };
    });
}

/** What a test attribute's path ends in: `test`, or `tokio::test` and its kin. */
const RUST_TEST_ATTRIBUTE = /(?:^|::)test$/;
// The words that may stand between an item's attributes and its `fn`.
const RUST_QUALIFIERS = new Set([
  'pub',
  'crate',
  'super',
  'self',
  'in',
  'async',
  'const',
  'unsafe',
  'extern',
]);

// Rust's lexemes, matched where the scan stands. A character literal is
// tried before a lifetime: `'a'` is a character, `'a` a lifetime.
const RUST_SPACE = /\s+/y;
const RUST_LINE_COMMENT = /\/\/[^\n]*/y;
const RUST_STRING = /[bc]?(?:r(#*))?"/y;
const RUST_CHARACTER =
  /b?'(?:\\(?:u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{2}|[^\n])|[^\\'\n])'/uy;
const RUST_LIFETIME = /'[A-Za-z_][A-Za-z0-9_]*/y;
const RUST_WORD = /[A-Za-z_][A-Za-z0-9_]*|[0-9][A-Za-z0-9_]*/y;

/**
 * The tokens of a Rust file that can tell a test: words, punctuation, and
 * the text of each `///` line. Comments, strings, characters and lifetimes
 * are read past, so nothing inside them is a token.
 */
function rustTokens(source) {
  const tokens = [];
  let line = 1;
  let at = 0;
  const lexeme = pattern => {
    pattern.lastIndex = at;
    return pattern.exec(source);
  };
  const moveTo = end => {
    for (; at < end; at += 1) {
      if (source[at] === '\n') {
        line += 1;
      }
    }
  };

  while (at < source.length) {
    const comment = lexeme(RUST_LINE_COMMENT);
    const string = comment === null ? lexeme(RUST_STRING) : null;

    if (lexeme(RUST_SPACE) !== null) {
      moveTo(RUST_SPACE.lastIndex);
    } else if (comment !== null) {
      if (comment[0].startsWith('///') && !comment[0].startsWith('////')) {
        tokens.push({kind: 'doc', text: comment[0].slice(3).trim(), line});
      }
      moveTo(RUST_LINE_COMMENT.lastIndex);
    } else if (source.startsWith('/*', at)) {
      let depth = 0;
      let end = at;

      do {
        if (source.startsWith('/*', end)) {
          depth += 1;
          end += 2;
        } else if (source.startsWith('*/', end)) {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      } while (depth > 0 && end < source.length);
      moveTo(end);
    } else if (string !== null) {
      const hashes = string[1];
      let end = RUST_STRING.lastIndex;

      if (hashes === undefined) {
        while (end < source.length && source[end] !== '"') {
          end += source[end] === '\\' ? 2 : 1;
        }
        end += 1;
      } else {
        const close = source.indexOf(`"${hashes}`, end);

        end = close === -1 ? source.length : close + 1 + hashes.length;
      }
      moveTo(end);
    } else if (lexeme(RUST_CHARACTER) !== null) {
      moveTo(RUST_CHARACTER.lastIndex);
    } else if (lexeme(RUST_LIFETIME) !== null) {
      moveTo(RUST_LIFETIME.lastIndex);
    } else {
      const word = lexeme(RUST_WORD);
      const text = word?.[0] ?? source[at];

      tokens.push({kind: word === null ? 'punct' : 'word', text, line});
      moveTo(at + text.length);
    }
  }
  return tokens;
}

/** The index of the token that closes the bracket at `open`. */
function closingBracket(tokens, open) {
  let depth = 0;

  for (let at = open; at < tokens.length; at += 1) {
    const {kind, text} = tokens[at];

    if (kind === 'punct' && '([{'.includes(text)) {
      depth += 1;
    } else if (kind === 'punct' && ')]}'.includes(text)) {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
  }
  return tokens.length;
}

/** Whether an attribute parks what it is on and every test inside it: `#[ignore]`, or a `cfg` or `cfg_attr` the index cannot evaluate, which is any but `cfg(test)`, the one `cargo test` always sets. */
function parks({path, text}) {
  return (
    path === 'ignore' ||
    path === 'cfg_attr' ||
    (path === 'cfg' && text !== 'cfg(test)')
  );
}

/**
 * Each test of a Rust file that names a row, and each module the file
 * declares out of line. A test is a function carrying a `#[test]`-family
 * attribute, with or without arguments, whose first `///` line above its
 * attributes is a title. It is parked by an attribute on it or on any
 * module around it, the file's own inner attributes included, and when the
 * file arrives `parked`. Only a module may enclose it: the harness never
 * runs a test inside another item.
 */
function scanRust(source, parked) {
  const tokens = rustTokens(source);
  const tests = [];
  const modules = [];
  // The file itself, then each block open where the scan stands: whether
  // it is a module, the names of the modules down to it, and whether it is
  // parked.
  const top = {module: true, names: [], parked};
  const blocks = [];
  let docs = [];
  let attributes = [];
  // The module a `mod` item declares, until its `{` or its `;`.
  let declared;

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    const next = tokens[at + 1]?.text;
    const block = blocks.at(-1) ?? top;

    if (token.kind === 'doc') {
      docs.push(token.text);
      continue;
    }
    if (token.text === '#' && (next === '[' || next === '!')) {
      const open = next === '!' ? at + 2 : at + 1;
      const close = closingBracket(tokens, open);
      const inside = tokens.slice(open + 1, close);
      const path = [];

      for (const {kind, text} of inside) {
        if (kind !== 'word' && text !== ':') {
          break;
        }
        path.push(text);
      }

      const attribute = {
        path: path.join(''),
        text: inside.map(({text}) => text).join(''),
      };

      // An inner attribute belongs to the block it stands in, not to the
      // next item.
      if (next === '!') {
        block.parked ||= parks(attribute);
        docs = [];
        attributes = [];
      } else {
        attributes.push(attribute);
      }
      at = close;
      continue;
    }
    if (token.text === '{') {
      blocks.push(declared ?? {...block, module: false});
      declared = undefined;
      continue;
    }
    if (token.text === '}') {
      blocks.pop();
      continue;
    }
    if (token.text === ';') {
      if (declared !== undefined) {
        modules.push(declared);
      }
      declared = undefined;
    }

    let item = at;

    while (
      tokens[item] !== undefined &&
      (RUST_QUALIFIERS.has(tokens[item].text) ||
        tokens[item].text === '(' ||
        tokens[item].text === ')')
    ) {
      item += 1;
    }

    const head = tokens[item]?.text;
    const [title] = docs;
    const nested = blocks.some(({module}) => !module);
    const itemParked = block.parked || attributes.some(parks);

    if (head === 'mod' && !nested) {
      declared = {
        module: true,
        names: [...block.names, tokens[item + 1]?.text],
        parked: itemParked,
      };
    } else if (
      head === 'fn' &&
      attributes.some(({path}) => RUST_TEST_ATTRIBUTE.test(path)) &&
      title !== undefined &&
      TITLE_SHAPE.test(title)
    ) {
      tests.push({line: tokens[item].line, nested, parked: itemParked, title});
    }
    docs = [];
    attributes = [];
    // A brace the qualifiers led to is read as the brace it is.
    at = head === '{' || head === '}' ? item - 1 : item;
  }
  return {tests, modules, refusals: []};
}

// The manifest keys that set where a target's root is or whether
// `cargo test` runs its tests, each dotted from the manifest's top.
const RUST_TARGET_KEYS = new Set([
  'package.autolib',
  'package.autobins',
  'package.autotests',
  ...['lib', 'bin', 'test'].flatMap(target =>
    ['path', 'test', 'harness', 'required-features'].map(
      key => `${target}.${key}`,
    ),
  ),
]);
// A manifest as Cargo's reference writes one: a line opens with a table's
// header or with a bare key, dotted or not.
const TOML_TABLE = /^\s*\[\[?([^\]]*)\]/;
const TOML_KEY = /^\s*([\w-]+(?:\s*\.\s*[\w-]+)*)\s*=/;

/** Each line of a crate's manifest that sets one of the target keys, refused. */
function manifestRefusals(manifest) {
  const refusals = [];
  let table = '';

  for (const [at, text] of manifest.split('\n').entries()) {
    const header = TOML_TABLE.exec(text);
    const key = TOML_KEY.exec(text);

    if (header !== null) {
      table = `${header[1].replace(/\s/g, '')}.`;
    } else if (key !== null) {
      const path = table + key[1].replace(/\s/g, '');

      if (RUST_TARGET_KEYS.has(path)) {
        refusals.push({
          line: at + 1,
          why:
            `${path} sets where or whether a target's tests run; the ` +
            "index reads only Cargo's defaults.",
        });
      }
    }
  }
  return refusals;
}

/** The files a crate's test targets start from, as Cargo finds them unasked: its library, its binaries and its integration tests. */
function rustRoots(crate) {
  const targets = directory =>
    existsSync(directory)
      ? readdirSync(directory, {withFileTypes: true})
          .map(entry =>
            entry.isDirectory()
              ? join(directory, entry.name, 'main.rs')
              : join(directory, entry.name),
          )
          .filter(path => path.endsWith('.rs'))
      : [];

  return [
    join(crate, 'src', 'lib.rs'),
    join(crate, 'src', 'main.rs'),
    ...targets(join(crate, 'src', 'bin')),
    ...targets(join(crate, 'tests')),
  ];
}

/**
 * Each file of the Rust suite as `cargo test` builds it, scanned: each
 * crate's manifest, for the keys the index refuses, its roots, and every
 * file a module declared out of line brings in, found where Rust looks for
 * it by default, beside a root or a `mod.rs` and in the directory named
 * after any other file. A file arrives parked when the module that brings
 * it in is.
 */
function scanRustSuite(directory) {
  const scanned = new Map();
  const visit = (file, ownsDirectory, parked) => {
    if (scanned.has(file) || !existsSync(file)) {
      return;
    }

    const found = scanRust(readFileSync(file, 'utf8'), parked);
    const base = ownsDirectory
      ? dirname(file)
      : join(dirname(file), basename(file, '.rs'));

    scanned.set(file, found);
    for (const module of found.modules) {
      visit(`${join(base, ...module.names)}.rs`, false, module.parked);
      visit(join(base, ...module.names, 'mod.rs'), true, module.parked);
    }
  };

  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      const crate = join(directory, entry.name);
      const manifest = join(crate, 'Cargo.toml');

      if (existsSync(manifest)) {
        scanned.set(manifest, {
          tests: [],
          modules: [],
          refusals: manifestRefusals(readFileSync(manifest, 'utf8')),
        });
      }
      for (const root of rustRoots(crate)) {
        visit(root, true, false);
      }
    }
  }
  return [...scanned.keys()].sort().map(file => ({file, ...scanned.get(file)}));
}

function reportFailures(failures) {
  for (const failure of failures) {
    process.stderr.write(`conformance-inventory: ${failure}\n`);
  }
  process.exitCode = 1;
}

function main() {
  let parsed;

  try {
    parsed = parseCsv(readFileSync(INVENTORY_FILE, 'utf8'));
  } catch (error) {
    reportFailures([error instanceof Error ? error.message : String(error)]);
    return;
  }

  const [header = [], ...records] = parsed;

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

    if (row.id === '') {
      failures.push(
        `${INVENTORY_FILE}: a row has no id: "${record.join(',')}".`,
      );
    } else if (!ID_SHAPE.test(row.id)) {
      failures.push(
        `${INVENTORY_FILE}: "${row.id}" is an id no title could name.`,
      );
    } else if (row.statement === '') {
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

  // A suite whose directory is not there holds no test, so none of its rows is done.
  const testFiles = SUITES.flatMap(suite =>
    existsSync(suite.directory)
      ? suite.scan(suite.directory).map(scanned => ({suite, ...scanned}))
      : [],
  );
  const tested = new Set();
  const parkedRows = new Set();
  let tests = 0;

  for (const {suite, file, tests: calls, refusals} of testFiles) {
    for (const {line, why} of refusals) {
      failures.push(`${file}:${line}: ${why}`);
    }

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
      } else if (rows.get(id)?.test_location !== suite.location) {
        failures.push(
          `${file}:${line}: ${id} is not a ${suite.location} row of ` +
            `${INVENTORY_FILE}.`,
        );
      } else if (parked) {
        parkedRows.add(id);
      } else if (tested.has(id)) {
        failures.push(
          `${file}:${line}: a second test of ${id}; one behavior, one test.`,
        );
      } else {
        tested.add(id);
      }
    }
  }

  for (const row of rows.values()) {
    if (row.status !== 'done') {
      continue;
    }
    const suite = SUITES.find(({location}) => location === row.test_location);

    if (suite === undefined) {
      failures.push(
        `${INVENTORY_FILE}: ${row.id} is done, but its test_location is ` +
          `${row.test_location}, not ` +
          `${SUITES.map(({location}) => location).join(' or ')}.`,
      );
    } else if (!tested.has(row.id)) {
      failures.push(
        parkedRows.has(row.id)
          ? `${INVENTORY_FILE}: ${row.id} is done, but every test naming it ` +
              `in ${suite.directory} is skipped, runs no case or expects to fail.`
          : `${INVENTORY_FILE}: ${row.id} is done, but no test in ` +
              `${suite.directory} names it.`,
      );
    }
  }

  if (failures.length > 0) {
    reportFailures(failures);
    return;
  }

  const byArea = SUITES.map(({location}) => {
    const areas = new Map();

    for (const row of rows.values()) {
      if (row.test_location === location) {
        const counts = areas.get(row.area) ?? {done: 0, todo: 0};

        counts[row.status] += 1;
        areas.set(row.area, counts);
      }
    }
    return (
      `${location} rows done/todo by area: ` +
      [...areas]
        .map(([area, {done, todo}]) => `${area} ${done}/${todo}`)
        .join(', ')
    );
  });

  process.stdout.write(
    `conformance-inventory: ${tests} test(s) name rows of ` +
      `${INVENTORY_FILE}; ${byArea.join('; ')}.\n`,
  );
}

main();
