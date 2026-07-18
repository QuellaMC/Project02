import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as AtomicFileModule from '../../src/runtime/storage/atomic-file.ts';
import type { AtomicReplaceFileOptions } from '../../src/runtime/storage/atomic-file.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock('../../src/runtime/storage/atomic-file.ts');
  vi.resetModules();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    })
  );
});

describe('local runtime session catalog mutation failures', () => {
  it('removes a newly-created empty session directory when catalog rewrite fails', async () => {
    const storeRoot = await createTempStoreRoot();
    vi.doMock('../../src/runtime/storage/atomic-file.ts', async () => {
      const actual = await vi.importActual<typeof AtomicFileModule>(
        '../../src/runtime/storage/atomic-file.ts'
      );

      return {
        ...actual,
        async atomicReplaceFile(options: AtomicReplaceFileOptions) {
          if (options.targetPath.endsWith('sessions.jsonl')) {
            throw new Error('catalog replacement denied');
          }

          await actual.atomicReplaceFile(options);
        }
      };
    });
    const { createLocalRuntimeSessionStore } = await import(
      '../../src/runtime/storage/session-store.ts'
    );

    await expect(
      createLocalRuntimeSessionStore({ storeRoot }).createSession({
        sessionId: 'rolled-back-session',
        createdAt: '2026-07-11T00:00:00.000Z'
      })
    ).rejects.toThrow('Could not rewrite local runtime session catalog');

    expect(await readdir(join(storeRoot, 'sessions'))).toEqual([]);
  });

  it('fails closed when a session directory already contains evidence', async () => {
    const storeRoot = await createTempStoreRoot();
    const { createLocalRuntimeSessionStore } = await import(
      '../../src/runtime/storage/session-store.ts'
    );
    const store = createLocalRuntimeSessionStore({ storeRoot });
    await store.createSession({
      sessionId: 'existing-session',
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    await mkdir(join(storeRoot, 'sessions', 'orphan-session'));
    await writeFile(
      join(storeRoot, 'sessions', 'orphan-session', 'evidence.jsonl'),
      '{}\n',
      'utf8'
    );

    await expect(
      store.createSession({
        sessionId: 'orphan-session',
        createdAt: '2026-07-11T00:00:01.000Z'
      })
    ).rejects.toMatchObject({ code: 'missing_file' });
  });
});

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-session-write-error-'));
  tempRoots.push(root);
  return root;
}
