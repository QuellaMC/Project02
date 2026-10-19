import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  characterOnlyConfigPlugin,
  fieldScopedConfigPlugin,
  requiredCharacterFieldConfigPlugin,
  structuredConfigPlugin,
} from '../support/runtime-config-fixtures.ts';
import {requiredSecretPlugin} from '../support/runtime-config-activation-fixtures.ts';
import {
  runtimeLocationForTest,
  writeRuntimeConfig,
  loadRuntimeConfigForTest,
  configLocationForTest,
} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  applyRuntimeConfigControlOperation,
  bindProject02CharacterRuntimeLocation,
  characterOverlayConfigPath,
  createLayeredProject02RuntimeConfigSnapshot,
  createProject02ConfigFieldInspectShapes,
  diagnosticsHaveErrors,
  readCharacterOverlayForScope,
  resolveLayeredProject02RuntimeConfig,
  resolveLayeredProject02RuntimeConfigWithSnapshot,
  createLayeredRuntimeConfigFingerprint,
  createRuntimePluginConfigControlCapability,
  type LoadedProject02CharacterOverlayConfig,
  type RuntimeConfigControlRequest,
  type RuntimeConfigFieldInspectShape,
  type RuntimeConfigFieldScope,
  RuntimeConfigConflictError,
  runtimeConfigVersion,
  inspectRuntimePluginConfig,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataMarker,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';
import {canonicalRuntimeConfigPath} from '../../src/runtime/config/path.ts';
import {
  createRuntimePlugin,
  type RuntimePluginManifest,
} from '../../src/plugins/index.ts';

function seededHome(): {
  readonly homeRoot: string;
  readonly configPath: string;
  readonly dataRoot: string;
} {
  const homeRoot = createTestTempRoot('project02-config-scope-');
  const configPath = join(homeRoot, 'config.json');

  writeRuntimeConfig(configPath, {
    project02: {userDisplayName: 'Global Name'},
  });

  return {
    homeRoot,
    configPath,
    dataRoot: characterDataDirPath(homeRoot, 'mira'),
  };
}

