import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  atomicReplacementFileBelongsToTarget,
  atomicReplaceFileSync,
  parseAtomicReplacementFileName,
} from '../../src/runtime/storage/atomic-file.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async root => {
      await rm(root, {force: true, recursive: true});
    }),
  );
});

describe('atomic file replacement', () => {
  it('replaces the target durably with the requested mode', async () => {
    const root = await createTempRoot();
    const targetPath = join(root, 'config.json');
    await writeFile(targetPath, 'old\n', 'utf8');

    atomicReplaceFileSync({
      targetPath,
      content: 'new\n',
      mode: 0o600,
    });

    expect(await readFile(targetPath, 'utf8')).toBe('new\n');
    expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['config.json']);
  });

  it('removes its temporary file when replacement fails', async () => {
    const root = await createTempRoot();
    const targetPath = join(root, 'config.json');
    await mkdir(targetPath);

    expect(() => {
      atomicReplaceFileSync({targetPath, content: 'new\n', mode: 0o600});
    }).toThrow();

    expect(await readdir(root)).toEqual(['config.json']);
  });

  it('owns atomic replacement temp-name parsing for every storage caller', () => {
    const fileName =
      '.trace.jsonl.4242.00000000-0000-4000-8000-000000000000.tmp';

    expect(parseAtomicReplacementFileName(fileName)).toEqual({
      targetName: 'trace.jsonl',
      ownerPid: 4242,
    });
    expect(
      atomicReplacementFileBelongsToTarget(fileName, '/runtime/trace.jsonl'),
    ).toBe(true);
    expect(
      atomicReplacementFileBelongsToTarget(
        fileName,
        '/runtime/raw-events.jsonl',
      ),
    ).toBe(false);
  });
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-atomic-file-'));
  tempRoots.push(root);
  return root;
}
