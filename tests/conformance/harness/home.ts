import {
  mkdirSync,
  mkdtempSync,
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
