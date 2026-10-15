import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  applyRuntimeConfigControlOperation,
  bindProject02CharacterRuntimeLocation,
  loadProject02RuntimeConfigWithLocation,
  resolveRuntimeConfigScopeTarget,
  RuntimeConfigLocationError,
} from '../../src/runtime/config/index.ts';
import {readRuntimeConfigControlSnapshot} from '../../src/runtime/config/control-transaction.ts';
import {runtimeConfigVersion} from '../../src/runtime/config/types.ts';
import {loadRuntimeConfigForTest} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {ensureInitializedProject02Home} from '../../src/runtime/storage/index.ts';

describe('runtime config canonical path locking', () => {
  it.each([
    {label: 'deep path', throughAlias: false},
    {label: 'outside alias', throughAlias: true},
  ])(
    'rejects a global target at a character-owned $label',
    async ({throughAlias}) => {
      const root = createTestTempRoot(
        'project02-config-character-owned-target-',
      );
      const nestedRoot = join(
        root,
        'character-data',
        'mira',
        'sessions',
        'rogue',
      );
      const nestedConfigPath = join(nestedRoot, 'config.json');
      const outsideHome = join(root, 'outside-home');

      await ensureInitializedProject02Home({homeRoot: root});
      mkdirSync(nestedRoot, {recursive: true});
      writeFileSync(
        nestedConfigPath,
        `${JSON.stringify({version: runtimeConfigVersion})}\n`,
        'utf8',
      );
      if (throughAlias) {
        mkdirSync(outsideHome);
        symlinkSync(nestedConfigPath, join(outsideHome, 'config.json'));
      }
      expect(() =>
        loadRuntimeConfigForTest({
          storeRoot: throughAlias ? outsideHome : nestedRoot,
        }),
      ).toThrow(RuntimeConfigLocationError);
      expect(existsSync(join(nestedRoot, '.locks'))).toBe(false);
    },
  );

  it('rejects a structurally cloned target before it can redirect a commit', () => {
    const rootA = createTestTempRoot('project02-config-target-brand-a-');
    const rootB = createTestTempRoot('project02-config-target-brand-b-');
    const configA = join(rootA, 'config.json');
    const configB = join(rootB, 'config.json');
    const initialConfig = `${JSON.stringify({
      version: runtimeConfigVersion,
      project02: {roleModelProvider: 'local'},
    })}\n`;

    writeFileSync(configA, initialConfig, 'utf8');
    writeFileSync(configB, initialConfig, 'utf8');
    const {configLocation} = loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot: rootA},
    });
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation,
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation,
      scope: 'global',
    });
    const redirectedTarget = {
      ...target,
      configPath: configB,
      canonicalConfigPath: configB,
    };

    expect(() =>
      readRuntimeConfigControlSnapshot(redirectedTarget, {
        sections: {plugins: []},
      }),
    ).toThrow(
      'Runtime config scope target must be created by resolveRuntimeConfigScopeTarget()',
    );
    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: []},
        target: redirectedTarget,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.roleModelProvider',
            value: 'nvidia',
          },
        },
      }),
    ).toThrow(
      'Runtime config scope target must be created by resolveRuntimeConfigScopeTarget()',
    );
    expect(readFileSync(configA, 'utf8')).toBe(initialConfig);
    expect(readFileSync(configB, 'utf8')).toBe(initialConfig);
    expect(existsSync(join(rootA, '.locks'))).toBe(false);
    expect(existsSync(join(rootB, '.locks'))).toBe(false);
  });
});
