import {describe, expect, it} from 'vitest';
import {
  createRuntimePlugin,
  createRuntimePluginAfterTurnCommittedContext,
} from '../../src/plugins/api/index.ts';
import {
  defaultRuntimePluginHostServiceCatalogEntries,
  hostFirstPartyRuntimePluginIds,
} from '../../src/plugins/host/catalog.ts';
import {
  firstPartyModelToolsPluginId,
  runtimePluginId,
  runtimePluginListToolName,
} from '../../src/plugins/api/contract.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {visibleReplyModelToolName} from '../../src/role-model/index.ts';
import {characterStatePatchModelToolName} from '../../src/plugins/api/contract.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {createRuntimePluginManagementPlugin} from '../../src/plugins/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {
  callFileStoreAvailabilityProbe,
  createConfirmationRequiredMemorySearchPlugin,
  createDeferred,
  createExplicitlyEnabledRuntimePluginHost,
  createExternalReadMemorySearchPlugin,
  createFileStoreAvailabilityProbePlugin,
  createLateFileStoreWritePlugin,
  createLocalMemoryWriteToolWithoutFileStorePlugin,
  createMemorySearchPlugin,
  createMemorySearchPluginWithInvocationProbe,
  createMemorySearchToolProviderOnlyPlugin,
  createModelFacingToolWithoutModelInputPlugin,
  createPluginHostTestFileStore,
  createRuntimeNotesWithoutModelInputPlugin,
  createTurnContextCapturePlugin,
  memorySearchPluginManifest,
  memorySearchProvidedTools,
  pluginDiscoveryPluginSummaries,
  pluginDiscoveryToolNames,
  testIdentity,
  testPluginContext,
  testRuntimePluginConfigControlCapability,
} from '../support/plugin-host-fixtures.ts';
import type {
  LateFileStoreWriteOutcome,
  TurnContextCapture,
} from '../support/plugin-host-fixtures.ts';