describe('scope-aware runtime config mutations', () => {
  it('rejects a missing bound home that becomes a symlink before the write', async () => {
    const root = createTestTempRoot('project02-config-missing-home-anchor-');
    const missingHome = join(root, 'runtime-home');
    const redirectedHome = createTestTempRoot(
      'project02-config-missing-home-redirect-',
    );

    await ensureInitializedProject02Home({homeRoot: redirectedHome});
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: bindProject02CharacterRuntimeLocation({
        configLocation: configLocationForTest({storeRoot: missingHome}),
        characterId: 'mira',
      }),
      scope: 'global',
    });

    symlinkSync(redirectedHome, missingHome);

    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target,
        request: {
          kind: 'section_field',
          namespace: 'plugins',
          declaration: requiredSecretPlugin('scope.missing-home').manifest,
          actor: 'operator',
          fieldOperation: {kind: 'set', fieldName: 'apiKey', value: 'secret'},
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
  });

  it('rejects an existing bound home replaced at the same path', async () => {
    const root = createTestTempRoot('project02-config-replaced-home-config-');
    const homeRoot = join(root, 'runtime-home');
    const displacedHome = join(root, 'runtime-home-before');

    mkdirSync(homeRoot);
    await ensureInitializedProject02Home({homeRoot});
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: bindProject02CharacterRuntimeLocation({
        configLocation: configLocationForTest({storeRoot: homeRoot}),
        characterId: 'mira',
      }),
      scope: 'global',
    });

    renameSync(homeRoot, displacedHome);
    mkdirSync(homeRoot);

    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target,
        request: {
          kind: 'section_field',
          namespace: 'plugins',
          declaration: requiredSecretPlugin('scope.replaced-home').manifest,
          actor: 'operator',
          fieldOperation: {kind: 'set', fieldName: 'apiKey', value: 'secret'},
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
  });

  it('guards the selected home separately from the authored runtime home', async () => {
    const selectedHomeRoot = createTestTempRoot(
      'project02-config-selected-owner-',
    );
    const effectiveHomeRoot = createTestTempRoot(
      'project02-config-effective-home-',
    );
    const configPath = join(selectedHomeRoot, 'config.json');

    await ensureInitializedProject02Home({homeRoot: effectiveHomeRoot});
    const effectiveConfigPath = writeRuntimeConfig(
      join(effectiveHomeRoot, 'config.json'),
      {project02: {userDisplayName: 'Effective Home'}},
    );
    writeRuntimeConfig(configPath, {
      project02: {},
    });
    writeFileSync(
      join(selectedHomeRoot, 'notes.txt'),
      'foreign selected-home content\n',
    );
    const configBefore = readFileSync(configPath, 'utf8');
    const effectiveConfigBefore = readFileSync(effectiveConfigPath, 'utf8');
    const effectiveLocksBefore = readdirSync(
      join(effectiveHomeRoot, '.locks'),
    ).sort();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: selectedHomeRoot,
      }),
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
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
    ).toThrow(/contains foreign entries/);
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(existsSync(join(selectedHomeRoot, '.locks'))).toBe(false);
    expect(readFileSync(effectiveConfigPath, 'utf8')).toBe(
      effectiveConfigBefore,
    );
    expect(readdirSync(join(effectiveHomeRoot, '.locks')).sort()).toEqual(
      effectiveLocksBefore,
    );
  });

  it('writes character-scoped fields to the overlay and only the overlay', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const globalBefore = readFileSync(configPath, 'utf8');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'character',
    });
    const result = applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Overlay Name',
        },
      },
    });

    expect(result.configPath).toBe(
      canonicalRuntimeConfigPath(characterOverlayConfigPath(dataRoot)),
    );
    expect(result.config).toEqual({
      version: runtimeConfigVersion,
      project02: {userDisplayName: 'Overlay Name'},
    });
    // R7: the overlay lock root is local to the data dir rather than
    // re-inferred from the home.
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);
    expect(existsSync(join(dataRoot, '.locks'))).toBe(true);

    const globalConfig = loadRuntimeConfigForTest({
      storeRoot: homeRoot,
    }).config;

    if (globalConfig === undefined) {
      throw new Error('Expected the global config to load.');
    }

    expect(result.fingerprint).toBe(
      createLayeredRuntimeConfigFingerprint({
        sections: {plugins: [], connectors: []},
        globalConfig,
        characterId: 'mira',
        overlay: {source: 'overlay', config: result.config},
      }),
    );
  });

  it("keeps a character's secret in its own overlay", async () => {
    const {homeRoot, dataRoot} = seededHome();
    const plugin = characterOnlyConfigPlugin('scope.secrets');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'character',
    });

    // A character's credential lands in its own overlay, never in the
    // home's document, so two characters can hold different accounts.
    applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target,
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'apiKey',
          value: 'character-value',
        },
      },
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toMatchObject({
      plugins: {
        'scope.secrets': {config: {apiKey: 'character-value'}},
      },
    });
    expect(readFileSync(join(homeRoot, 'config.json'), 'utf8')).not.toContain(
      'character-value',
    );

    // A later scoped edit validates against the merged document the
    // runtime resolves with, so the credential above satisfies a
    // required secret.
    const requiredSecretManifest = {
      ...plugin.manifest,
      config: {
        ...plugin.manifest.config,
        fields: plugin.manifest.config.fields.map(field =>
          field.name === 'apiKey' ? {...field, required: true} : field,
        ),
      },
    };

    applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target,
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: requiredSecretManifest,
        actor: 'operator',
        fieldOperation: {kind: 'set', fieldName: 'setting', value: 'tuned'},
      },
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toMatchObject({
      plugins: {'scope.secrets': {config: {setting: 'tuned'}}},
    });
  });

  it('repairs a blank character secret instead of refusing the write', async () => {
    const {homeRoot, dataRoot} = seededHome();
    const plugin = characterOnlyConfigPlugin('scope.secret-repair');
    const requiredSecretManifest = {
      ...plugin.manifest,
      config: {
        ...plugin.manifest.config,
        fields: plugin.manifest.config.fields.map(field =>
          field.name === 'apiKey' ? {...field, required: true} : field,
        ),
      },
    };

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    // The value the operator is fixing: present but blank, which the
    // resolver refuses.
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {
        'scope.secret-repair': {enabled: true, config: {apiKey: ''}},
      },
    });

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'character',
    });

    // Validation judges the document this write is about to produce, so
    // the pending value satisfies the required secret it supplies.
    applyRuntimeConfigControlOperation({
      target,
      sections: {plugins: [requiredSecretManifest], connectors: []},
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: requiredSecretManifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'apiKey',
          value: 'repaired-value',
        },
      },
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toMatchObject({
      plugins: {'scope.secret-repair': {config: {apiKey: 'repaired-value'}}},
    });
  });

  it('refuses scoped writes into an unmarked data directory', () => {
    const {homeRoot, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'character',
    });

    // The marker is proof that the guarded initializer ran.
    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'X',
          },
        },
      }),
    ).toThrow('has no identity marker');
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('enforces the layered expectation for scoped mutations', async () => {
    const {homeRoot, dataRoot} = seededHome();

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'character',
    });

    const freshExpected = applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'First',
        },
      },
    }).fingerprint;

    const committed = applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target,
      expectedFingerprint: freshExpected,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Second',
        },
      },
    });

    expect(committed.config.project02?.['userDisplayName']).toBe('Second');
    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target,
        expectedFingerprint: freshExpected,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Stale',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
  });

  it('validates scoped plugin field candidates against the merged document', async () => {
    const homeRoot = createTestTempRoot('project02-config-scope-merged-');
    const plugin = structuredConfigPlugin('scope.merged');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(homeRoot, 'mira')},
      characterId: 'mira',
    });

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      plugins: {
        'scope.merged': {
          enabled: true,
          config: {settings: {from: 'global'}, endpoints: ['global']},
        },
      },
    });

    const expected = resolveScopedExpected(homeRoot);
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'character',
    });
    const result = applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target,
      expectedFingerprint: expected,
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'overlay'},
        },
      },
    });

    expect(result.config).toEqual({
      version: runtimeConfigVersion,
      plugins: {'scope.merged': {config: {settings: {from: 'overlay'}}}},
    });

    // Without the global layer the merged candidate misses a required field.
    const bareHome = createTestTempRoot('project02-config-scope-bare-');

    writeRuntimeConfig(join(bareHome, 'config.json'), {
      plugins: {'scope.merged': {enabled: true}},
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(bareHome, 'mira')},
      characterId: 'mira',
    });
    const bareTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: bareHome}),
      scope: 'character',
    });
    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target: bareTarget,
        expectedFingerprint: resolveScopedExpected(bareHome),
        request: {
          kind: 'section_field',
          namespace: 'plugins',
          declaration: plugin.manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'set',
            fieldName: 'settings',
            value: {from: 'overlay'},
          },
        },
      }),
    ).toThrow('Cannot update section "scope.merged"');
    // A fresh overlay would move the layered fingerprint for a failed change.
    expect(
      existsSync(
        characterOverlayConfigPath(characterDataDirPath(bareHome, 'mira')),
      ),
    ).toBe(false);
  });

  it('names the overlay, owning home, and global file as the scope target', () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        characterId: 'nova',
      }),
      scope: 'character',
    });

    expect(target).toMatchObject({
      scope: 'character',
      configPath: canonicalRuntimeConfigPath(
        characterOverlayConfigPath(characterDataDirPath(homeRoot, 'nova')),
      ),
      runtimeLocation: {
        configPath,
        homeRoot: canonicalRuntimeConfigPath(homeRoot),
        characterScope: {characterId: 'nova'},
      },
    });
    expect(dataRoot).toContain('character-data');
  });

  it('rejects an overlay-only selection before resolving a target', async () => {
    const homeRoot = createTestTempRoot('project02-config-scope-owner-');
    const novaRoot = characterDataDirPath(homeRoot, 'nova');
    const novaOverlayPath = characterOverlayConfigPath(novaRoot);

    await ensureInitializedProject02Home({homeRoot});

    expect(() =>
      resolveRuntimeConfigScopeTarget({
        runtimeLocation: runtimeLocationForTest({
          configPath: novaOverlayPath,
        }),
        scope: 'character',
      }),
    ).toThrow('is inside a character-data directory');
    expect(existsSync(novaRoot)).toBe(false);
  });
});

