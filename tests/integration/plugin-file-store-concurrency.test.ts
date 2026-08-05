import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {durablePluginStoreMutationResourceKey} from '../../src/runtime/storage/plugin-file-store/durable-primitives.ts';
import {
  createLocalRuntimePluginPaths,
  createLocalRuntimeStorageLayout,
} from '../../src/runtime/storage/layout-contract.ts';
import {acquireLocalRuntimeMutationLockSync} from '../../src/runtime/storage/mutation-lock.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('runtime plugin file store concurrency', () => {
  it('reclaims a dead plugin-root owner before mutating durable state', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-lock-');
    const sessionId = 'session-dead-plugin-lock';
    const pluginId = 'plugin.dead-lock';
    const root = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId,
    }).pluginRoot;
    const abandoned = acquireLocalRuntimeMutationLockSync({
      locksRoot: createLocalRuntimeStorageLayout({storeRoot}).locksRoot,
      resourceKey: durablePluginStoreMutationResourceKey(root),
      waitTimeoutMs: 0,
    });
    const ownerPath = join(abandoned.lockPath, 'owner.json');
    const owner = requiredRecord(
      JSON.parse(await readFile(ownerPath, 'utf8')),
      'plugin mutation lock owner',
    );

    await writeFile(
      ownerPath,
      `${JSON.stringify({...owner, pid: 2_147_483_647})}\n`,
      'utf8',
    );

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    store.appendJsonl('events.jsonl', {recovered: true});
    expect(store.readJsonl('events.jsonl')).toEqual([{recovered: true}]);
    expect(store.revision()).toBe(1);
    await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    abandoned.release();
  });
});

function requiredRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }

  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
