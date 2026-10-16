import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {ensureInitializedProject02Home} from '../../src/runtime/storage/index.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async root => {
      await rm(root, {force: true, recursive: true});
    }),
  );
});

describe('runtime config mutation concurrency', () => {
  it('preserves concurrent plugin enables from separate processes', async () => {
    const storeRoot = await createTempStoreRoot();
    const barrierPath = join(storeRoot, 'start');
    const pluginIds = Array.from(
      {length: 24},
      (_, index) => `plugin-${String(index).padStart(2, '0')}`,
    );
    const children = pluginIds.map(pluginId =>
      runConfigMutationChild({storeRoot, barrierPath, pluginId}),
    );

    await new Promise<void>(resolve => {
      setTimeout(resolve, 250);
    });
    await writeFile(barrierPath, 'go\n', 'utf8');
    await Promise.all(children);

    const stored = JSON.parse(
      await readFile(join(storeRoot, 'config.json'), 'utf8'),
    ) as {
      readonly plugins?: Readonly<Record<string, {readonly enabled?: boolean}>>;
    };

    expect(Object.keys(stored.plugins ?? {}).sort()).toEqual(pluginIds);
    expect(
      pluginIds.every(pluginId => stored.plugins?.[pluginId]?.enabled === true),
    ).toBe(true);
  }, 20_000);
});

async function runConfigMutationChild(options: {
  readonly storeRoot: string;
  readonly barrierPath: string;
  readonly pluginId: string;
}): Promise<void> {
  const script = [
    "import { existsSync } from 'node:fs';",
    "const { applyRuntimeConfigControlOperation, loadProject02RuntimeConfigWithLocation, resolveRuntimeConfigScopeTarget } = await import('./src/runtime/config/index.ts');",
    "const { requiredSecretPlugin } = await import('./tests/support/runtime-config-activation-fixtures.ts');",
    'const sleep = new Int32Array(new SharedArrayBuffer(4));',
    'while (!existsSync(process.argv[2])) Atomics.wait(sleep, 0, 0, 5);',
    'const { configLocation } = loadProject02RuntimeConfigWithLocation({ selection: { storeRoot: process.argv[1] } });',
    'applyRuntimeConfigControlOperation({',
    'sections: { plugins: [], connectors: [] },',
    "  target: resolveRuntimeConfigScopeTarget({ runtimeLocation: configLocation, scope: 'global' }),",
    "  request: { kind: 'section_activation', namespace: 'plugins', declaration: requiredSecretPlugin(process.argv[3]).manifest, enabled: true }",
    '});',
  ].join('\n');

  await runMutationChildProcess({
    script,
    args: [options.storeRoot, options.barrierPath, options.pluginId],
  });
}

async function runMutationChildProcess(options: {
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
          `Runtime config mutation child failed (${String(code ?? signal)}): ${stderr}`,
        ),
      );
    });
  });
}

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-config-concurrency-'));
  tempRoots.push(root);
  await ensureInitializedProject02Home({homeRoot: root});
  return root;
}