describe('plugin manifest config scope policy', () => {
  it('warns of each value authored outside its scope and keeps it out of every effective document', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const sections = {
      plugins: [
        characterOnlyConfigPlugin('scope.character-only').manifest,
        fieldScopedConfigPlugin('scope.field-scoped').manifest,
      ],
      connectors: [],
    };

    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.character-only': {
          enabled: true,
          config: {setting: 'home', apiKey: 'secret'},
        },
        'scope.field-scoped': {
          config: {homeSetting: 'home', ownSetting: 'home'},
        },
      },
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {
        'scope.field-scoped': {
          config: {homeSetting: 'mira', ownSetting: 'mira'},
        },
      },
    });

    const homeWarnings = [
      'plugins.scope.character-only.enabled',
      'plugins.scope.character-only.config.setting',
      // Secrets included: a character-only plugin is self-contained, and
      // its credential belongs beside its overlay, not in the home config.
      'plugins.scope.character-only.config.apiKey',
      'plugins.scope.field-scoped.config.ownSetting',
    ].map(path => ({severity: 'warning', path, character: undefined}));
    const expectResolution = (
      characterId: string,
      ownSetting: object,
      warnings: readonly object[],
    ) => {
      const runtimeLocation = runtimeLocationForTest({
        storeRoot: homeRoot,
        characterId,
      });
      const {layeredConfig, resolvedConfig} =
        resolveLayeredProject02RuntimeConfigWithSnapshot({
          runtimeLocation,
          loadedConfig: loadRuntimeConfigForTest({storeRoot: homeRoot}),
          overlayConfig: readCharacterOverlayForScope(
            runtimeLocation.characterScope,
          ).overlay,
          sections,
          validateInactiveSectionConfigs: true,
        });

      expect(
        resolvedConfig.diagnostics
          .filter(
            diagnostic =>
              diagnostic.code === 'runtime_config_authored_outside_scope',
          )
          .map(diagnostic => ({
            severity: diagnostic.severity,
            path: diagnostic.path,
            character: diagnostic.origin?.characterId,
          })),
      ).toEqual(warnings);
      expect(diagnosticsHaveErrors(resolvedConfig.diagnostics)).toBe(false);
      expect(
        layeredConfig.effective.config?.plugins?.['scope.character-only']
          ?.enabled,
      ).toBeUndefined();
      expect(resolvedConfig.sectionConfigs.plugins).toMatchObject({
        'scope.character-only': {
          setting: {source: 'missing'},
          apiKey: {source: 'missing'},
        },
        'scope.field-scoped': {
          homeSetting: {source: 'config', value: 'home'},
          ownSetting,
        },
      });
    };

    // Mira has an overlay; Nova has none, and reads the same home.
    expectResolution('mira', {source: 'config', value: 'mira'}, [
      ...homeWarnings,
      {
        severity: 'warning',
        path: 'plugins.scope.field-scoped.config.homeSetting',
        character: 'mira',
      },
    ]);
    expectResolution('nova', {source: 'missing'}, homeWarnings);
  });

  it('refuses a write outside its scope, in both directions', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = fieldScopedConfigPlugin('scope.field-writes');
    const homeOnly: RuntimePluginManifest = {
      ...plugin.manifest,
      id: 'scope.home-only',
      config: {scope: 'global_only', fields: []},
    };

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const write =
      (scope: RuntimeConfigFieldScope, request: RuntimeConfigControlRequest) =>
      () =>
        applyRuntimeConfigControlOperation({
          sections: {plugins: [plugin.manifest, homeOnly], connectors: []},
          target: resolveRuntimeConfigScopeTarget({
            runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
            scope,
          }),
          request,
        });
    const setField = (fieldName: string): RuntimeConfigControlRequest => ({
      kind: 'section_field',
      namespace: 'plugins',
      declaration: plugin.manifest,
      actor: 'operator',
      fieldOperation: {kind: 'set', fieldName, value: 'misplaced'},
    });
    const globalBefore = readFileSync(configPath, 'utf8');

    expect(write('global', setField('ownSetting'))).toThrow(
      'Setting "ownSetting" of "scope.field-writes" belongs to a character',
    );
    expect(write('character', setField('homeSetting'))).toThrow(
      'Setting "homeSetting" of "scope.field-writes" belongs to the home',
    );
    expect(
      write('character', {
        kind: 'section_activation',
        namespace: 'plugins',
        declaration: homeOnly,
        enabled: true,
      }),
    ).toThrow('The switch of "scope.home-only" belongs to the home');
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(false);
  });

  it('requires of a target only what its scope can supply', () => {
    const {homeRoot, configPath} = seededHome();
    const {manifest} = requiredCharacterFieldConfigPlugin('scope.required-own');
    const sections = {plugins: [manifest], connectors: []};
    const runtimeLocation = runtimeLocationForTest({storeRoot: homeRoot});
    const diagnosticsOf = (
      overlayConfig?: LoadedProject02CharacterOverlayConfig,
    ) =>
      resolveLayeredProject02RuntimeConfig({
        runtimeLocation,
        loadedConfig: loadRuntimeConfigForTest({storeRoot: homeRoot}),
        ...(overlayConfig === undefined ? {} : {overlayConfig}),
        sections,
      }).diagnostics.map(({severity, code, path}) => ({severity, code, path}));

    applyRuntimeConfigControlOperation({
      sections,
      target: resolveRuntimeConfigScopeTarget({
        runtimeLocation,
        scope: 'global',
      }),
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'sharedSetting',
          value: 'home',
        },
      },
    });

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      plugins: {'scope.required-own': {config: {sharedSetting: 'home'}}},
    });
    // What the home's settings show: nothing missing, so nothing blocks it.
    expect(diagnosticsOf()).toEqual([]);
    expect(
      diagnosticsOf(
        readCharacterOverlayForScope(runtimeLocation.characterScope).overlay,
      ),
    ).toEqual([
      {
        severity: 'error',
        code: 'runtime_config_required_value_missing',
        path: 'plugins.scope.required-own.config.ownSetting',
      },
    ]);
  });

  it("layers a character's own secret over the home's, in the documents", async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const plugin = structuredConfigPlugin('scope.layered-secrets');
    const manifest = {
      ...plugin.manifest,
      config: {
        scope: 'global_with_character_overrides' as const,
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'apiKey',
            description: 'Account credential.',
            required: false,
            secret: true,
            valueType: 'secret' as const,
            redactionLabels: ['secret'],
          },
        ],
      },
    };
    const resolve = () => {
      const runtimeLocation = runtimeLocationForTest({
        loadedConfig: loadRuntimeConfigForTest({
          configPath,
          storeRoot: homeRoot,
        }),
        configPath,
        storeRoot: homeRoot,
      });

      return resolveLayeredProject02RuntimeConfig({
        runtimeLocation,
        loadedConfig: loadRuntimeConfigForTest({
          configPath,
          storeRoot: homeRoot,
        }),
        overlayConfig: readCharacterOverlayForScope(
          runtimeLocation.characterScope,
        ).overlay,
        sections: {plugins: [manifest], connectors: []},
      }).sectionConfigs.plugins['scope.layered-secrets']?.['apiKey'];
    };

    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.layered-secrets': {
          enabled: true,
          config: {
            settings: {from: 'global'},
            endpoints: ['global'],
            apiKey: 'operator-account',
          },
        },
      },
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {
        'scope.layered-secrets': {config: {apiKey: 'character-account'}},
      },
    });

    // The character's own value wins, the same way its overlay wins over
    // the global config for any other field.
    expect(resolve()).toMatchObject({
      resolved: true,
      value: 'character-account',
    });

    // Without one of its own, the home's fills it -- one account for
    // every character until one keeps its own.
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {});
    expect(resolve()).toMatchObject({
      resolved: true,
      value: 'operator-account',
    });
  });

  it('resolves a declared default beneath every layer, and what a layer sets over it', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const {manifest} = createRuntimePlugin({
      manifest: {
        ...requiredSecretPlugin('scope.defaulted').manifest,
        config: {
          scope: 'global_with_character_overrides',
          fields: [
            {
              name: 'mirror',
              description: 'On unless someone turns it off.',
              required: false,
              secret: false,
              valueType: 'boolean',
              defaultValue: true,
              redactionLabels: [],
            },
          ],
        },
      },
    });
    const setMirror = (path: string, mirror: boolean) => {
      writeRuntimeConfig(path, {
        plugins: {'scope.defaulted': {config: {mirror}}},
      });
    };
    const miraMirror = () => {
      const runtimeLocation = runtimeLocationForTest({storeRoot: homeRoot});

      return resolveLayeredProject02RuntimeConfig({
        runtimeLocation,
        loadedConfig: loadRuntimeConfigForTest({storeRoot: homeRoot}),
        overlayConfig: readCharacterOverlayForScope(
          runtimeLocation.characterScope,
        ).overlay,
        sections: {plugins: [manifest], connectors: []},
      }).sectionConfigs.plugins['scope.defaulted']?.['mirror'];
    };

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    expect(miraMirror()).toMatchObject({
      source: 'default',
      resolved: true,
      value: true,
    });

    setMirror(configPath, false);
    expect(miraMirror()).toMatchObject({source: 'config', value: false});

    setMirror(configPath, true);
    setMirror(characterOverlayConfigPath(dataRoot), false);
    expect(miraMirror()).toMatchObject({source: 'config', value: false});
  });

  it('inspects the host fields in the plugin field shape, per scope', async () => {
    const {homeRoot, dataRoot} = seededHome();

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {contextWindowTokens: 4096},
    });

    const loadedConfig = loadRuntimeConfigForTest({
      storeRoot: homeRoot,
    });
    const fieldsOf = (
      targetScope: 'global' | 'character',
    ): Record<string, RuntimeConfigFieldInspectShape> =>
      Object.fromEntries(
        createProject02ConfigFieldInspectShapes({
          layeredConfig: createLayeredProject02RuntimeConfigSnapshot({
            loadedConfig,
            sections: {plugins: [], connectors: []},
            ...(targetScope === 'global'
              ? {}
              : {
                  overlayConfig: readCharacterOverlayForScope({
                    characterId: 'mira',
                    dataRoot,
                  }).overlay,
                }),
          }),
          targetScope,
        }).map(field => [field.name, field]),
      );
    const character = fieldsOf('character');
    const global = fieldsOf('global');

    expect(character['contextWindowTokens']).toMatchObject({
      authored: {configured: true, value: 4096},
      effectiveSource: 'character',
      effective: {source: 'config', value: 4096},
      reloadRequired: true,
    });
    expect(character['userDisplayName']).toMatchObject({
      authored: {configured: false},
      effectiveSource: 'global',
      effective: {source: 'config', value: 'Global Name'},
    });
    expect(character['roleModelProvider']).toMatchObject({
      authored: {configured: false},
      effectiveSource: 'default',
      effective: {source: 'missing', resolved: true},
      allowedValues: ['nvidia'],
    });
    expect(global['userDisplayName']).toMatchObject({
      authored: {configured: true, value: 'Global Name'},
      effectiveSource: 'global',
    });
  });

  it('uses the same policy for manifest-aware activation and field controls', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = characterOnlyConfigPlugin('scope.character-only-control');

    writeRuntimeConfig(configPath, {
      plugins: {
        [plugin.manifest.id]: {
          config: {apiKey: 'secret'},
        },
      },
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const globalTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'global',
    });
    const characterTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'character',
    });
    const globalBefore = readFileSync(configPath, 'utf8');

    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target: globalTarget,
        request: {
          kind: 'section_activation',
          namespace: 'plugins',
          declaration: plugin.manifest,
          enabled: true,
        },
      }),
    ).toThrow('belongs to a character');
    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target: globalTarget,
        request: {
          kind: 'section_field',
          namespace: 'plugins',
          declaration: plugin.manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'set',
            fieldName: 'setting',
            value: 'global-nope',
          },
        },
      }),
    ).toThrow('belongs to a character');
    // Nor may the home clear or unset what it never owned.
    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target: globalTarget,
        request: {
          kind: 'section_activation',
          namespace: 'plugins',
          declaration: plugin.manifest,
        },
      }),
    ).toThrow('belongs to a character');
    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target: globalTarget,
        request: {
          kind: 'section_field',
          namespace: 'plugins',
          declaration: plugin.manifest,
          actor: 'operator',
          fieldOperation: {kind: 'unset', fieldName: 'apiKey'},
        },
      }),
    ).toThrow('belongs to a character');
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);

    applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target: characterTarget,
      request: {
        kind: 'section_activation',
        namespace: 'plugins',
        declaration: plugin.manifest,
        enabled: true,
      },
    });
    applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target: characterTarget,
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: plugin.manifest,
        actor: 'agent',
        fieldOperation: {
          kind: 'set',
          fieldName: 'setting',
          value: 'character-value',
        },
      },
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toEqual({
      version: runtimeConfigVersion,
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {setting: 'character-value'},
        },
      },
    });
  });
});

