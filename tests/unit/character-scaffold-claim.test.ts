import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import type * as NodeFileSystem from 'node:fs';

const staleScan = vi.hoisted(() => ({
  hiddenEntryName: undefined as string | undefined,
}));

// Two runs of `pnpm character:new` overlapping is not something a
// sequential test can arrange, so the interleaving is expressed at the
// step that observes it: a directory listing taken before a concurrent
// run stamped its package. Everything else is the real filesystem, and
// the scaffold is given no hint that the listing is stale — which is
// exactly the position it is in when the race is real.
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof NodeFileSystem>();

  return {
    ...original,
    readdirSync: (path: string, options?: unknown) => {
      const entries = (
        original.readdirSync as (p: string, o?: unknown) => unknown[]
      )(path, options);

      return staleScan.hiddenEntryName === undefined
        ? entries
        : entries.filter(entry => {
            const name =
              typeof entry === 'string'
                ? entry
                : (entry as {readonly name: string}).name;

            return name !== staleScan.hiddenEntryName;
          });
    },
  };
});

const {scaffoldCharacterPackage} =
  await import('../../scripts/create-character.mjs');

describe('character package scaffold claiming a directory', () => {
  it('refuses a package a concurrent run stamped after the scan', () => {
    const packagesRoot = mkdtempSync(join(tmpdir(), 'project02-char-race-'));
    const packageRoot = join(packagesRoot, 'test.race-char');
    const descriptorPath = join(packageRoot, 'project02.character.json');

    // The concurrent run: it got the directory and wrote its descriptor.
    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(descriptorPath, '{"stamped":"by the winner"}\n', 'utf8');

    // This run's listing predates that, so it believes the id is free.
    staleScan.hiddenEntryName = 'test.race-char';

    // Deciding from the stale listing and creating afterwards is what
    // loses the winner's descriptor: `mkdir` with `recursive: true`
    // reports success on a directory it did not create, so the write
    // lands on top. Claiming the directory exclusively is the one step
    // that cannot be raced, and it is what refuses here.
    expect(() =>
      scaffoldCharacterPackage({id: 'test.race-char', packagesRoot}),
    ).toThrow(`already exists: ${packageRoot}`);

    expect(JSON.parse(readFileSync(descriptorPath, 'utf8'))).toEqual({
      stamped: 'by the winner',
    });
  });
});
