import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import type * as NodeFileSystem from 'node:fs';

const staleScan = vi.hoisted(() => ({
  hiddenEntryName: undefined as string | undefined,
}));

// Two overlapping scaffold runs are expressed at the step that observes them:
// a directory listing taken before the concurrent run stamped its package.
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

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(descriptorPath, '{"stamped":"by the winner"}\n', 'utf8');

    staleScan.hiddenEntryName = 'test.race-char';

    // `mkdir` with `recursive: true` reports success on a directory it did not
    // create, so only an exclusive claim refuses here.
    expect(() =>
      scaffoldCharacterPackage({id: 'test.race-char', packagesRoot}),
    ).toThrow(`already exists: ${packageRoot}`);

    expect(JSON.parse(readFileSync(descriptorPath, 'utf8'))).toEqual({
      stamped: 'by the winner',
    });
  });
});
