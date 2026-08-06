import {describe, expect, it} from 'vitest';
import {
  createRuntimePluginHost,
  runRuntimePluginSessionEndHooks,
} from '../../src/plugins/host/index.ts';
import {
  createRuntimePluginRegistrySnapshot,
  type RuntimePluginFileStore,
} from '../../src/plugins/api/index.ts';
import {runtimePluginAccessForPlugin} from '../../src/plugins/policy/access-control.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {
  callFileStoreAvailabilityProbe,
  createDegradableMemorySearchPlugin,
  createExplicitlyEnabledRuntimePluginHost,
  createFileStoreAvailabilityProbePlugin,
  createInputSnapshotProbePlugin,
  createMemorySearchPlugin,
  createPluginHostTestFileStore,
  createReadOnlyBeforeRoleModelFileStoreProbePlugin,
  createReadOnlyFileStoreProbePlugin,
  createRetainedBeforeRoleModelFileStorePlugin,
  createRetainedHandleToolCallFileStorePlugin,
  createRetainedHealthFileStorePlugin,
  createSessionEndFileStoreProbePlugin,
  createStagedAppendFileStorePlugin,
  expectRetainedFileStoreWriteBlocked,
  testIdentity,
  testRuntimePluginFileStoreProvider,
  testPluginAfterTurnCommittedContext,
  testPluginContext,
} from '../support/plugin-host-fixtures.ts';

