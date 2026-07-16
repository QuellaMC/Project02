import {
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runtimeConfigVersion } from '../src/runtime/config/types.ts';
import { createTestTempRoot } from './support/temp-root.ts';

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
        project02: { storeRoot: root },
        plugins: { alpha: { enabled: true } }
      })}\n`,
      'utf8'
    );
    writeFileSync(
      targetB,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: { storeRoot: root },
        plugins: { beta: { enabled: true } }
      })}\n`,
      'utf8'
    );
    symlinkSync(targetA, configAlias);
    let swapped = false;

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        readFileSync(path: NodeFs.PathOrFileDescriptor, ...args: unknown[]) {
          const content = Reflect.apply(actual.readFileSync, actual, [
            path,
            ...args
          ]) as unknown;

          if (path === configAlias && !swapped) {
            swapped = true;
            unlinkSync(configAlias);
            symlinkSync(targetB, configAlias);
          }

          return content;
        }
      };
    });

    const { applyRuntimeConfigMutation } = await import(
      '../src/runtime/config/mutate.ts'
    );

    applyRuntimeConfigMutation({
      configPath: configAlias,
      operation: {
        kind: 'plugin_enable',
        pluginId: 'gamma'
      }
    });

    const configA = JSON.parse(readFileSync(targetA, 'utf8')) as {
      readonly plugins: Readonly<Record<string, unknown>>;
    };
    const configB = JSON.parse(readFileSync(targetB, 'utf8')) as {
      readonly plugins: Readonly<Record<string, unknown>>;
    };

    expect(configA.plugins).toEqual({ alpha: { enabled: true } });
    expect(configB.plugins).toEqual({
      beta: { enabled: true },
      gamma: { enabled: true }
    });
  });
});
