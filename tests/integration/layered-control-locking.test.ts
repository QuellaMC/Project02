import {resolveRuntimeConfigScopeTarget} from '../../src/runtime/config/index.ts';
import {spawn} from 'node:child_process';
import {existsSync, readdirSync, realpathSync} from 'node:fs';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import {
  characterDataDirPath,
  createProject02HomeLayout,
  ensureCharacterDataDir,
} from '../../src/runtime/storage/index.ts';
import {acquireLocalRuntimeMutationLock} from '../../src/runtime/storage/mutation-lock.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async root => {
      await rm(root, {force: true, recursive: true});
    }),
  );
});

describe('layered control lock ordering', () => {
  it('orders reversed cross-process batches through physical lock-root aliases', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'project02-aliased-batch-locking-'),
    );
    const aliasRoot = join(root, 'a-alias');
    const otherRoot = join(root, 'm-other');
    const physicalRoot = join(root, 'z-shared');
    const barrierPath = join(root, 'start');

    tempRoots.push(root);
    await mkdir(physicalRoot);
    await mkdir(otherRoot);
    await symlink(physicalRoot, aliasRoot, 'dir');

    const aliasTarget = {
      locksRoot: join(aliasRoot, '.locks'),
      resourceKey: 'shared',
    };
    const physicalTarget = {
      locksRoot: join(physicalRoot, '.locks'),
      resourceKey: 'shared',
    };
    const otherTarget = {
      locksRoot: join(otherRoot, '.locks'),
      resourceKey: 'other',
    };
    const children = [
      runControlChild({
        script: barrieredMutationLockBatchScript,
        args: [JSON.stringify([aliasTarget, otherTarget]), barrierPath],
      }),
      runControlChild({
        script: barrieredMutationLockBatchScript,
        args: [JSON.stringify([otherTarget, physicalTarget]), barrierPath],
      }),
    ];

    await delay(250);
    await writeFile(barrierPath, 'go\n', 'utf8');
    await Promise.all(children);

    expect(overlayLockEntries(join(physicalRoot, '.locks'))).toEqual([]);
    expect(overlayLockEntries(join(otherRoot, '.locks'))).toEqual([]);
  }, 20_000);

  it('keeps a blocked global expectation write off the overlay lock', async () => {
    const {homeRoot, dataRoot, fingerprint} = await createLayeredHome();
    const overlayLocksRoot = join(dataRoot, '.locks');
    const startedPath = join(homeRoot, 'global-child-started');
    const globalLock = await acquireHomeConfigLock(homeRoot);

    try {
      const child = runControlChild({
        script: globalExpectationMutationScript,
        args: [homeRoot, startedPath, fingerprint],
      });

      await waitForFile(startedPath);
      await delay(400);

      // The canonical order is global first, then overlay; the inverse holds
      // the overlay lock here and deadlocks a character-scoped writer.
      expect(overlayLockEntries(overlayLocksRoot)).toEqual([]);

      await globalLock.release();
      await child;
    } finally {
      await globalLock.release();
    }
  }, 20_000);

  it('keeps a blocked character-scoped write off the overlay lock', async () => {
    const {homeRoot, dataRoot} = await createLayeredHome();
    const overlayLocksRoot = join(dataRoot, '.locks');
    const startedPath = join(homeRoot, 'character-child-started');
    const globalLock = await acquireHomeConfigLock(homeRoot);

    try {
      const child = runControlChild({
        script: characterMutationScript,
        args: [homeRoot, startedPath],
      });

      await waitForFile(startedPath);
      await delay(400);

      expect(overlayLockEntries(overlayLocksRoot)).toEqual([]);

      await globalLock.release();
      await child;
    } finally {
      await globalLock.release();
    }
  }, 20_000);

  it('serializes a global expectation write with a character-scoped write', async () => {
    const {homeRoot, fingerprint} = await createLayeredHome();
    const barrierPath = join(homeRoot, 'start');
    const children = [
      runControlChild({
        script: barrieredGlobalExpectationMutationScript,
        args: [homeRoot, barrierPath, fingerprint],
      }),
      runControlChild({
        script: barrieredCharacterMutationScript,
        args: [homeRoot, barrierPath],
      }),
    ];

    await delay(250);
    await writeFile(barrierPath, 'go\n', 'utf8');

    // Opposite acquisition orders would mutually wait out the lock timeout as
    // "storage busy", which each child's script still fails on.
    await Promise.all(children);
  }, 30_000);
});

const controlChildPrelude = [
  "import { existsSync, writeFileSync } from 'node:fs';",
  'const {',
  '  applyRuntimeConfigControlOperation,',
  '  bindProject02CharacterRuntimeLocation,',
  '  loadProject02RuntimeConfigWithLocation,',
  '  resolveRuntimeConfigScopeTarget,',
  "} = await import('./src/runtime/config/index.ts');",
  'const storeRoot = process.argv[1];',
  'const { configLocation } = loadProject02RuntimeConfigWithLocation({',
  "  selection: { storeRoot, character: 'mira' },",
  '});',
  'const runtimeLocation = bindProject02CharacterRuntimeLocation({',
  "  configLocation, characterId: 'mira',",
  '});',
  'const sleep = new Int32Array(new SharedArrayBuffer(4));',
].join('\n');

