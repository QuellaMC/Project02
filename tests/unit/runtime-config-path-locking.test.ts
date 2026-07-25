import {readFileSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import type * as NodeFs from 'node:fs';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {runtimeConfigVersion} from '../../src/runtime/config/types.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('runtime config canonical path locking', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('restarts from a symlink target that changes after config read', async () => {
    const root = createTestTempRoot('project02-config-symlink-swap-');
    const targetA = join(root, 'config-a.json');
    const targetB = join(root, 'config-b.json');
    const configAlias = join(root, 'runtime.json');

    writeFileSync(
      targetA,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {storeRoot: root},
        plugins: {alpha: {enabled: true}},
      })}\n`,
      'utf8',
    );
    writeFileSync(
      targetB,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {storeRoot: root},
        plugins: {beta: {enabled: true}},
      })}\n`,
      'utf8',
    );
    symlinkSync(targetA, configAlias);
    let swapped = false;
    let aliasReads = 0;

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        readFileSync(path: NodeFs.PathOrFileDescriptor, ...args: unknown[]) {
          const content = Reflect.apply(actual.readFileSync, actual, [
            path,
            ...args,
          ]) as unknown;

          if (path === configAlias) {
            aliasReads += 1;

            if (aliasReads === 2 && !swapped) {
              swapped = true;
              unlinkSync(configAlias);
              symlinkSync(targetB, configAlias);
            }
          }

          return content;
        },
      };
    });

    const {
      applyRuntimeConfigControlOperation,
      loadProject02RuntimeConfig,
      resolveProject02RuntimeLocation,
      resolveRuntimeConfigScopeTarget,
    } = await import('../../src/runtime/config/index.ts');
    const {requiredSecretPlugin} =
      await import('../support/runtime-config-fixtures.ts');

    const loadedConfig = loadProject02RuntimeConfig({
      configPath: configAlias,
      env: {},
    });
    const runtimeLocation = resolveProject02RuntimeLocation({
      loadedConfig,
      selection: {configPath: configAlias},
    });

    applyRuntimeConfigControlOperation({
      target: resolveRuntimeConfigScopeTarget({
        runtimeLocation,
        env: {},
        scope: 'global',
      }),
      request: {
        kind: 'plugin_activation',
        manifest: requiredSecretPlugin('gamma').manifest,
        enabled: true,
      },
    });

    const configA = JSON.parse(readFileSync(targetA, 'utf8')) as {
      readonly plugins: Readonly<Record<string, unknown>>;
    };
    const configB = JSON.parse(readFileSync(targetB, 'utf8')) as {
      readonly plugins: Readonly<Record<string, unknown>>;
    };

    expect(configA.plugins).toEqual({alpha: {enabled: true}});
    expect(configB.plugins).toEqual({
      beta: {enabled: true},
      gamma: {enabled: true},
    });
  });
});