function resolveScopedExpected(homeRoot: string): string {
  const loaded = loadRuntimeConfigForTest({storeRoot: homeRoot});

  if (loaded.config === undefined) {
    throw new Error('Expected the seeded global config to load.');
  }

  return createLayeredRuntimeConfigFingerprint({
    sections: {plugins: [], connectors: []},
    globalConfig: loaded.config,
    characterId: 'mira',
    overlay: {source: 'none'},
  });
}

describe('character-scoped plugin control capability', () => {
  it('routes agent tool updates at the active character overlay, never the home config', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = structuredConfigPlugin('scope.capability');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.capability': {
          enabled: true,
          config: {settings: {from: 'global'}, endpoints: ['global']},
        },
      },
    });

    const characterScope = {characterId: 'mira', dataRoot};
    const capability = createRuntimePluginConfigControlCapability();
    const fingerprint = inspectRuntimePluginConfig({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        characterScope: characterScope,
      }),
      targetScope: 'character',
      namespace: 'plugins',
      declaration: plugin.manifest,
      sections: {plugins: [plugin.manifest], connectors: []},
    }).fingerprint;
    const overlayPath = characterOverlayConfigPath(dataRoot);
    const globalBefore = readFileSync(configPath, 'utf8');
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        characterScope,
      }),
      scope: 'character',
    });
    const prepared = capability.prepareOperation({
      target,
      sections: {plugins: [], connectors: []},
      expectedFingerprint: fingerprint,
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'agent'},
        },
      },
    });

    // Prepare is read-only and already names the overlay as the target.
    expect(existsSync(overlayPath)).toBe(false);
    expect(prepared.targetConfigPath).toBe(target.canonicalConfigPath);

    const applied = capability.applyOperation({
      target,
      sections: {plugins: [], connectors: []},
      expectedFingerprint: fingerprint,
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'agent'},
        },
      },
    });

    expect(applied.fingerprint).toBe(prepared.resultFingerprint);
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: runtimeConfigVersion,
      plugins: {'scope.capability': {config: {settings: {from: 'agent'}}}},
    });
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);
  });
});

