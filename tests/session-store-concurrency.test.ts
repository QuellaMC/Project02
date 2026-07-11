import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError
} from '../src/runtime/storage/session-store.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    })
  );
});

describe('local runtime session catalog concurrency', () => {
  it('allows exactly one creator for a shared session ID across child processes', async () => {
    const storeRoot = await createTempStoreRoot();
    const results = await Promise.all(
      Array.from({ length: 12 }, async () =>
        await createSessionInChildProcess(storeRoot, 'shared-child-session')
      )
    );

    expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' &&
          result.code === 'session_already_exists'
      )
    ).toHaveLength(11);
    const catalog = await readFile(join(storeRoot, 'sessions.jsonl'), 'utf8');
    expect(catalog.trim().split('\n')).toHaveLength(1);
  }, 20_000);

  it('preserves distinct sessions created by concurrent child processes', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionIds = Array.from(
      { length: 24 },
      (_, index) => `child-session-${String(index).padStart(2, '0')}`
    );
    const results = await Promise.all(
      sessionIds.map(async (sessionId) =>
        await createSessionInChildProcess(storeRoot, sessionId)
      )
    );

    expect(results.every((result) => result.status === 'created')).toBe(true);
    const sessions = await createLocalRuntimeSessionStore({
      storeRoot
    }).listSessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(sessionIds);
  }, 20_000);

  it('allows exactly one creator for a shared session ID', async () => {
    const storeRoot = await createTempStoreRoot();
    const stores = Array.from({ length: 12 }, () =>
      createLocalRuntimeSessionStore({ storeRoot })
    );

    const results = await Promise.allSettled(
      stores.map(async (store) => {
        return await store.createSession({
          sessionId: 'shared-session',
          createdAt: '2026-07-11T00:00:00.000Z'
        });
      })
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected).toHaveLength(11);
    expect(
      rejected.every(
        (result) =>
          result.reason instanceof LocalRuntimeSessionStoreError &&
          result.reason.code === 'session_already_exists'
      )
    ).toBe(true);

    const catalog = await readFile(join(storeRoot, 'sessions.jsonl'), 'utf8');
    expect(catalog.trim().split('\n')).toHaveLength(1);
  });

  it('preserves every distinct session created concurrently', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionIds = Array.from(
      { length: 24 },
      (_, index) => `session-${String(index).padStart(2, '0')}`
    );

    await Promise.all(
      sessionIds.map(async (sessionId) => {
        await createLocalRuntimeSessionStore({ storeRoot }).createSession({
          sessionId,
          createdAt: '2026-07-11T00:00:00.000Z'
        });
      })
    );

    const sessions = await createLocalRuntimeSessionStore({
      storeRoot
    }).listSessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(sessionIds);

    const catalog = await readFile(join(storeRoot, 'sessions.jsonl'), 'utf8');
    expect(catalog.trim().split('\n')).toHaveLength(sessionIds.length);
  });

  it('compacts legacy duplicate catalog history on selection', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({ storeRoot });
    const created = await store.createSession({
      sessionId: 'legacy-history',
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const catalogPath = join(storeRoot, 'sessions.jsonl');
    await appendFile(
      catalogPath,
      `${JSON.stringify({
        ...created,
        updatedAt: '2026-07-11T00:00:01.000Z'
      })}\n`,
      'utf8'
    );

    await store.selectSession('legacy-history', {
      updatedAt: '2026-07-11T00:00:02.000Z'
    });

    const lines = (await readFile(catalogPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      sessionId: 'legacy-history',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:02.000Z'
    });
  });
});

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-session-concurrency-'));
  tempRoots.push(root);
  return root;
}

type ChildSessionCreateResult =
  | { readonly status: 'created' }
  | { readonly status: 'rejected'; readonly code: string };

async function createSessionInChildProcess(
  storeRoot: string,
  sessionId: string
): Promise<ChildSessionCreateResult> {
  const script = [
    "import { createLocalRuntimeSessionStore } from './src/runtime/storage/session-store.ts';",
    'try {',
    '  await createLocalRuntimeSessionStore({ storeRoot: process.argv[1] }).createSession({',
    '    sessionId: process.argv[2],',
    "    createdAt: '2026-07-11T00:00:00.000Z'",
    '  });',
    "  process.stdout.write(JSON.stringify({ status: 'created' }));",
    '} catch (error) {',
    "  const code = typeof error === 'object' && error !== null && 'code' in error",
    "    ? String(error.code) : 'unknown';",
    "  process.stdout.write(JSON.stringify({ status: 'rejected', code }));",
    '}'
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', script, storeRoot, sessionId],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );

  return await new Promise<ChildSessionCreateResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Session child exited ${String(code)}: ${stderr}`));
        return;
      }

      resolve(JSON.parse(stdout) as ChildSessionCreateResult);
    });
  });
}