const globalExpectationMutationScript = [
  controlChildPrelude,
  'const target = resolveRuntimeConfigScopeTarget({',
  "  runtimeLocation, scope: 'global',",
  '});',
  "writeFileSync(process.argv[2], 'started\\n');",
  'applyRuntimeConfigControlOperation({',
  'sections: { plugins: [], connectors: [] },',
  '  target,',
  '  expectedFingerprint: process.argv[3],',
  '  request: {',
  "    kind: 'document',",
  "    operation: { kind: 'set', path: 'project02.userDisplayName', value: 'Global' },",
  '  },',
  '});',
].join('\n');

const characterMutationScript = [
  controlChildPrelude,
  'const target = resolveRuntimeConfigScopeTarget({',
  "  runtimeLocation, scope: 'character',",
  '});',
  "writeFileSync(process.argv[2], 'started\\n');",
  'applyRuntimeConfigControlOperation({',
  'sections: { plugins: [], connectors: [] },',
  '  target,',
  '  request: {',
  "    kind: 'document',",
  "    operation: { kind: 'set', path: 'project02.userDisplayName', value: 'Scoped' },",
  '  },',
  '});',
].join('\n');

const barrieredGlobalExpectationMutationScript = [
  controlChildPrelude,
  'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
  'const target = resolveRuntimeConfigScopeTarget({',
  "  runtimeLocation, scope: 'global',",
  '});',
  'try {',
  '  applyRuntimeConfigControlOperation({',
  '  sections: { plugins: [], connectors: [] },',
  '    target,',
  '    expectedFingerprint: process.argv[3],',
  '    request: {',
  "      kind: 'document',",
  "      operation: { kind: 'set', path: 'project02.userDisplayName', value: 'Global' },",
  '    },',
  '  });',
  '} catch (error) {',
  '  // A stale expectation after the scoped writer committed first is',
  '  // the serialized outcome; only a storage-busy timeout may fail.',
  "  if (error?.code !== 'runtime_config_conflict') throw error;",
  '}',
].join('\n');

const barrieredCharacterMutationScript = [
  controlChildPrelude,
  'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
  'const target = resolveRuntimeConfigScopeTarget({',
  "  runtimeLocation, scope: 'character',",
  '});',
  'applyRuntimeConfigControlOperation({',
  'sections: { plugins: [], connectors: [] },',
  '  target,',
  '  request: {',
  "    kind: 'document',",
  "    operation: { kind: 'set', path: 'project02.userDisplayName', value: 'Scoped' },",
  '  },',
  '});',
].join('\n');

const barrieredMutationLockBatchScript = [
  "import { existsSync } from 'node:fs';",
  "const { acquireLocalRuntimeMutationLocksSync } = await import('./src/runtime/storage/mutation-lock.ts');",
  'const sleep = new Int32Array(new SharedArrayBuffer(4));',
  'const targets = JSON.parse(process.argv[1]);',
  'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
  'const lease = acquireLocalRuntimeMutationLocksSync({',
  '  targets,',
  '  waitTimeoutMs: 5_000,',
  '});',
  'Atomics.wait(sleep, 0, 0, 100);',
  'lease.release();',
].join('\n');

async function createLayeredHome(): Promise<{
  readonly homeRoot: string;
  readonly dataRoot: string;
  readonly fingerprint: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'project02-layered-locking-'));

  tempRoots.push(root);

  // Lock resource keys are canonical-path based, and macOS tempdirs live
  // behind a /var symlink.
  const homeRoot = realpathSync(root);

  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    project02: {},
  });
  await ensureCharacterDataDir({homeRoot, characterId: 'mira'});

  const {applyRuntimeConfigControlOperation} =
    await import('../../src/runtime/config/index.ts');
  const seeded = applyRuntimeConfigControlOperation({
    sections: {plugins: [], connectors: []},
    target: resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'global',
    }),
    request: {
      kind: 'document',
      operation: {
        kind: 'set',
        path: 'project02.userDisplayName',
        value: 'Seed',
      },
    },
  });

  return {
    homeRoot,
    dataRoot: characterDataDirPath(homeRoot, 'mira'),
    fingerprint: seeded.fingerprint,
  };
}

async function acquireHomeConfigLock(homeRoot: string): Promise<{
  release(): Promise<void>;
}> {
  return acquireLocalRuntimeMutationLock({
    locksRoot: createProject02HomeLayout({homeRoot}).locksRoot,
    resourceKey: `runtime-control-file:${join(homeRoot, 'config.json')}`,
  });
}

function overlayLockEntries(overlayLocksRoot: string): readonly string[] {
  if (!existsSync(overlayLocksRoot)) {
    return [];
  }

  return readdirSync(overlayLocksRoot).filter(entry => entry.endsWith('.lock'));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (existsSync(path)) {
      return;
    }

    await delay(5);
  }

  throw new Error(`Timed out waiting for ${path}.`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

async function runControlChild(options: {
  readonly script: string;
  readonly args: readonly string[];
}): Promise<void> {
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', options.script, ...options.args],
      {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']},
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
          `Layered control child failed (${String(code ?? signal)}): ${stderr}`,
        ),
      );
    });
  });
}