describe('runtime plugin host catalog and routing', () => {
  it('treats an explicit enabled-plugin list as authoritative', () => {
    const host = createRuntimePluginHost({enabledPluginIds: []});

    expect(host.enabledPluginIds()).toEqual([]);
    expect(host.pluginToolDefinitions()).toEqual([]);
  });

  it('rejects caller-supplied host-scoped plugin instances', () => {
    const callerManagement = createRuntimePluginManagementPlugin({
      hostStateForTurn: () => ({
        plugins: Object.freeze([]),
        enabledPlugins: Object.freeze([]),
        accessByPluginId: Object.freeze({}),
        confirmationAvailable: false,
      }),
    });

    expect(() =>
      createRuntimePluginHost({
        plugins: [callerManagement],
      }),
    ).toThrow(
      'Plugin "runtime.plugin" is host-owned and cannot be supplied by callers.',
    );
  });

  it('fails at construction when config-control state lacks its control capability', () => {
    expect(() =>
      createRuntimePluginHost({pluginConfigControl: {pluginManifests: []}}),
    ).toThrow('without its host config-control capability');
    expect(() =>
      createRuntimePluginManagementPlugin({
        hostStateForTurn: () => ({
          plugins: Object.freeze([]),
          enabledPlugins: Object.freeze([]),
          accessByPluginId: Object.freeze({}),
          confirmationAvailable: false,
        }),
        pluginConfigControl: {pluginManifests: []},
      }),
    ).toThrow('without its host config-control capability');
    expect(() =>
      createRuntimePluginHost({
        pluginConfigControl: {
          control: testRuntimePluginConfigControlCapability,
          pluginManifests: [],
        },
      }),
    ).not.toThrow();
    expect(() =>
      createRuntimePluginHost({pluginInventoryState: {pluginManifests: []}}),
    ).not.toThrow();
  });

  it('keeps real bootstrap constructors separate from ordinary package loaders', () => {
    const catalog = defaultRuntimePluginHostServiceCatalogEntries();

    expect([...hostFirstPartyRuntimePluginIds]).toEqual([
      runtimePluginId,
      firstPartyModelToolsPluginId,
      characterStatePluginId,
    ]);
    expect(Object.keys(catalog).sort()).toEqual(
      [runtimePluginId, firstPartyModelToolsPluginId].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(Object.values(catalog)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          catalogKind: 'host_service',
        }),
      ]),
    );
    expect(
      Object.values(catalog).every(
        entry => typeof entry.bootstrap === 'function',
      ),
    ).toBe(true);
    expect(Object.values(catalog).every(entry => !('create' in entry))).toBe(
      true,
    );
  });

  it('routes runtime.plugin.list through the host-owned management plugin', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        plugin.manifest.id,
      ],
    });
    const context = testPluginContext();

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {},
      },
      context,
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected runtime.plugin.list to be accepted.');
    }

    expect(result.output).toMatchObject({
      plugins: [
        {
          id: runtimePluginId,
        },
        {
          id: firstPartyModelToolsPluginId,
        },
        {
          id: 'memory.search.fixture',
        },
      ],
    });
  });

  it('advertises the same model-facing tools that the host exposes', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {},
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected runtime.plugin.list to be accepted.');
    }

    const exposedToolNames = Object.freeze(
      host
        .pluginToolDefinitions()
        .map(tool => tool.name)
        .sort((left, right) => left.localeCompare(right)),
    );

    expect(pluginDiscoveryToolNames(result.output)).toEqual(exposedToolNames);
    expect(exposedToolNames).toEqual(
      expect.arrayContaining([runtimePluginListToolName, 'memory.search']),
    );
  });

  it.each([
    ['event id', {eventId: 'evt_other'}],
    ['trace id', {traceId: 'trace_other'}],
    ['creation time', {createdAt: '2026-06-15T00:00:01.000Z'}],
  ])(
    'rejects a tool call with a mismatched %s before invoking the plugin',
    async (_field, mismatchedIdentity) => {
      let invoked = false;
      const plugin = createMemorySearchPluginWithInvocationProbe(() => {
        invoked = true;
      });
      const host = createExplicitlyEnabledRuntimePluginHost({
        plugins: [plugin],
      });
      const context = testPluginContext();

      const result = await host.handleToolCall(
        {
          ...testIdentity(mismatchedIdentity),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira',
          },
        },
        context,
      );

      expect(invoked).toBe(false);
      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'tool_call_identity_mismatch',
        evidence: [
          {
            eventId: context.eventId,
            traceId: context.traceId,
            createdAt: context.timestamp,
            evidenceKind: 'tool_invocation',
            status: 'rejected',
          },
        ],
      });
    },
  );

  it('invokes a plugin tool when the call and context identities match exactly', async () => {
    let invoked = false;
    const plugin = createMemorySearchPluginWithInvocationProbe(() => {
      invoked = true;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});
    const identity = testIdentity();
    const context = testPluginContext(identity);

    const result = await host.handleToolCall(
      {
        ...identity,
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      context,
    );

    expect(invoked).toBe(true);
    expect(result).toMatchObject({
      status: 'accepted',
      evidence: [
        {
          eventId: identity.eventId,
          traceId: identity.traceId,
          createdAt: identity.createdAt,
          evidenceKind: 'tool_invocation',
          status: 'accepted',
        },
      ],
    });
  });

  it('does not persist Character State when a tool-call identity is mismatched', async () => {
    const sessionIdentity = {};
    const plugin = createCharacterStatePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: characterStatePluginId,
      sessionIdentity,
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity({eventId: 'evt_other'}),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'curious',
        },
      },
      testPluginContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'tool_call_identity_mismatch',
    });
    expect(fileStore.readJsonl('events.jsonl')).toEqual([]);
    expect(fileStore.readJson('current.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(0);
  });

  it('keeps visible_reply terminal and routes character_state.patch through plugins', () => {
    const host = createDefaultProject02PluginHost();
    const visibleReply = host
      .pluginToolDefinitions()
      .find(tool => tool.name === visibleReplyModelToolName);
    const characterStatePatch = host
      .pluginToolDefinitions()
      .find(tool => tool.name === characterStatePatchModelToolName);

    expect(visibleReply).toMatchObject({
      pluginId: firstPartyModelToolsPluginId,
      validationOwner: 'built_in_model_tools',
      callLimit: {
        scope: 'model_response',
        maxCalls: 1,
      },
    });
    expect(characterStatePatch).toMatchObject({
      pluginId: characterStatePluginId,
      validationOwner: 'plugin_host',
      callLimit: {
        scope: 'user_turn',
        maxCalls: 1,
      },
    });
  });

  it('lists enabled plugins by default and includes disabled plugins for all scope', async () => {
    const enabledPlugin = createMemorySearchPlugin('memory.enabled.fixture');
    const disabledPlugin = createMemorySearchPlugin('memory.disabled.fixture');
    const host = createRuntimePluginHost({
      plugins: [enabledPlugin, disabledPlugin],
      enabledPluginIds: [runtimePluginId, enabledPlugin.manifest.id],
    });

    const defaultResult = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {},
      },
      testPluginContext(),
    );
    const allResult = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {
          scope: 'all',
        },
      },
      testPluginContext(),
    );

    expect(defaultResult.status).toBe('accepted');
    expect(allResult.status).toBe('accepted');

    if (
      defaultResult.status !== 'accepted' ||
      allResult.status !== 'accepted'
    ) {
      throw new Error('Expected runtime.plugin.list calls to be accepted.');
    }

    const defaultPluginIds = pluginDiscoveryPluginSummaries(
      defaultResult.output,
    ).map(plugin => plugin['id']);
    const allSummaries = pluginDiscoveryPluginSummaries(allResult.output);
    const disabledSummary = allSummaries.find(
      plugin => plugin['id'] === disabledPlugin.manifest.id,
    );
    const enabledSummary = allSummaries.find(
      plugin => plugin['id'] === enabledPlugin.manifest.id,
    );

    expect(defaultPluginIds).not.toContain(disabledPlugin.manifest.id);
    expect(disabledSummary).toMatchObject({
      id: disabledPlugin.manifest.id,
      enabled: false,
      availableForTurn: false,
      activationStatus: 'disabled',
      grantedAccess: {},
    });
    expect(enabledSummary?.['providedTools']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'memory.search',
          description: 'Search memory.',
          validationOwner: 'plugin_host',
          callLimit: {
            scope: 'user_turn',
            maxCalls: 1,
          },
          sourceReferencesRequired: false,
        }),
      ]),
    );
  });

  it('lists cold installed manifests without activation metadata as disabled', async () => {
    const coldPlugin = createMemorySearchPlugin('memory.cold.fixture');
    const host = createRuntimePluginHost({
      pluginInventoryState: {
        pluginManifests: [coldPlugin.manifest],
      },
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {scope: 'all'},
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected runtime.plugin.list scope=all to be accepted.');
    }

    expect(
      pluginDiscoveryPluginSummaries(result.output).find(
        summary => summary['id'] === coldPlugin.manifest.id,
      ),
    ).toMatchObject({
      id: coldPlugin.manifest.id,
      enabled: false,
      availableForTurn: false,
      activationStatus: 'disabled',
      grantedAccess: {},
      registeredLifecycleHooks: [],
      providedTools: [],
    });
  });

  it('preserves plugin and per-plugin tool truncation bounds', async () => {
    const baseTool = memorySearchProvidedTools()[0];

    if (baseTool === undefined) {
      throw new TypeError('Expected the memory search tool fixture.');
    }

    const plugins = Array.from({length: 17}, (_, pluginIndex) => {
      const pluginId = `memory.inventory.${String(pluginIndex).padStart(2, '0')}`;
      const toolCount = pluginIndex === 0 ? 9 : 1;

      return createRuntimePlugin({
        manifest: memorySearchPluginManifest(pluginId),
        providedTools: Array.from({length: toolCount}, (_, toolIndex) => ({
          ...baseTool,
          name: `${pluginId}.tool.${String(toolIndex)}`,
        })),
        lifecycleHooks: {
          handleToolCall() {
            return {
              status: 'rejected',
              reason: 'inventory_boundary_fixture',
              message: 'Inventory boundary fixture tools are not invoked.',
              evidence: [],
            };
          },
        },
      });
    });
    const firstPlugin = plugins[0];

    if (firstPlugin === undefined) {
      throw new TypeError('Expected an inventory boundary plugin.');
    }

    const host = createRuntimePluginHost({
      plugins,
      enabledPluginIds: [runtimePluginId, firstPlugin.manifest.id],
    });
    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {scope: 'all'},
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected bounded runtime plugin inventory.');
    }

    const summaries = pluginDiscoveryPluginSummaries(result.output);
    const firstPluginSummary = summaries.find(
      summary => summary['id'] === firstPlugin.manifest.id,
    );

    expect(result.output).toMatchObject({truncated: true});
    expect(summaries).toHaveLength(16);
    expect(firstPluginSummary).toMatchObject({toolsTruncated: true});
    expect(firstPluginSummary?.['providedTools']).toHaveLength(8);
  });

  it('does not inject plugin discovery inventory before model calls', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [runtimePluginId, plugin.manifest.id],
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result).toMatchObject({
      status: 'completed',
      contextItems: [],
    });
  });

  it('rejects duplicate model-facing tool names across enabled plugins', () => {
    expect(() =>
      createRuntimePluginHost({
        plugins: [
          createMemorySearchPlugin('memory.one'),
          createMemorySearchPlugin('memory.two'),
        ],
        enabledPluginIds: [runtimePluginId, 'memory.one', 'memory.two'],
      }),
    ).toThrow(/declared more than once/iu);
  });

  it('rejects duplicate provided tool names inside one plugin', () => {
    const [tool] = memorySearchProvidedTools();

    if (tool === undefined) {
      throw new Error('Expected memory search fixture tool.');
    }

    expect(() =>
      createRuntimePlugin({
        manifest: memorySearchPluginManifest('memory.duplicate-tool.fixture'),
        providedTools: [
          tool,
          {
            ...tool,
            description: 'Duplicate memory search.',
          },
        ],
        lifecycleHooks: {
          handleToolCall() {
            throw new Error('Duplicate tool fixture should not be called.');
          },
        },
      }),
    ).toThrow(/provided tool "memory\.search" is declared more than once/iu);
  });

  it('rejects duplicate provided tool names with conflicting routable declarations', () => {
    const [tool] = memorySearchProvidedTools();

    if (tool === undefined) {
      throw new Error('Expected memory search fixture tool.');
    }

    expect(() =>
      createRuntimePlugin({
        manifest: memorySearchPluginManifest(
          'memory.duplicate-routable-tool.fixture',
        ),
        providedTools: [
          {
            ...tool,
            description: 'Non-routable memory search.',
            requiresConfirmation: true,
          },
          {
            ...tool,
            description: 'Model-facing memory search.',
            requiresConfirmation: false,
          },
        ],
        lifecycleHooks: {
          handleToolCall() {
            throw new Error('Duplicate tool fixture should not be called.');
          },
        },
      }),
    ).toThrow(/provided tool "memory\.search" is declared more than once/iu);
  });

  it('does not expose tool-provider-only plugin tools as routable', () => {
    const plugin = createMemorySearchToolProviderOnlyPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    expect(host.pluginToolDefinitions().map(tool => tool.name)).not.toContain(
      'memory.search',
    );
  });

  it('does not expose tools when the plugin manifest requires confirmation', async () => {
    const plugin = createConfirmationRequiredMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    expect(host.pluginToolDefinitions().map(tool => tool.name)).not.toContain(
      'memory.search',
    );

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {},
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected runtime.plugin.list to be accepted.');
    }

    expect(JSON.stringify(result.output)).toContain(
      'memory.confirmation-required.fixture',
    );
    expect(JSON.stringify(result.output)).not.toContain('memory.search');
  });

  it('rejects direct calls to confirmation-required tools without executing them', async () => {
    let handlerCalls = 0;
    const plugin = createConfirmationRequiredMemorySearchPlugin(() => {
      handlerCalls += 1;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {query: 'private memory'},
      },
      testPluginContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'tool_not_routable',
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        policyOutcome: 'disallowed_tool_call',
      }),
    );
    expect(handlerCalls).toBe(0);
  });

  it('rejects direct calls to external-side-effect tools without executing them', async () => {
    let handlerCalls = 0;
    const plugin = createExternalReadMemorySearchPlugin(() => {
      handlerCalls += 1;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {query: 'remote memory'},
      },
      testPluginContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'tool_not_routable',
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        policyOutcome: 'disallowed_tool_call',
      }),
    );
    expect(handlerCalls).toBe(0);
  });

  it('turns handler failures into redacted rejected tool observations', async () => {
    const plugin = createMemorySearchPlugin(
      'memory.failing',
      true,
      'search backend failed api_key=super-secret Bearer secret-token',
    );
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

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

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message: 'search backend failed api_key=[redacted] Bearer [redacted]',
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('blocks fileStore writes attempted after handleToolCall timeout', async () => {
    const continueAfterTimeout = createDeferred<null>();
    const lateWrite = createDeferred<LateFileStoreWriteOutcome>();
    let hookDeadlineAt: number | undefined;
    let hookSignal: AbortSignal | undefined;
    const sessionIdentity = {};
    const plugin = createLateFileStoreWritePlugin({
      continueAfterTimeout: continueAfterTimeout.promise,
      recordLateWriteOutcome: lateWrite.resolve,
      recordExecutionScope(scope) {
        hookDeadlineAt = scope.deadlineAt;
        hookSignal = scope.signal;
      },
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
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

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_timeout',
    });
    expect(hookDeadlineAt).toBeTypeOf('number');
    expect(hookSignal?.aborted).toBe(true);

    continueAfterTimeout.resolve(null);

    await expect(lateWrite.promise).resolves.toBe('blocked');

    const fileStore = createRuntimePluginFileStore({
      sessionId: 'session-plugin-host',
      sessionIdentity,
      pluginId: plugin.manifest.id,
    });

    expect(fileStore.readJson('late-write.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(0);
  });

  it('withholds fileStore when an enabled plugin does not declare file_store', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.no-file-store-declaration.fixture',
      requestedAccess: {model_input: 'write'},
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
    });

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: false,
      },
    });
  });

  it('strips caller-provided fileStore when the plugin has no file_store grant', async () => {
    const sessionIdentity = {};
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.no-inherited-file-store.fixture',
      requestedAccess: {model_input: 'write'},
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity,
    });
    const inheritedFileStore = createPluginHostTestFileStore({
      pluginId: 'memory.inherited-file-store.fixture',
      sessionIdentity,
    });

    inheritedFileStore.writeJsonAtomic('seed.json', {
      value: 'inherited',
    });

    const result = await callFileStoreAvailabilityProbe(host, plugin, {
      ...testPluginContext(),
      fileStore: inheritedFileStore,
    });

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: false,
      },
    });
  });

  it('injects fileStore when an enabled non-built-in plugin declares file_store read', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.file-store-read.fixture',
      requestedAccess: {file_store: 'read', model_input: 'write'},
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: true,
      },
    });
  });

  it('scrubs turn context when an enabled plugin does not declare turn_context read', async () => {
    const captured: TurnContextCapture = {};
    const plugin = createTurnContextCapturePlugin({
      pluginId: 'memory.turn-context-scrubbed.fixture',
      requestedAccess: {},
      capture: captured,
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    await host.beforeRoleModelCall(testPluginContext());
    await host.afterTurnCommitted(
      createRuntimePluginAfterTurnCommittedContext({
        ...testIdentity(),
        sessionId: 'session-plugin-host',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'hello',
        character: {
          id: 'mira',
          displayName: 'Mira',
        },
        committedAt: '2026-06-15T00:00:00.000Z',
        visibleMessages: [
          {
            id: 'message-user',
            role: 'user',
            speakerId: 'user',
            speakerName: 'User',
            text: 'hello',
          },
          {
            id: 'message-character',
            role: 'character',
            speakerId: 'mira',
            speakerName: 'Mira',
            text: 'hi',
          },
        ],
      }),
    );

    expect(captured.beforeCurrentUserMessage).toBe('');
    expect(captured.afterCurrentUserMessage).toBe('');
    expect(captured.visibleMessageIds).toEqual([]);
    expect(captured.visibleMessages).toEqual([]);
  });

  it('preserves turn context when an enabled plugin declares turn_context read', async () => {
    const captured: TurnContextCapture = {};
    const plugin = createTurnContextCapturePlugin({
      pluginId: 'memory.turn-context-readable.fixture',
      requestedAccess: {turn_context: 'read'},
      capture: captured,
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    await host.beforeRoleModelCall(testPluginContext());
    await host.afterTurnCommitted(
      createRuntimePluginAfterTurnCommittedContext({
        ...testIdentity(),
        sessionId: 'session-plugin-host',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'hello',
        character: {
          id: 'mira',
          displayName: 'Mira',
        },
        committedAt: '2026-06-15T00:00:00.000Z',
        visibleMessages: [
          {
            id: 'message-user',
            role: 'user',
            speakerId: 'user',
            speakerName: 'User',
            text: 'hello',
          },
        ],
      }),
    );

    expect(captured.beforeCurrentUserMessage).toBe('hello');
    expect(captured.afterCurrentUserMessage).toBe('hello');
    expect(captured.visibleMessageIds).toEqual(['message-user']);
    expect(captured.visibleMessages?.map(message => message.text)).toEqual([
      'hello',
    ]);
  });

  it('rejects model input contributions when model_input write is not declared', async () => {
    const plugin = createRuntimeNotesWithoutModelInputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error(
        'Expected undeclared model input contribution to degrade.',
      );
    }
    expect(result.contextItems).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded',
      }),
    ]);
  });

  it('rejects model-facing tools without requestedAccess.model_input write at creation', () => {
    expect(() =>
      createRuntimePlugin({
        manifest: {
          ...memorySearchPluginManifest('memory.tool-no-model-input.fixture'),
          requestedAccess: {},
        },
        providedTools: memorySearchProvidedTools(),
        lifecycleHooks: {
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: [],
            };
          },
        },
      }),
    ).toThrow(
      'Model-facing tools require requestedAccess.model_input = "write".',
    );
  });

  it('defensively does not expose or invoke unchecked model-facing tools without model_input write', async () => {
    let invoked = false;
    const plugin = createModelFacingToolWithoutModelInputPlugin(() => {
      invoked = true;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    expect(host.pluginToolDefinitions().map(tool => tool.name)).not.toContain(
      'memory.search',
    );

    const discovery = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {},
      },
      testPluginContext(),
    );

    expect(JSON.stringify(discovery)).not.toContain('memory.search');

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

    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'model_input_not_granted',
    });
  });

  it('does not expose, advertise, route, or invoke local-memory-write tools without file_store write', async () => {
    let invoked = false;
    const plugin = createLocalMemoryWriteToolWithoutFileStorePlugin(() => {
      invoked = true;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    expect(host.pluginToolDefinitions().map(tool => tool.name)).not.toContain(
      'memory.search',
    );

    const discovery = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {},
      },
      testPluginContext(),
    );

    expect(JSON.stringify(discovery)).not.toContain('memory.search');

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

    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'file_store_write_not_granted',
    });
  });
});