describe('plugin inspection target authorship', () => {
  it('reports an inherited global field as effective but not authored in the character target', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = structuredConfigPlugin('scope.inherited-authorship');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.inherited-authorship': {
          enabled: true,
          config: {settings: {from: 'global'}},
        },
      },
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {});

    const inspected = inspectRuntimePluginConfig({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      targetScope: 'character',
      namespace: 'plugins',
      declaration: plugin.manifest,
      sections: {plugins: [plugin.manifest], connectors: []},
    });
    const settings = inspected.fields.find(field => field.name === 'settings');

    expect(settings).toMatchObject({
      authored: {configured: false},
      effectiveSource: 'global',
      effective: {
        source: 'config',
        resolved: true,
        value: {from: 'global'},
      },
    });
  });

  it('reports each target document without changing effective provenance or the layered fingerprint', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = structuredConfigPlugin('scope.authored-view');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.authored-view': {
          enabled: true,
          config: {settings: {from: 'global'}, endpoints: ['global']},
        },
      },
    });
    const base = {
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      namespace: 'plugins' as const,
      declaration: plugin.manifest,
      sections: {plugins: [plugin.manifest], connectors: []},
    };

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: base.runtimeLocation,
      scope: 'character',
    });
    applyRuntimeConfigControlOperation({
      sections: {plugins: [], connectors: []},
      target,
      expectedFingerprint: inspectRuntimePluginConfig({
        ...base,
        targetScope: 'character',
      }).fingerprint,
      request: {
        kind: 'section_field',
        namespace: 'plugins',
        declaration: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'overlay'},
        },
      },
    });
    const characterView = inspectRuntimePluginConfig({
      ...base,
      targetScope: 'character',
    });
    const globalView = inspectRuntimePluginConfig({
      ...base,
      targetScope: 'global',
    });
    const authoredSettings = (
      inspected: ReturnType<typeof inspectRuntimePluginConfig>,
    ) => inspected.fields.find(field => field.name === 'settings')?.authored;

    // Each target reports only its own authored rung.
    expect(authoredSettings(characterView)).toMatchObject({
      configured: true,
      value: {from: 'overlay'},
    });
    expect(authoredSettings(globalView)).toMatchObject({
      configured: true,
      value: {from: 'global'},
    });
    expect(
      characterView.fields.find(field => field.name === 'settings'),
    ).toMatchObject({
      effectiveSource: 'character',
      effective: {value: {from: 'overlay'}},
    });
    expect(
      globalView.fields.find(field => field.name === 'settings'),
    ).toMatchObject({
      effectiveSource: 'character',
      effective: {value: {from: 'overlay'}},
    });
    expect(globalView.fingerprint).toBe(characterView.fingerprint);
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(true);
  });

  it('lists each target only the fields it may set, sourced only from layers its scope permits', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = fieldScopedConfigPlugin('scope.field-view');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    // Each value sits only in the layer its field's scope forbids.
    writeRuntimeConfig(configPath, {
      plugins: {'scope.field-view': {config: {ownSetting: 'home'}}},
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {'scope.field-view': {config: {homeSetting: 'mira'}}},
    });

    const fieldsOf = (targetScope: RuntimeConfigFieldScope) =>
      inspectRuntimePluginConfig({
        runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
        targetScope,
        namespace: 'plugins',
        declaration: plugin.manifest,
        sections: {plugins: [plugin.manifest], connectors: []},
      }).fields.map(field => [field.name, field.effectiveSource]);

    expect(fieldsOf('global')).toEqual([
      ['sharedSetting', 'default'],
      ['homeSetting', 'default'],
    ]);
    expect(fieldsOf('character')).toEqual([
      ['sharedSetting', 'default'],
      ['ownSetting', 'default'],
    ]);
  });
});

describe('scoped writes over a broken global layer', () => {
  it('rejects the mutation instead of merging against a synthetic global document', () => {
    const homeRoot = createTestTempRoot('project02-scope-invalid-global-');

    writeFileSync(join(homeRoot, 'config.json'), '{not json\n');

    expect(() => {
      const target = resolveRuntimeConfigScopeTarget({
        runtimeLocation: runtimeLocationForTest({
          storeRoot: homeRoot,
          characterId: 'mira',
        }),
        scope: 'character',
      });
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Bob',
          },
        },
      });
    }).toThrow(/failed to load/);
    expect(
      existsSync(
        characterOverlayConfigPath(characterDataDirPath(homeRoot, 'mira')),
      ),
    ).toBe(false);
  });
});

describe('stale global expectations', () => {
  it('conflicts without materializing a lock root in an absent data dir', () => {
    const {homeRoot, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot}),
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        sections: {plugins: [], connectors: []},
        target,
        expectedFingerprint: 'stale-fingerprint',
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Bob',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
    // Not even the per-character lock root.
    expect(existsSync(dataRoot)).toBe(false);
  });
});
