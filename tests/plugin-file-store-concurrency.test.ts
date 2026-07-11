import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimePluginFileStore,
  createRuntimePluginFileStoreTransaction
} from '../src/plugins/file-store.ts';
import { durablePluginStoreMutationResourceKey } from '../src/plugins/file-store/durable-primitives.ts';
import {
  createLocalRuntimePluginPaths,
  createLocalRuntimeStorageLayout
} from '../src/runtime/storage/layout.ts';
import { acquireLocalRuntimeMutationLockSync } from '../src/runtime/storage/mutation-lock.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    })
  );
});

describe('runtime plugin file store concurrency', () => {
  it('preserves every JSONL append and revision from separate processes', async () => {
    const storeRoot = await createTempStoreRoot();
    const barrierPath = join(storeRoot, 'start');
    const processCount = 8;
    const appendsPerProcess = 100;
    const children = Array.from({ length: processCount }, (_, processIndex) =>
      runPluginStoreChild({
        storeRoot,
        barrierPath,
        processIndex,
        operation: 'append',
        operationCount: appendsPerProcess
      })
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    await writeFile(barrierPath, 'go\n', 'utf8');
    await Promise.all(children);

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-concurrent-plugin-store',
      pluginId: 'plugin.concurrent'
    });
    const records = store.readJsonl('events.jsonl');

    expect(records).toHaveLength(processCount * appendsPerProcess);
    expect(store.revision()).toBe(processCount * appendsPerProcess);
    expect(
      new Set(
        records.map((record) => {
          const fields = requiredRecord(record, 'plugin append record');

          return `${String(requiredNumber(fields['processIndex']))}:${String(
            requiredNumber(fields['operationIndex'])
          )}`;
        })
      ).size
    ).toBe(processCount * appendsPerProcess);
    expect(
      (await readFile(
        join(
          storeRoot,
          'sessions',
          'session-concurrent-plugin-store',
          'plugins',
          'plugin.concurrent',
          'events.jsonl'
        ),
        'utf8'
      ))
        .trim()
        .split('\n')
    ).toHaveLength(processCount * appendsPerProcess);
  }, 60_000);

  it('serializes concurrent JSON replacements and their revisions', async () => {
    const storeRoot = await createTempStoreRoot();
    const barrierPath = join(storeRoot, 'start');
    const processCount = 6;
    const writesPerProcess = 20;
    const children = Array.from({ length: processCount }, (_, processIndex) =>
      runPluginStoreChild({
        storeRoot,
        barrierPath,
        processIndex,
        operation: 'write',
        operationCount: writesPerProcess
      })
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    await writeFile(barrierPath, 'go\n', 'utf8');
    await Promise.all(children);

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-concurrent-plugin-store',
      pluginId: 'plugin.concurrent'
    });
    const state = requiredRecord(
      store.readJson('state.json'),
      'plugin JSON state'
    );
    const processIndex = requiredNumber(state['processIndex']);
    const operationIndex = requiredNumber(state['operationIndex']);

    expect(processIndex).toBeGreaterThanOrEqual(0);
    expect(processIndex).toBeLessThan(processCount);
    expect(operationIndex).toBeGreaterThanOrEqual(0);
    expect(operationIndex).toBeLessThan(writesPerProcess);
    expect(store.revision()).toBe(processCount * writesPerProcess);
  }, 20_000);

  it('makes WAL finalization and a direct append share the live-owner lock', async () => {
    const storeRoot = await createTempStoreRoot();
    const barrierPath = join(storeRoot, 'start');
    const readyPath = join(storeRoot, 'lock-ready');
    const sessionId = 'session-concurrent-plugin-store';
    const pluginId = 'plugin.concurrent';
    const root = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId
    }).pluginRoot;
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction
      .fileStoreFor({ storeRoot, sessionId, pluginId })
      .appendJsonl('events.jsonl', { source: 'transaction' });
    const prepared = transaction.prepare({
      eventId: 'evt_plugin_lock_race',
      traceId: 'trace_plugin_lock_race',
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const lockHolder = startMutationLockHolderChild({
      locksRoot: createLocalRuntimeStorageLayout({ storeRoot }).locksRoot,
      resourceKey: durablePluginStoreMutationResourceKey(root),
      readyPath,
      holdMs: 500
    });

    await waitForFile(readyPath);
    const directAppend = runPluginStoreChild({
      storeRoot,
      barrierPath,
      processIndex: 1,
      operation: 'append',
      operationCount: 1
    });
    await writeFile(barrierPath, 'go\n', 'utf8');
    const finalizeStartedAt = Date.now();
    let finalizeError: unknown;

    try {
      prepared.finalize();
    } catch (error: unknown) {
      finalizeError = error;
    }

    expect(Date.now() - finalizeStartedAt).toBeGreaterThanOrEqual(200);
    await Promise.all([directAppend, lockHolder]);

    if (finalizeError === undefined) {
      const store = createRuntimePluginFileStore({
        storeRoot,
        sessionId,
        pluginId
      });
      const records = store.readJsonl('events.jsonl');

      expect(records).toHaveLength(2);
      expect(store.revision()).toBe(2);
    } else {
      if (!(finalizeError instanceof Error)) {
        throw new Error('Expected WAL finalization to fail with an Error.');
      }

      expect(finalizeError.message).toMatch(/transaction conflict/iu);
      expect(
        (await readFile(join(root, 'events.jsonl'), 'utf8'))
          .trim()
          .split('\n')
      ).toHaveLength(1);
      expect(
        await readFile(
          join(root, '.project02-plugin-store-revision'),
          'utf8'
        )
      ).toBe('1\n');
    }
  }, 15_000);

  it('serializes reversed multi-plugin transactions without revision drift', async () => {
    const storeRoot = await createTempStoreRoot();
    const barrierPath = join(storeRoot, 'finalize');
    const firstReadyPath = join(storeRoot, 'first-ready');
    const secondReadyPath = join(storeRoot, 'second-ready');
    const children = [
      runMultiRootTransactionChild({
        storeRoot,
        barrierPath,
        readyPath: firstReadyPath,
        childIndex: 1,
        pluginIds: ['plugin.alpha', 'plugin.beta']
      }),
      runMultiRootTransactionChild({
        storeRoot,
        barrierPath,
        readyPath: secondReadyPath,
        childIndex: 2,
        pluginIds: ['plugin.beta', 'plugin.alpha']
      })
    ];

    await Promise.all([
      waitForFile(firstReadyPath),
      waitForFile(secondReadyPath)
    ]);
    await writeFile(barrierPath, 'go\n', 'utf8');
    await Promise.all(children);

    for (const pluginId of ['plugin.alpha', 'plugin.beta']) {
      const root = createLocalRuntimePluginPaths({
        storeRoot,
        sessionId: 'session-multi-plugin-locking',
        pluginId
      }).pluginRoot;

      expect(await readFile(join(root, 'first.json'), 'utf8')).toContain(
        '"childIndex":1'
      );
      expect(await readFile(join(root, 'second.json'), 'utf8')).toContain(
        '"childIndex":2'
      );
      expect(
        createRuntimePluginFileStore({
          storeRoot,
          sessionId: 'session-multi-plugin-locking',
          pluginId
        }).revision()
      ).toBe(2);
    }
  }, 15_000);

  it('allows only one journal claim for the same full event identity', async () => {
    const storeRoot = await createTempStoreRoot();
    const barrierPath = join(storeRoot, 'prepare');
    const firstReadyPath = join(storeRoot, 'claim-first-ready');
    const secondReadyPath = join(storeRoot, 'claim-second-ready');
    const firstResultPath = join(storeRoot, 'claim-first-result');
    const secondResultPath = join(storeRoot, 'claim-second-result');
    const children = [
      runJournalClaimChild({
        storeRoot,
        barrierPath,
        readyPath: firstReadyPath,
        resultPath: firstResultPath,
        pluginId: 'plugin.claim-first'
      }),
      runJournalClaimChild({
        storeRoot,
        barrierPath,
        readyPath: secondReadyPath,
        resultPath: secondResultPath,
        pluginId: 'plugin.claim-second'
      })
    ];

    await Promise.all([
      waitForFile(firstReadyPath),
      waitForFile(secondReadyPath)
    ]);
    await writeFile(barrierPath, 'go\n', 'utf8');
    await Promise.all(children);

    const outcomes = [
      (await readFile(firstResultPath, 'utf8')).trim(),
      (await readFile(secondResultPath, 'utf8')).trim()
    ].sort();

    expect(outcomes).toEqual(['collision', 'prepared']);
    expect(
      (
        await readdir(
          join(
            storeRoot,
            'sessions',
            'session-journal-claim',
            '.plugin-transactions'
          )
        )
      ).filter((name) => name.endsWith('.json'))
    ).toHaveLength(1);
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

type PluginStoreChildOperation = 'append' | 'write';

async function runPluginStoreChild(options: {
  readonly storeRoot: string;
  readonly barrierPath: string;
  readonly processIndex: number;
  readonly operation: PluginStoreChildOperation;
  readonly operationCount: number;
}): Promise<void> {
  const script = [
    "import { existsSync } from 'node:fs';",
    "const { createRuntimePluginFileStore } = await import('./src/plugins/file-store.ts');",
    'const sleep = new Int32Array(new SharedArrayBuffer(4));',
    'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
    'const store = createRuntimePluginFileStore({',
    '  storeRoot: process.argv[1],',
    "  sessionId: 'session-concurrent-plugin-store',",
    "  pluginId: 'plugin.concurrent'",
    '});',
    'const processIndex = Number(process.argv[3]);',
    'const operationCount = Number(process.argv[5]);',
    'for (let operationIndex = 0; operationIndex < operationCount; operationIndex += 1) {',
    "  if (process.argv[4] === 'append') {",
    "    store.appendJsonl('events.jsonl', { processIndex, operationIndex });",
    '  } else {',
    "    store.writeJsonAtomic('state.json', { processIndex, operationIndex });",
    '  }',
    '}'
  ].join('\n');

  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        options.storeRoot,
        options.barrierPath,
        String(options.processIndex),
        options.operation,
        String(options.operationCount)
      ],
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
          `Plugin file-store child failed (${String(code ?? signal)}): ${stderr}`
        )
      );
    });
  });
}

