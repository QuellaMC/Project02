import {spawn} from 'node:child_process';
import {existsSync, readdirSync, realpathSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {writeRuntimeConfig} from '../support/runtime-config.ts';
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

      // While blocked on the global-layer lock, the child must not
      // have acquired (or even materialized) the overlay lock: the
      // canonical order is global first, then overlay. The inverted
      // order would hold the overlay lock here and deadlock against a
      // concurrent character-scoped writer.
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

    // Both must complete: the shared canonical order serializes them
    // instead of letting opposite acquisition orders mutually wait out
    // the lock timeout as "storage busy".
    await Promise.all(children);
  }, 30_000);
});

const controlChildPrelude = [
  "import { existsSync, writeFileSync } from 'node:fs';",
  'const {',
  '  applyRuntimeConfigControlOperation,',
  '  resolveRuntimeConfigScopeTarget,',
  "} = await import('./src/runtime/config/index.ts');",
  'const sleep = new Int32Array(new SharedArrayBuffer(4));',
].join('\n');

const globalExpectationMutationScript = [
  controlChildPrelude,
  'const target = resolveRuntimeConfigScopeTarget({',
  "  storeRoot: process.argv[1], env: {}, scope: 'global',",
  '});',
  "writeFileSync(process.argv[2], 'started\\n');",
  'applyRuntimeConfigControlOperation({',
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
  "  storeRoot: process.argv[1], env: {}, scope: 'character', characterId: 'mira',",
  '});',
  "writeFileSync(process.argv[2], 'started\\n');",
  'applyRuntimeConfigControlOperation({',
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
  "  storeRoot: process.argv[1], env: {}, scope: 'global',",
  '});',
  'applyRuntimeConfigControlOperation({',
  '  target,',
  '  expectedFingerprint: process.argv[3],',
  '  request: {',
  "    kind: 'document',",
  "    operation: { kind: 'set', path: 'project02.userDisplayName', value: 'Global' },",
  '  },',
  '});',
].join('\n');

const barrieredCharacterMutationScript = [
  controlChildPrelude,
  'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
  'const target = resolveRuntimeConfigScopeTarget({',
  "  storeRoot: process.argv[1], env: {}, scope: 'character', characterId: 'mira',",
  '});',
  'applyRuntimeConfigControlOperation({',
  '  target,',
  '  request: {',
  "    kind: 'document',",
  "    operation: { kind: 'set', path: 'project02.userDisplayName', value: 'Scoped' },",
  '  },',
  '});',
].join('\n');

async function createLayeredHome(): Promise<{
  readonly homeRoot: string;
  readonly dataRoot: string;
  readonly fingerprint: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'project02-layered-locking-'));

  tempRoots.push(root);

  // Canonical from the start: lock resource keys are canonical-path
  // based, and macOS tempdirs live behind a /var symlink.
  const homeRoot = realpathSync(root);

  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    project02: {storeRoot: homeRoot, character: 'mira'},
  });
  await ensureCharacterDataDir({homeRoot, characterId: 'mira'});

  const {applyRuntimeConfigControlOperation, resolveRuntimeConfigScopeTarget} =
    await import('../../src/runtime/config/index.ts');
  const seeded = applyRuntimeConfigControlOperation({
    target: resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
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
