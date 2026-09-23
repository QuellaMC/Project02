import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  prepareConfiguredProject02PluginActivation,
} from '../../src/app/index.ts';
import {
  createRuntimePlugin,
  runtimePluginId,
  type RuntimePluginContext,
} from '../../src/plugins/index.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {
  checkRuntimeConfigForTest,
  writeRuntimeConfig,
  runtimeConfigSnapshotForTest,
  loadRuntimeConfigForTest,
} from '../support/runtime-config.ts';
import {
  enabledNonHostScopedActivationPlugins,
  fileStoreSessionEndPlugin,
  firstPartyPlugin,
  modelFacingMemorySearchPlugin,
  modelFacingPluginListCollisionPlugin,
  pluginWithAdditionalConfigField,
  requiredSecretPlugin,
  sessionEndPlugin,
} from '../support/runtime-config-activation-fixtures.ts';
import {initializeCharacterDataForHost} from '../support/runtime-config-fixtures.ts';

describe('runtime config activation checks and construction', () => {
  it('reports host-owned default access during check for the default Character State factory', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-default-factory-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const output = await checkRuntimeConfigForTest({
      storeRoot,
    });

    expect(output.ok).toBe(true);
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {
          character_file_store: 'write',
          model_input: 'write',
          trusted_context: 'write',
        },
        grantedAccess: {
          character_file_store: 'write',
          model_input: 'write',
          trusted_context: 'write',
        },
      }),
    );
  });

  it('applies package-authored Character State enablement to caller-supplied factories during check', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-real-factory-',
    );
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const output = await checkRuntimeConfigForTest({
      storeRoot,
      factories: {
        [characterStatePluginId]: {
          manifest: createCharacterStatePluginManifest(),
          create() {
            factoryCalls += 1;

            return createCharacterStatePlugin();
          },
        },
      },
    });

    expect(output.ok).toBe(true);
    expect(factoryCalls).toBe(0);
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {
          character_file_store: 'write',
          model_input: 'write',
          trusted_context: 'write',
        },
        // A caller-supplied factory displaces the bundled package, so its
        // provenance no longer clears it for the trusted frames.
        grantedAccess: {
          character_file_store: 'write',
          model_input: 'write',
        },
      }),
    );
  });

  it('applies package-authored Character State enablement to exact manifest matches', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-exact-manifest-',
    );
    const builtInPlugin = createCharacterStatePlugin();
    const plugin = createRuntimePlugin({
      manifest: builtInPlugin.manifest,
      providedTools: builtInPlugin.providedTools,
      lifecycleHooks: builtInPlugin.lifecycleHooks,
    });
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const output = await checkRuntimeConfigForTest({
      storeRoot,
      factories: {
        [characterStatePluginId]: {
          manifest: createCharacterStatePluginManifest(),
          create() {
            factoryCalls += 1;

            return plugin;
          },
        },
      },
    });

    expect(output.ok).toBe(true);
    expect(factoryCalls).toBe(0);
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {
          character_file_store: 'write',
          model_input: 'write',
          trusted_context: 'write',
        },
        // A caller-supplied factory displaces the bundled package, so its
        // provenance no longer clears it for the trusted frames.
        grantedAccess: {
          character_file_store: 'write',
          model_input: 'write',
        },
      }),
    );
  });

  it('applies package-authored enablement by stable plugin id to injected manifests', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-spoof-',
    );
    const plugin = fileStoreSessionEndPlugin(characterStatePluginId, () => {});
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const output = await checkRuntimeConfigForTest({
      storeRoot,
      factories: {
        [characterStatePluginId]: {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;

            return plugin;
          },
        },
      },
    });

    expect(output.ok).toBe(true);
    expect(factoryCalls).toBe(0);
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {file_store: 'write'},
        grantedAccess: {file_store: 'write'},
      }),
    );
  });

  it('keeps unselected memory providers passing check', async () => {
    const storeRoot = createTestTempRoot('project02-config-memory-unselected-');
    const selectedPlugin = requiredSecretPlugin('memory.selected');
    const unselectedPlugin = requiredSecretPlugin('memory.unselected');
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.selected',
      plugins: {
        'memory.selected': {
          enabled: true,
          config: {
            apiKey: 'selected-memory-secret',
          },
        },
      },
    });

    const output = await checkRuntimeConfigForTest({
      storeRoot,
      factories: {
        'memory.selected': {
          manifest: selectedPlugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error(
              'runtime-config check must not construct factories',
            );
          },
        },
        'memory.unselected': {
          manifest: unselectedPlugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error(
              'unselected memory provider check must not construct factories',
            );
          },
        },
      },
    });

    expect(output.ok).toBe(true);
    expect(factoryCalls).toBe(0);
    expect(
      enabledNonHostScopedActivationPlugins(output).filter(plugin =>
        plugin.pluginId.startsWith('memory.'),
      ),
    ).toEqual([
      expect.objectContaining({
        pluginId: 'memory.selected',
      }),
    ]);
    expect(
      output.plugins
        .filter(plugin => plugin.pluginId === 'memory.unselected')
        .map(plugin => plugin.activationStatus),
    ).toEqual(['disabled']);
  });

  it('keeps a factory claiming the host management id out of the catalog', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-reserved-management-id-',
    );
    const plugin = firstPartyPlugin(runtimePluginId);
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [runtimePluginId]: {
          enabled: true,
        },
      },
    });

    const output = await checkRuntimeConfigForTest({
      storeRoot,
      factories: {
        'fixture.discovery-collision': {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('reserved id check must not construct factories');
          },
        },
      },
    });

    expect(output.ok).toBe(true);
    expect(factoryCalls).toBe(0);
    expect(
      output.plugins.filter(plugin => plugin.pluginId === runtimePluginId),
    ).toEqual([
      expect.objectContaining({
        pluginId: runtimePluginId,
        activationStatus: 'active',
        enabled: true,
      }),
    ]);
  });

  it('rejects manifest-backed factories that return a different same-id manifest', async () => {
    const storeRoot = createTestTempRoot('project02-config-manifest-mismatch-');
    const configPath = join(storeRoot, 'config.json');
    let cleanupCalls = 0;
    const cleanupPlugin = sessionEndPlugin('first.cleanup', () => {
      cleanupCalls += 1;
    });
    const declaredPlugin = requiredSecretPlugin('memory.contract');
    const returnedPlugin = pluginWithAdditionalConfigField('memory.contract');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        'memory.contract': {
          enabled: true,
          config: {
            apiKey: 'same-id-different-manifest-secret',
          },
        },
      },
    });

    const loadedConfig = loadRuntimeConfigForTest({configPath});

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadedConfig,
            storeRoot,
            factories: {
              [cleanupPlugin.manifest.id]: {
                manifest: cleanupPlugin.manifest,
                create: () => cleanupPlugin,
              },
              'memory.contract': {
                manifest: declaredPlugin.manifest,
                create: () => returnedPlugin,
              },
            },
          }),
        }),
      }),
    ).rejects.toThrow(
      'Runtime plugin package "memory.contract" factory returned a different manifest.',
    );
    expect(cleanupCalls).toBe(1);
  });

  it('cleans rejected factory candidates under catalog identity and access', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-candidate-identity-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const catalogPlugin = firstPartyPlugin('catalog.authorized');
    const cleanupContexts: RuntimePluginContext[] = [];
    const driftedCandidate = fileStoreSessionEndPlugin(
      'candidate.drifted',
      context => {
        cleanupContexts.push(context);
      },
    );

    writeRuntimeConfig(configPath, {
      plugins: {
        [catalogPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadRuntimeConfigForTest({configPath}),
            storeRoot,
            factories: {
              [catalogPlugin.manifest.id]: {
                manifest: catalogPlugin.manifest,
                create: () => driftedCandidate,
              },
            },
          }),
        }),
      }),
    ).rejects.toThrow(
      'Runtime plugin package "catalog.authorized" factory returned a different manifest.',
    );

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      pluginId: catalogPlugin.manifest.id,
    });
    expect(cleanupContexts[0]?.fileStore).toBeUndefined();
  });

  it('closes already-created plugins when a later manifest-backed factory throws', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-factory-throw-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupPlugin = sessionEndPlugin('first.cleanup', context => {
      cleanupContexts.push(context);
    });
    const failingPlugin = firstPartyPlugin('later.failure');
    const sessionId = 'factory-throw-cleanup-session';

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const loadedConfig = loadRuntimeConfigForTest({configPath});

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadedConfig,
            storeRoot: storeRoot,
            factories: {
              [cleanupPlugin.manifest.id]: {
                manifest: cleanupPlugin.manifest,
                create: () => cleanupPlugin,
              },
              [failingPlugin.manifest.id]: {
                manifest: failingPlugin.manifest,
                create: () => {
                  throw new Error('later manifest-backed factory failed');
                },
              },
            },
          }),
        }),
        sessionId,
      }),
    ).rejects.toThrow('later manifest-backed factory failed');

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId,
      currentUserMessage: '',
      privacy: {
        exposePrivateConfig: false,
      },
    });
    expect(cleanupContexts[0]?.currentUserMessage).not.toContain(
      'later manifest-backed factory failed',
    );
  });

  it('keeps construction-failure cleanup read-only by default', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-factory-readonly-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        cleanupContexts.push(context);

        if (context.fileStore === undefined) {
          throw new Error(
            'Expected construction cleanup context to include fileStore.',
          );
        }

        try {
          context.fileStore.writeJsonAtomic('cleanup.json', {
            value: 'should-not-write',
          });
          cleanupWriteBlocked.push(false);
        } catch {
          cleanupWriteBlocked.push(true);
        }
      },
    );
    const failingPlugin = firstPartyPlugin('later.failure');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadRuntimeConfigForTest({configPath}),
            storeRoot: storeRoot,
            factories: {
              [cleanupPlugin.manifest.id]: {
                manifest: cleanupPlugin.manifest,
                create: () => cleanupPlugin,
              },
              [failingPlugin.manifest.id]: {
                manifest: failingPlugin.manifest,
                create: () => {
                  throw new Error('later manifest-backed factory failed');
                },
              },
            },
          }),
        }),
      }),
    ).rejects.toThrow('later manifest-backed factory failed');

    const cleanupContext = cleanupContexts[0];

    if (cleanupContext === undefined) {
      throw new Error('Expected construction cleanup to run.');
    }

    const cleanupStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: cleanupContext.sessionId,
      pluginId: cleanupPlugin.manifest.id,
    });

    expect(cleanupContext).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: '',
    });
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(cleanupStore.readJson('cleanup.json')).toBeUndefined();
  });

  it('uses the configured store root for construction-failure cleanup file-store reads', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-factory-durable-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const sessionId = 'configured-plugin-durable-construction-cleanup';
    const cleanupReads: unknown[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        if (context.fileStore === undefined) {
          throw new Error(
            'Expected construction cleanup context to include fileStore.',
          );
        }

        cleanupReads.push(context.fileStore.readJson('state.json'));
      },
    );
    const failingPlugin = firstPartyPlugin('later.failure');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadRuntimeConfigForTest({configPath}),
            storeRoot: storeRoot,
            factories: {
              [cleanupPlugin.manifest.id]: {
                manifest: cleanupPlugin.manifest,
                create: input => {
                  createRuntimePluginFileStore({
                    storeRoot: input.storeRoot,
                    sessionId,
                    pluginId: cleanupPlugin.manifest.id,
                  }).writeJsonAtomic('state.json', {
                    value: 'durable construction state',
                  });

                  return cleanupPlugin;
                },
              },
              [failingPlugin.manifest.id]: {
                manifest: failingPlugin.manifest,
                create: () => {
                  throw new Error('later manifest-backed factory failed');
                },
              },
            },
          }),
        }),
        sessionId,
      }),
    ).rejects.toThrow('later manifest-backed factory failed');

    expect(cleanupReads).toEqual([
      {
        value: 'durable construction state',
      },
    ]);
  });

  it('fails closed on an unusable store before any factory or cleanup runs', () => {
    const configRoot = createTestTempRoot(
      'project02-config-factory-invalid-store-cleanup-',
    );
    const invalidStoreRoot = join(configRoot, 'store-root-file');
    const configPath = join(configRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        cleanupContexts.push(context);
      },
    );
    const failingPlugin = firstPartyPlugin('later.failure');
    let factoryCalls = 0;

    writeFileSync(invalidStoreRoot, 'not a runtime store directory\n', 'utf8');
    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    // Bound-home admission rejects before any factory constructs against it.
    expect(() =>
      prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({
            configPath,
            storeRoot: invalidStoreRoot,
          }),
          factories: {
            [cleanupPlugin.manifest.id]: {
              manifest: cleanupPlugin.manifest,
              create: () => {
                factoryCalls += 1;
                return cleanupPlugin;
              },
            },
            [failingPlugin.manifest.id]: {
              manifest: failingPlugin.manifest,
              create: () => {
                factoryCalls += 1;
                throw new Error(
                  'later manifest-backed factory failed with unusable store',
                );
              },
            },
          },
        }),
      }),
    ).toThrow('Could not inspect local runtime storage schema marker');

    expect(factoryCalls).toBe(0);
    expect(cleanupContexts).toHaveLength(0);
  });

  it('cleans up created plugins when host construction fails after factories succeed', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-host-throw-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        cleanupContexts.push(context);

        if (context.fileStore === undefined) {
          throw new Error(
            'Expected host cleanup context to include fileStore.',
          );
        }

        try {
          context.fileStore.writeJsonAtomic('cleanup.json', {
            value: 'should-not-write',
          });
          cleanupWriteBlocked.push(false);
        } catch {
          cleanupWriteBlocked.push(true);
        }
      },
    );
    const firstToolPlugin = modelFacingMemorySearchPlugin('memory.first');
    const secondToolPlugin = modelFacingMemorySearchPlugin('memory.second');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [firstToolPlugin.manifest.id]: {
          enabled: true,
        },
        [secondToolPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadRuntimeConfigForTest({configPath}),
            storeRoot: storeRoot,
            factories: {
              [cleanupPlugin.manifest.id]: {
                manifest: cleanupPlugin.manifest,
                create: () => cleanupPlugin,
              },
              [firstToolPlugin.manifest.id]: {
                manifest: firstToolPlugin.manifest,
                create: () => firstToolPlugin,
              },
              [secondToolPlugin.manifest.id]: {
                manifest: secondToolPlugin.manifest,
                create: () => secondToolPlugin,
              },
            },
          }),
        }),
      }),
    ).rejects.toThrow(/declared more than once/iu);

    const cleanupContext = cleanupContexts[0];

    if (cleanupContext === undefined) {
      throw new Error('Expected host construction cleanup to run.');
    }

    const cleanupStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: cleanupContext.sessionId,
      pluginId: cleanupPlugin.manifest.id,
    });

    expect(cleanupContext).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: '',
    });
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(cleanupStore.readJson('cleanup.json')).toBeUndefined();
  });

  it('runs cleanup for partial plugins that collide with host runtime.plugin.list', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-plugin-list-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const collisionPlugin = modelFacingPluginListCollisionPlugin(
      'plugin-list.cleanup-collision',
      context => {
        cleanupContexts.push(context);
        throw new Error('cleanup hook failure must not mask host construction');
      },
    );

    writeRuntimeConfig(configPath, {
      plugins: {
        [collisionPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadRuntimeConfigForTest({configPath}),
            storeRoot: storeRoot,
            factories: {
              [collisionPlugin.manifest.id]: {
                manifest: collisionPlugin.manifest,
                create: () => collisionPlugin,
              },
            },
          }),
        }),
      }),
    ).rejects.toThrow(
      'Plugin tool "runtime.plugin.list" is declared more than once.',
    );

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: '',
      pluginId: collisionPlugin.manifest.id,
    });
  });

  it('accepts manifest-backed factories that return their declared manifest', async () => {
    const storeRoot = createTestTempRoot('project02-config-manifest-match-');
    const configPath = join(storeRoot, 'config.json');
    const plugin = requiredSecretPlugin('memory.contract');
    let factoryCalls = 0;

    writeRuntimeConfig(configPath, {
      plugins: {
        'memory.contract': {
          enabled: true,
          config: {
            apiKey: 'same-id-matching-manifest-secret',
          },
        },
      },
    });

    const loadedConfig = loadRuntimeConfigForTest({configPath});
    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadedConfig,
          storeRoot,
          factories: {
            'memory.contract': {
              manifest: plugin.manifest,
              create: () => {
                factoryCalls += 1;

                return plugin;
              },
            },
          },
        }),
      }),
    });

    expect(factoryCalls).toBe(1);
    expect(configured.plugins.map(item => item.manifest.id)).toEqual([
      'memory.contract',
    ]);
  });
});
