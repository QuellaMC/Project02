import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {ensureInitializedProject02Store} from '../../src/runtime/config/index.ts';
import {createProject02HomeLayout} from '../../src/runtime/storage/index.ts';
import {acquireLocalRuntimeMutationLock} from '../../src/runtime/storage/mutation-lock.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

const authoredConfig = `${JSON.stringify(
  {version: 1, project02: {userDisplayName: 'Authored By Hand'}},
  null,
  2,
)}\n`;

describe('store initialization against a concurrent config author', () => {
  it('keeps a config authored while initialization was in flight', async () => {
    const homeRoot = join(createTestTempRoot(), 'home');
    const layout = createProject02HomeLayout({homeRoot});

    // Stand where the competing author stands: holding the config file's
    // lock, mid-write. Initialization must not decide "absent" from a
    // look taken outside this lock, because the answer is only stable
    // inside it.
    const authorLock = await acquireLocalRuntimeMutationLock({
      locksRoot: layout.locksRoot,
      resourceKey: `runtime-control-file:${layout.configPath}`,
    });

    const initialization = ensureInitializedProject02Store({homeRoot});

    // Let initialization get as far as it can while the lock is held. If
    // it writes without taking the lock, it overwrites the bytes below.
    await new Promise(resolve => setTimeout(resolve, 50));
    writeFileSync(layout.configPath, authoredConfig, {mode: 0o600});
    await authorLock.release();

    await initialization;

    // The operator's document is theirs to keep. Losing it here is
    // silent: no error, no diagnostic, just different bytes on disk.
    expect(readFileSync(layout.configPath, 'utf8')).toBe(authoredConfig);
  });

  it('still creates the bootstrap document when nothing else authors one', async () => {
    const homeRoot = join(createTestTempRoot(), 'home');
    const layout = createProject02HomeLayout({homeRoot});

    await ensureInitializedProject02Store({homeRoot});

    expect(JSON.parse(readFileSync(layout.configPath, 'utf8'))).toMatchObject({
      project02: {storeRoot: homeRoot},
    });
  });
});
