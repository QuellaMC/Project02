import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {onTestFinished} from 'vitest';

/** A file's text, or a directory of more. */
type Tree = {readonly [name: string]: string | Tree};

/**
 * A home of the test's own, removed after it: empty for `serve --init` to
 * create, or seeded with the files the test names. Canonical, since a
 * daemon reports its home by its real path and macOS links the temp dir.
 */
export function createHome(seed: Tree = {}): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'project02-home-')));

  onTestFinished(() => {
    rmSync(home, {recursive: true, force: true});
  });
  plant(home, seed);

  return home;
}

function plant(directory: string, tree: Tree): void {
  mkdirSync(directory, {recursive: true});

  for (const [name, entry] of Object.entries(tree)) {
    if (typeof entry === 'string') {
      writeFileSync(join(directory, name), entry);
    } else {
      plant(join(directory, name), entry);
    }
  }
}

/**
 * The path's permissions, for a test that provokes a permission failure.
 * Permissions do not bind root, so such a test cannot run as root.
 */
export function chmod(path: string, mode: number): void {
  if (process.getuid?.() === 0) {
    throw new Error(
      'Permissions do not bind root: run the suite as another user.',
    );
  }

  chmodSync(path, mode);
}

/** A home's `config.json` holding these settings. */
export function configJson(document: object): string {
  return JSON.stringify({version: 'project02.config.v2', ...document});
}

/**
 * A character package's descriptor for this identity, with a one-line
 * persona at version 1.0.0; the parts given replace those whole.
 */
export function characterJson(
  id: string,
  displayName: string,
  descriptor: object = {},
): string {
  return JSON.stringify({
    format: 'project02.character.v1',
    identity: {id, displayName},
    persona: {system: [`You are ${displayName}.`]},
    meta: {version: '1.0.0'},
    ...descriptor,
  });
}

/** The records of one of a character's sessions, as its log holds them. */
export function sessionLog(
  home: string,
  characterId: string,
  sessionId: string,
): Record<string, unknown>[] {
  return readFileSync(
    join(
      home,
      'character-data',
      characterId,
      'sessions',
      sessionId,
      'raw-events.jsonl',
    ),
    'utf8',
  )
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/** Every entry under a directory, a file with its text and a directory as null, so a later look shows whether anything changed. */
export function snapshot(directory: string): Record<string, string | null> {
  return Object.fromEntries(
    readdirSync(directory, {recursive: true, withFileTypes: true}).map(
      entry => {
        const path = join(entry.parentPath, entry.name);

        return [path, entry.isDirectory() ? null : readFileSync(path, 'utf8')];
      },
    ),
  );
}

/** The records of this kind that a character's sessions logged, segment by segment. */
export function sessionRecords(
  home: string,
  characterId: string,
  kind: string,
): Record<string, unknown>[] {
  const sessions = join(home, 'character-data', characterId, 'sessions');

  return readdirSync(sessions)
    .sort((left, right) => left.localeCompare(right, 'en', {numeric: true}))
    .flatMap(session => sessionLog(home, characterId, session))
    .filter(record => record['kind'] === kind);
}
