import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimePluginFileStore,
  createRuntimePluginFileStoreTransaction
} from '../../src/runtime/storage/plugin-file-store/index.ts';
import { durablePluginStoreMutationResourceKey } from '../../src/runtime/storage/plugin-file-store/durable-primitives.ts';
import {
  createLocalRuntimePluginPaths,
  createLocalRuntimeStorageLayout
} from '../../src/runtime/storage/layout-contract.ts';
import {
  acquireLocalRuntimeMutationLockSync,
  LocalRuntimeMutationLockBusyError
} from '../../src/runtime/storage/mutation-lock.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    })
  );
});

describe('runtime plugin file store concurrency', () => {
  it('fails WAL preparation fast with a typed busy error under lock contention', async () => {
    const storeRoot = await createTempStoreRoot();
    const readyPath = join(storeRoot, 'prepare-lock-ready');
    const sessionId = 'session-concurrent-plugin-prepare';
    const pluginId = 'plugin.concurrent-prepare';
    const root = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId
    }).pluginRoot;
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction
      .fileStoreFor({ storeRoot, sessionId, pluginId })
      .appendJsonl('events.jsonl', { source: 'transaction' });
    const lockHolder = startMutationLockHolderChild({
      locksRoot: createLocalRuntimeStorageLayout({ storeRoot }).locksRoot,
      resourceKey: durablePluginStoreMutationResourceKey(root),
      readyPath,
      holdMs: 500
    });

    await waitForFile(readyPath);
    const prepareStartedAt = Date.now();

    await expect(
      transaction.prepare({
        eventId: 'evt_plugin_prepare_lock_race',
        traceId: 'trace_plugin_prepare_lock_race',
        createdAt: '2026-07-11T00:00:00.000Z'
      })
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    expect(Date.now() - prepareStartedAt).toBeLessThan(200);
    await lockHolder;
  }, 15_000);

  it('fails WAL finalization fast with a typed busy error under lock contention', async () => {
    const storeRoot = await createTempStoreRoot();
    const readyPath = join(storeRoot, 'finalize-lock-ready');
    const sessionId = 'session-concurrent-plugin-finalize';
    const pluginId = 'plugin.concurrent-finalize';
    const root = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId
    }).pluginRoot;
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction
      .fileStoreFor({ storeRoot, sessionId, pluginId })
      .appendJsonl('events.jsonl', { source: 'transaction' });
    const prepared = await transaction.prepare({
      eventId: 'evt_plugin_finalize_lock_race',
      traceId: 'trace_plugin_finalize_lock_race',
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const lockHolder = startMutationLockHolderChild({
      locksRoot: createLocalRuntimeStorageLayout({ storeRoot }).locksRoot,
      resourceKey: durablePluginStoreMutationResourceKey(root),
      readyPath,
      holdMs: 500
    });

    await waitForFile(readyPath);
    const finalizeStartedAt = Date.now();

    await expect(prepared.finalize()).rejects.toBeInstanceOf(
      LocalRuntimeMutationLockBusyError
    );
    expect(Date.now() - finalizeStartedAt).toBeLessThan(200);
    await lockHolder;
    await prepared.finalize();

    expect(
      createRuntimePluginFileStore({ storeRoot, sessionId, pluginId }).readJsonl(
        'events.jsonl'
      )
    ).toEqual([{ source: 'transaction' }]);
  }, 15_000);

  it('fails WAL discard fast with a typed busy error and remains retryable', async () => {
    const storeRoot = await createTempStoreRoot();
    const readyPath = join(storeRoot, 'discard-lock-ready');
    const sessionId = 'session-concurrent-plugin-discard';
    const pluginId = 'plugin.concurrent-discard';
    const root = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId
    }).pluginRoot;
    const identity = {
      eventId: 'evt_plugin_discard_lock_race',
      traceId: 'trace_plugin_discard_lock_race',
      createdAt: '2026-07-11T00:00:00.000Z'
    };
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction
      .fileStoreFor({ storeRoot, sessionId, pluginId })
      .appendJsonl('events.jsonl', { source: 'transaction' });
    const prepared = await transaction.prepare(identity);
    const lockHolder = startMutationLockHolderChild({
      locksRoot: createLocalRuntimeStorageLayout({ storeRoot }).locksRoot,
      resourceKey: durablePluginStoreMutationResourceKey(root),
      readyPath,
      holdMs: 500
    });

    await waitForFile(readyPath);
    const discardStartedAt = Date.now();

    await expect(prepared.discard()).rejects.toBeInstanceOf(
      LocalRuntimeMutationLockBusyError
    );
    expect(Date.now() - discardStartedAt).toBeLessThan(200);
    await lockHolder;
    await prepared.discard();
  }, 15_000);

  it('reclaims a dead plugin-root owner before mutating durable state', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionId = 'session-dead-plugin-lock';
    const pluginId = 'plugin.dead-lock';
    const root = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId
    }).pluginRoot;
    const abandoned = acquireLocalRuntimeMutationLockSync({
      locksRoot: createLocalRuntimeStorageLayout({ storeRoot }).locksRoot,
      resourceKey: durablePluginStoreMutationResourceKey(root),
      waitTimeoutMs: 0
    });
    const ownerPath = join(abandoned.lockPath, 'owner.json');
    const owner = requiredRecord(
      JSON.parse(await readFile(ownerPath, 'utf8')),
      'plugin mutation lock owner'
    );

    await writeFile(
      ownerPath,
      `${JSON.stringify({ ...owner, pid: 2_147_483_647 })}\n`,
      'utf8'
    );

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    store.appendJsonl('events.jsonl', { recovered: true });
    expect(store.readJsonl('events.jsonl')).toEqual([{ recovered: true }]);
    expect(store.revision()).toBe(1);
    await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
    abandoned.release();
  });
});

async function startMutationLockHolderChild(options: {
  readonly locksRoot: string;
  readonly resourceKey: string;
  readonly readyPath: string;
  readonly holdMs: number;
}): Promise<void> {
  const script = [
    "import { writeFileSync } from 'node:fs';",
    "const { acquireLocalRuntimeMutationLockSync } = await import('./src/runtime/storage/mutation-lock.ts');",
    'const lease = acquireLocalRuntimeMutationLockSync({',
    '  locksRoot: process.argv[1],',
    '  resourceKey: process.argv[2],',
    '  waitTimeoutMs: 0',
    '});',
    "writeFileSync(process.argv[3], 'ready\\n', 'utf8');",
    'const sleep = new Int32Array(new SharedArrayBuffer(4));',
    'Atomics.wait(sleep, 0, 0, Number(process.argv[4]));',
    'lease.release();'
  ].join('\n');

  return runInlineModuleChild(script, [
    options.locksRoot,
    options.resourceKey,
    options.readyPath,
    String(options.holdMs)
  ]);
}

async function runInlineModuleChild(
  script: string,
  arguments_: readonly string[]
): Promise<void> {
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, ...arguments_],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectChild);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveChild();
        return;
      }

      rejectChild(
        new Error(
          `Inline child failed (${String(code ?? signal)}): ${stderr}`
        )
      );
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  for (;;) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch (error: unknown) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child readiness file: ${path}.`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function requiredRecord(
  value: unknown,
  label: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }

  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-plugin-concurrency-'));
  tempRoots.push(root);
  return root;
}
