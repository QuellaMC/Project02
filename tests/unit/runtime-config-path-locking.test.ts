import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  applyRuntimeConfigControlOperation,
  bindProject02CharacterRuntimeLocation,
  loadProject02RuntimeConfigWithLocation,
  resolveRuntimeConfigScopeTarget,
  RuntimeConfigConflictError,
  RuntimeConfigLocationError,
} from '../../src/runtime/config/index.ts';
import {readRuntimeConfigControlSnapshot} from '../../src/runtime/config/control-transaction.ts';
import {runtimeConfigVersion} from '../../src/runtime/config/types.ts';
import {requiredSecretPlugin} from '../support/runtime-config-activation-fixtures.ts';
import {loadRuntimeConfigForTest} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {ensureInitializedProject02Home} from '../../src/runtime/storage/index.ts';

describe('runtime config canonical path locking', () => {
  it('rejects a missing path below character-owned storage without materializing it', async () => {
    const root = createTestTempRoot(
      'project02-config-missing-character-owned-target-',
    );
    const characterDataRoot = join(root, 'character-data');
    const dataRoot = join(characterDataRoot, 'mira');
    const nestedConfigPath = join(dataRoot, 'sessions', 'rogue', 'config.json');

    await ensureInitializedProject02Home({homeRoot: root});

    expect(() =>
      loadRuntimeConfigForTest({
        configPath: nestedConfigPath,
        env: {},
      }),
    ).toThrow(RuntimeConfigLocationError);
    expect(existsSync(dataRoot)).toBe(false);
  });

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
      const outsideAlias = join(root, 'outside-runtime.json');
      const selectedPath = throughAlias ? outsideAlias : nestedConfigPath;

      await ensureInitializedProject02Home({homeRoot: root});
      mkdirSync(nestedRoot, {recursive: true});
      writeFileSync(
        nestedConfigPath,
        `${JSON.stringify({version: runtimeConfigVersion})}\n`,
        'utf8',
      );
      if (throughAlias) {
        symlinkSync(nestedConfigPath, outsideAlias);
      }
      expect(() =>
        loadRuntimeConfigForTest({
          configPath: selectedPath,
          env: {},
        }),
      ).toThrow(RuntimeConfigLocationError);
      expect(existsSync(join(nestedRoot, '.locks'))).toBe(false);
    },
  );

  it('rejects a prepared target whose display alias now names another file', () => {
    const root = createTestTempRoot('project02-config-symlink-swap-');
    const targetA = join(root, 'config-a.json');
    const targetB = join(root, 'config-b.json');
    const configAlias = join(root, 'runtime.json');

    const identicalConfig = `${JSON.stringify({
      version: runtimeConfigVersion,
      project02: {storeRoot: root},
      plugins: {alpha: {enabled: true}},
    })}\n`;

    writeFileSync(targetA, identicalConfig, 'utf8');
    writeFileSync(targetB, identicalConfig, 'utf8');
    symlinkSync(targetA, configAlias);
    const {configLocation} = loadProject02RuntimeConfigWithLocation({
      selection: {configPath: configAlias},
      env: {},
    });
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation,
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation,
      env: {},
      scope: 'global',
    });
    const configABefore = readFileSync(targetA, 'utf8');
    const configBBefore = readFileSync(targetB, 'utf8');

    unlinkSync(configAlias);
    symlinkSync(targetB, configAlias);

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: {
          kind: 'plugin_activation',
          manifest: requiredSecretPlugin('gamma').manifest,
          enabled: true,
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
    expect(readFileSync(targetA, 'utf8')).toBe(configABefore);
    expect(readFileSync(targetB, 'utf8')).toBe(configBBefore);
    expect(existsSync(join(root, '.locks'))).toBe(false);

    const fresh = loadProject02RuntimeConfigWithLocation({
      selection: {configPath: configAlias},
      env: {},
    });
    const freshRuntimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation: fresh.configLocation,
      characterId: 'mira',
    });

    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target: resolveRuntimeConfigScopeTarget({
        runtimeLocation: freshRuntimeLocation,
        env: {},
        scope: 'global',
      }),
      request: {
        kind: 'plugin_activation',
        manifest: requiredSecretPlugin('gamma').manifest,
        enabled: true,
      },
    });

    expect(readFileSync(targetA, 'utf8')).toBe(configABefore);
    expect(
      (
        JSON.parse(readFileSync(targetB, 'utf8')) as {
          readonly plugins: Readonly<Record<string, unknown>>;
        }
      ).plugins,
    ).toEqual({
      alpha: {enabled: true},
      gamma: {enabled: true},
    });
  });

  it('rejects a non-home mutation when the reloaded config selects another home', () => {
    const root = createTestTempRoot('project02-config-reloaded-home-drift-');
    const firstHome = createTestTempRoot(
      'project02-config-reloaded-home-first-',
    );
    const secondHome = createTestTempRoot(
      'project02-config-reloaded-home-second-',
    );
    const configPath = join(root, 'runtime.json');

    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {storeRoot: firstHome, userDisplayName: 'Before'},
      })}\n`,
      'utf8',
    );
    const {configLocation} = loadProject02RuntimeConfigWithLocation({
      selection: {configPath},
      env: {},
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: configLocation,
      env: {},
      scope: 'global',
    });
    const externallyRewritten = `${JSON.stringify({
      version: runtimeConfigVersion,
      project02: {storeRoot: secondHome, userDisplayName: 'Before'},
    })}\n`;

    writeFileSync(configPath, externallyRewritten, 'utf8');

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Must Not Land',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
    expect(readFileSync(configPath, 'utf8')).toBe(externallyRewritten);
  });

  it('rejects a structurally cloned target before it can redirect a commit', () => {
    const rootA = createTestTempRoot('project02-config-target-brand-a-');
    const rootB = createTestTempRoot('project02-config-target-brand-b-');
    const configA = join(rootA, 'runtime.json');
    const configB = join(rootB, 'runtime.json');
    const initialConfig = `${JSON.stringify({
      version: runtimeConfigVersion,
      project02: {roleModelProvider: 'local'},
    })}\n`;

    writeFileSync(configA, initialConfig, 'utf8');
    writeFileSync(configB, initialConfig, 'utf8');
    const {configLocation} = loadProject02RuntimeConfigWithLocation({
      selection: {configPath: configA},
      env: {},
    });
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation,
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation,
      env: {},
      scope: 'global',
    });
    const redirectedTarget = {
      ...target,
      configPath: configB,
      canonicalConfigPath: configB,
    };

    expect(() =>
      readRuntimeConfigControlSnapshot(redirectedTarget, {pluginManifests: []}),
    ).toThrow(
      'Runtime config scope target must be created by resolveRuntimeConfigScopeTarget()',
    );
    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
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