function startMutationLockHolderChild(options: {
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

async function runMultiRootTransactionChild(options: {
  readonly storeRoot: string;
  readonly barrierPath: string;
  readonly readyPath: string;
  readonly childIndex: number;
  readonly pluginIds: readonly [string, string];
}): Promise<void> {
  const script = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "const { createRuntimePluginFileStoreTransaction } = await import('./src/plugins/file-store.ts');",
    'const transaction = createRuntimePluginFileStoreTransaction();',
    'const childIndex = Number(process.argv[4]);',
    'for (const pluginId of [process.argv[5], process.argv[6]]) {',
    '  transaction.fileStoreFor({',
    '    storeRoot: process.argv[1],',
    "    sessionId: 'session-multi-plugin-locking',",
    '    pluginId',
    '  }).writeJsonAtomic(`${childIndex === 1 ? "first" : "second"}.json`, { childIndex });',
    '}',
    'const prepared = transaction.prepare({',
    '  eventId: `evt_multi_${childIndex}`,',
    '  traceId: `trace_multi_${childIndex}`,',
    "  createdAt: `2026-07-11T00:00:0${childIndex}.000Z`",
    '});',
    "writeFileSync(process.argv[3], 'ready\\n', 'utf8');",
    'const sleep = new Int32Array(new SharedArrayBuffer(4));',
    'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
    'prepared.finalize();'
  ].join('\n');

  await runInlineModuleChild(script, [
    options.storeRoot,
    options.barrierPath,
    options.readyPath,
    String(options.childIndex),
    ...options.pluginIds
  ]);
}

async function runJournalClaimChild(options: {
  readonly storeRoot: string;
  readonly barrierPath: string;
  readonly readyPath: string;
  readonly resultPath: string;
  readonly pluginId: string;
}): Promise<void> {
  const script = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "const { createRuntimePluginFileStoreTransaction } = await import('./src/plugins/file-store.ts');",
    'const transaction = createRuntimePluginFileStoreTransaction();',
    'transaction.fileStoreFor({',
    '  storeRoot: process.argv[1],',
    "  sessionId: 'session-journal-claim',",
    '  pluginId: process.argv[5]',
    "}).appendJsonl('events.jsonl', { pluginId: process.argv[5] });",
    "writeFileSync(process.argv[3], 'ready\\n', 'utf8');",
    'const sleep = new Int32Array(new SharedArrayBuffer(4));',
    'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
    "let outcome = 'prepared';",
    'try {',
    '  transaction.prepare({',
    "    eventId: 'evt_shared_journal_claim',",
    "    traceId: 'trace_shared_journal_claim',",
    "    createdAt: '2026-07-11T00:00:00.000Z'",
    '  });',
    '} catch (error) {',
    "  if (!(error instanceof Error) || !/already exists/iu.test(error.message)) throw error;",
    "  outcome = 'collision';",
    '}',
    "writeFileSync(process.argv[4], `${outcome}\\n`, 'utf8');"
  ].join('\n');

  await runInlineModuleChild(script, [
    options.storeRoot,
    options.barrierPath,
    options.readyPath,
    options.resultPath,
    options.pluginId
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

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('Expected plugin file-store test field to be a number.');
  }

  return value;
}

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-plugin-concurrency-'));
  tempRoots.push(root);
  return root;
}