describe('runtime plugin host access and lifecycle', () => {
  it('fails at construction when a file_store plugin is enabled without a provider', () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'filestore.no-provider.fixture',
      requestedAccess: {file_store: 'read', model_input: 'write'},
    });

    expect(() =>
      createRuntimePluginHost({
        plugins: [plugin],
        enabledPluginIds: [plugin.manifest.id],
      }),
    ).toThrow('created without a file-store provider');
    expect(() =>
      createRuntimePluginHost({
        plugins: [plugin],
        enabledPluginIds: [plugin.manifest.id],
        fileStore: testRuntimePluginFileStoreProvider,
      }),
    ).not.toThrow();
    expect(() => createRuntimePluginHost({plugins: []})).not.toThrow();
  });

  it('treats a missing own access entry for a prototype-named plugin as absent', () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'constructor',
      requestedAccess: {file_store: 'read', model_input: 'write'},
    });

    expect(() =>
      runtimePluginAccessForPlugin({
        plugin,
        accessByPluginId: {},
      }),
    ).toThrow('Plugin "constructor" is missing resolved access.');

    const registry = createRuntimePluginRegistrySnapshot([plugin], {
      accessByPluginId: {},
    });

    expect(registry.plugins[0]?.grantedAccess).toEqual({});
  });

  it('rejects duplicate plugin ids before standalone session-end API permission injection', async () => {
    const pluginId = 'memory.duplicate-session-end.fixture';
    const invokedPlugins: string[] = [];
    const deniedPlugin = createSessionEndFileStoreProbePlugin({
      pluginId,
      requestedAccess: {},
      onSessionEnd(context) {
        invokedPlugins.push(
          context.fileStore === undefined
            ? 'denied:no_file_store'
            : 'denied:file_store',
        );
      },
    });
    const grantedPlugin = createSessionEndFileStoreProbePlugin({
      pluginId,
      requestedAccess: {file_store: 'write'},
      onSessionEnd(context) {
        invokedPlugins.push(
          context.fileStore === undefined
            ? 'granted:no_file_store'
            : 'granted:file_store',
        );
        context.fileStore?.writeJsonAtomic('duplicate-session-end.json', {
          value: 'unexpected',
        });
      },
    });

    await expect(
      runRuntimePluginSessionEndHooks({
        plugins: [deniedPlugin, grantedPlugin],
        context: testPluginContext(),
        hookOptions: {
          allowFileStoreWrites: true,
        },
      }),
    ).rejects.toThrow(
      /Duplicate plugin id "memory\.duplicate-session-end\.fixture" is not allowed/iu,
    );
    expect(invokedPlugins).toEqual([]);
  });

  it('uses captured access grants for host session-end hooks', async () => {
    const sessionIdentity = {};
    let sawFileStore = false;
    const plugin = createSessionEndFileStoreProbePlugin({
      pluginId: 'memory.session-end-mutated-policy.fixture',
      requestedAccess: {file_store: 'write'},
      onSessionEnd(context) {
        sawFileStore = context.fileStore !== undefined;
        context.fileStore?.writeJsonAtomic('mutated-policy-session-end.json', {
          value: 'unexpected',
        });
      },
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });

    const result = await host.onSessionEnd(testPluginContext());
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });

    expect(result.status).toBe('completed');
    expect(sawFileStore).toBe(true);
    expect(fileStore.readJson('mutated-policy-session-end.json')).toEqual({
      value: 'unexpected',
    });
    expect(fileStore.revision()).toBe(1);
  });

  it('does not trust manifest-declared first_party for default sensitive access', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.fake-first-party.fixture',
      firstParty: true,
      requestedAccess: {file_store: 'read', model_input: 'write'},
    });
    const host = createRuntimePluginHost({plugins: [plugin]});

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled',
    });
  });

  it('denies non-first-party plugins by default', async () => {
    const trustedAdapter = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.trusted-adapter-denied.fixture',
      firstParty: false,
      requestedAccess: {file_store: 'read', model_input: 'write'},
    });
    const testFixture = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.test-fixture-denied.fixture',
      firstParty: false,
      requestedAccess: {file_store: 'read', model_input: 'write'},
    });
    const trustedAdapterHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      plugins: [trustedAdapter],
    });
    const testFixtureHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      plugins: [testFixture],
    });

    await expect(
      callFileStoreAvailabilityProbe(trustedAdapterHost, trustedAdapter),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled',
    });
    await expect(
      callFileStoreAvailabilityProbe(testFixtureHost, testFixture),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled',
    });
  });

  it('injects fileStore for an explicitly enabled non-built-in plugin that declares it', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.file-store-allowed.fixture',
      requestedAccess: {file_store: 'read', model_input: 'write'},
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
    });

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: true,
      },
    });
  });

  it('replaces caller-provided fileStore with the plugin-scoped store when file_store read is granted', async () => {
    const sessionIdentity = {};
    const plugin = createReadOnlyFileStoreProbePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const scopedFileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });
    const inheritedFileStore = createPluginHostTestFileStore({
      pluginId: 'memory.inherited-file-store.fixture',
      sessionIdentity,
    });

    scopedFileStore.writeJsonAtomic('seed.json', {
      value: 'scoped',
    });
    inheritedFileStore.writeJsonAtomic('seed.json', {
      value: 'inherited',
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      {
        ...testPluginContext(),
        fileStore: inheritedFileStore,
      },
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected read-only fileStore probe to be accepted.');
    }

    expect(result.output).toEqual({
      seed: {
        value: 'scoped',
      },
      writeBlocked: true,
    });
    expect(scopedFileStore.readJson('read-only-write.json')).toBeUndefined();
    expect(inheritedFileStore.readJson('read-only-write.json')).toBeUndefined();
  });

  it('allows explicitly enabled Character State file_store write access', async () => {
    const plugin = createCharacterStatePlugin();
    const host = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      plugins: [plugin],
      enabledPluginIds: [characterStatePluginId],
    });
    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error(
        'Expected Character State beforeRoleModelCall to complete.',
      );
    }
    expect(result.contextItems).toHaveLength(1);
  });

  it('withholds Character State default file_store access from an id-spoofed plugin', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: characterStatePluginId,
      requestedAccess: {file_store: 'read', model_input: 'write'},
      firstParty: true,
    });
    const host = createRuntimePluginHost({plugins: [plugin]});

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled',
    });
  });

  it('withholds fileStore writes from read-only handleToolCall tools', async () => {
    const sessionIdentity = {};
    const plugin = createReadOnlyFileStoreProbePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });
    const registration = host
      .registrySnapshot()
      .plugins.find(item => item.manifest.id === plugin.manifest.id);

    fileStore.writeJsonAtomic('seed.json', {
      value: 'existing',
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected read-only fileStore probe to be accepted.');
    }
    expect(registration).toMatchObject({
      requestedAccess: {file_store: 'read', model_input: 'write'},
      grantedAccess: {file_store: 'read', model_input: 'write'},
    });
    expect(result.output).toEqual({
      seed: {
        value: 'existing',
      },
      writeBlocked: true,
    });
    expect(fileStore.readJson('read-only-write.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('withholds fileStore writes from read-only hook contexts', async () => {
    const sessionIdentity = {};
    const plugin = createReadOnlyBeforeRoleModelFileStoreProbePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });

    fileStore.writeJsonAtomic('seed.json', {
      value: 'existing',
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected read-only hook probe to complete.');
    }

    expect(result.contextItems[0]?.text).toBe(
      '{"seed":{"value":"existing"},"writeBlocked":true}',
    );
    expect(fileStore.readJson('read-only-hook-write.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('blocks retained fileStore writes after beforeRoleModelCall completes', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedBeforeRoleModelFileStorePlugin(fileStore => {
      retainedFileStore = fileStore;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    expectRetainedFileStoreWriteBlocked(retainedFileStore, 'after-before.json');

    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });

    expect(fileStore.readJson('during-before.json')).toEqual({value: 'during'});
    expect(fileStore.readJson('after-before.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('writes during handleToolCall and blocks retained fileStore writes after completion', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedHandleToolCallFileStorePlugin(fileStore => {
      retainedFileStore = fileStore;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const registration = host
      .registrySnapshot()
      .plugins.find(item => item.manifest.id === plugin.manifest.id);

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      testPluginContext(),
    );
    expect(registration).toMatchObject({
      requestedAccess: {file_store: 'write', model_input: 'write'},
      grantedAccess: {file_store: 'write', model_input: 'write'},
    });
    expect(result.status).toBe('accepted');
    expectRetainedFileStoreWriteBlocked(retainedFileStore, 'after-handle.json');

    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });

    expect(fileStore.readJson('during-handle.json')).toEqual({value: 'during'});
    expect(fileStore.readJson('after-handle.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);

    const afterCommitResult = await host.afterTurnCommitted(
      testPluginAfterTurnCommittedContext(),
    );

    expect(afterCommitResult.status).toBe('completed');
    expect(fileStore.readJson('during-handle.json')).toEqual({value: 'during'});
    expect(fileStore.revision()).toBe(1);
  });

  it('keeps immediate handleToolCall fileStore writes for a later rejected turn context', async () => {
    const sessionIdentity = {};
    const plugin = createStagedAppendFileStorePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const context = testPluginContext();
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'rejected',
        },
      },
      context,
    );

    expect(result.status).toBe('accepted');

    const afterCommitResult = await host.afterTurnCommitted(
      testPluginAfterTurnCommittedContext(),
    );

    expect(afterCommitResult.status).toBe('completed');
    expect(fileStore.readJsonl('events.jsonl')).toEqual([
      {
        value: 'rejected',
        traceId: context.traceId,
      },
    ]);
    expect(fileStore.revision()).toBe(1);
  });

  it('records immediate handleToolCall fileStore writes for same-turn retries', async () => {
    const sessionIdentity = {};
    const plugin = createStagedAppendFileStorePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const rejectedContext = testPluginContext({
      eventId: 'evt_same_turn_retry',
      traceId: 'trace_rejected_attempt',
    });
    const retryContext = testPluginContext({
      eventId: 'evt_same_turn_retry',
      traceId: 'trace_retry_attempt',
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });

    await host.handleToolCall(
      {
        ...testIdentity({
          eventId: 'evt_same_turn_retry',
          traceId: 'trace_rejected_attempt',
        }),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'rejected-attempt',
        },
      },
      rejectedContext,
    );
    await host.handleToolCall(
      {
        ...testIdentity({
          eventId: 'evt_same_turn_retry',
          traceId: 'trace_retry_attempt',
        }),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'retry-attempt',
        },
      },
      retryContext,
    );

    expect(fileStore.readJsonl('events.jsonl')).toEqual([
      {
        value: 'rejected-attempt',
        traceId: 'trace_rejected_attempt',
      },
      {
        value: 'retry-attempt',
        traceId: 'trace_retry_attempt',
      },
    ]);
    expect(fileStore.revision()).toBe(2);
  });

  it('blocks retained fileStore writes after health completes', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedHealthFileStorePlugin(fileStore => {
      retainedFileStore = fileStore;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });

    const result = await host.health(testPluginContext());

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      pluginId: plugin.manifest.id,
      status: 'ok',
    });
    expectRetainedFileStoreWriteBlocked(retainedFileStore, 'after-health.json');

    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity,
    });

    expect(fileStore.readJson('during-health.json')).toEqual({value: 'during'});
    expect(fileStore.readJson('after-health.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('rejects plugin-host-owned invalid input before invoking the handler', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {},
      },
      testPluginContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_input',
      message: 'memory.search input missing required field "query".',
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      policyOutcome: 'handler_rejected',
    });
  });

  it('names the expected type in plugin-host-owned input rejections', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {query: 5},
      },
      testPluginContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_input',
      message: 'memory.search input field "query" must be string.',
    });
  });

  it('dispatches the validated JSON snapshot, not the proposed input', async () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    const plugin = createInputSnapshotProbePlugin(input => {
      received = input;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.score',
        input: {score: Number.POSITIVE_INFINITY},
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    expect(received).toEqual({score: null});
    expect(Object.isFrozen(received)).toBe(true);
  });

  it('honors optional degrade policy for plugin-host-owned invalid input', async () => {
    let handledCalls = 0;
    const plugin = createDegradableMemorySearchPlugin(() => {
      handledCalls += 1;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {},
      },
      testPluginContext(),
    );

    expect(handledCalls).toBe(0);
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_input',
      message: 'memory.search input missing required field "query".',
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded',
    });
  });
});
