import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  createRuntimePlugin,
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginManifest,
  createRuntimePluginProvidedTool,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';
import {
  defaultRuntimePluginCatalogFactoryDefinitions,
  hostFirstPartyRuntimePluginIds
} from '../src/plugins/catalog.ts';
import {
  createFirstPartyModelToolsPlugin
} from '../src/plugins/builtin/model-tools.ts';
import {
  firstPartyModelToolsPluginId
} from '../src/plugins/contract.ts';
import {
  createDefaultProject02PluginHost,
  createRuntimePluginHost,
  runRuntimePluginSessionEndHooks,
  runtimePluginDiscoveryPluginId,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginHost
} from '../src/plugins/host.ts';
import {
  roleModelPluginListToolName
} from '../src/role-model/contracts.ts';
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginFileStore,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginToolCallResult
} from '../src/plugins/types.ts';
import {
  mapHermesMemoryProviderFixture,
  mapFirstPartyModelToolsPlugin,
  mapMcpToolsResourcesFixture,
  mapOpenClawMemoryPluginFixture,
  mapTencentDbMemoryGatewayFixture
} from '../src/plugins/adapter-proofs/index.ts';
import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';
import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';
import {
  createRuntimePluginDiscoveryPlugin
} from '../src/plugins/discovery-plugin.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin
} from '../src/plugins/builtin/character-state/index.ts';

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
};

type LateFileStoreWriteOutcome = 'blocked' | 'missing_file_store' | 'written';
type TurnContextCapture = {
  beforeCurrentUserMessage?: string;
  afterCurrentUserMessage?: string;
  visibleMessageIds?: readonly string[];
  visibleMessages?: readonly { readonly text: string }[];
};
type TestRuntimePluginHostOptions = Omit<
  CreateRuntimePluginHostOptions,
  'plugins'
> & {
  readonly plugins: readonly RuntimePlugin[];
};

function createExplicitlyEnabledRuntimePluginHost(
  options: TestRuntimePluginHostOptions
): RuntimePluginHost {
  return createRuntimePluginHost({
    ...options,
    enabledPluginIds: options.enabledPluginIds ?? [
      runtimePluginDiscoveryPluginId,
      ...options.plugins.map((plugin) => plugin.manifest.id)
    ]
  });
}

function pluginDiscoveryToolNames(
  output: RuntimePluginJsonValue
): readonly string[] {
  return Object.freeze(
    pluginDiscoveryPluginSummaries(output)
      .flatMap((plugin) => {
        const tools = plugin['providedTools'];

        if (!isRuntimePluginJsonArray(tools)) {
          throw new TypeError('Expected plugin discovery tools array.');
        }

        return tools.map((tool) => {
          if (
            !isRuntimePluginJsonObject(tool) ||
            typeof tool['name'] !== 'string'
          ) {
            throw new TypeError('Expected plugin discovery tool name.');
          }

          return tool['name'];
        });
      })
      .sort((left, right) => left.localeCompare(right))
  );
}

function pluginDiscoveryPluginSummaries(
  output: RuntimePluginJsonValue
): readonly RuntimePluginJsonObject[] {
  if (!isRuntimePluginJsonObject(output)) {
    throw new TypeError('Expected plugin discovery output object.');
  }

  const plugins = output['plugins'];

  if (!isRuntimePluginJsonArray(plugins)) {
    throw new TypeError('Expected plugin discovery output plugins array.');
  }

  return Object.freeze(
    plugins.map((plugin) => {
      if (!isRuntimePluginJsonObject(plugin)) {
        throw new TypeError('Expected plugin discovery plugin object.');
      }

      return plugin;
    })
  );
}

function isRuntimePluginJsonObject(
  value: RuntimePluginJsonValue
): value is RuntimePluginJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuntimePluginJsonArray(
  value: RuntimePluginJsonValue | undefined
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}

describe('runtime plugin host', () => {
  it('treats an explicit enabled-plugin list as authoritative', () => {
    const host = createRuntimePluginHost({ enabledPluginIds: [] });

    expect(host.enabledPluginIds()).toEqual([]);
    expect(host.pluginToolDefinitions()).toEqual([]);
    expect(host.resolveToolPluginId(roleModelPluginListToolName)).toBeUndefined();
  });

  it('rejects caller-supplied host-scoped plugin instances', () => {
    const callerDiscovery = createRuntimePluginDiscoveryPlugin(() => ({
      plugins: Object.freeze([]),
      enabledPlugins: Object.freeze([]),
      accessByPluginId: Object.freeze({})
    }));

    expect(() =>
      createRuntimePluginHost({
        plugins: [callerDiscovery]
      })
    ).toThrow(
      'Plugin "runtime.plugin_discovery" is host-owned and cannot be supplied by callers.'
    );
  });

  it('declares the canonical host first-party plugin catalog', () => {
    const catalog = defaultRuntimePluginCatalogFactoryDefinitions();

    expect([...hostFirstPartyRuntimePluginIds]).toEqual([
      runtimePluginDiscoveryPluginId,
      firstPartyModelToolsPluginId,
      characterStatePluginId
    ]);
    expect(Object.keys(catalog).sort()).toEqual(
      [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId
      ].sort((left, right) => left.localeCompare(right))
    );
  });

  it('routes plugin.list through the host-owned discovery plugin', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        plugin.manifest.id
      ]
    });
    const context = testPluginContext();

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {}
      },
      context
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected plugin.list to be accepted.');
    }

    expect(result.output).toMatchObject({
      plugins: [
        {
          id: runtimePluginDiscoveryPluginId
        },
        {
          id: firstPartyModelToolsPluginId
        },
        {
          id: 'memory.search.fixture'
        }
      ]
    });
  });

  it('advertises the same model-facing tools that the host exposes', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {}
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected plugin.list to be accepted.');
    }

    const exposedToolNames = Object.freeze(
      host.pluginToolDefinitions()
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right))
    );

    expect(pluginDiscoveryToolNames(result.output)).toEqual(exposedToolNames);
    expect(exposedToolNames).toEqual(
      expect.arrayContaining([roleModelPluginListToolName, 'memory.search'])
    );
  });

  it.each([
    ['event id', { eventId: 'evt_other' }],
    ['trace id', { traceId: 'trace_other' }],
    ['creation time', { createdAt: '2026-06-15T00:00:01.000Z' }]
  ])(
    'rejects a tool call with a mismatched %s before invoking the plugin',
    async (_field, mismatchedIdentity) => {
      let invoked = false;
      const plugin = createMemorySearchPluginWithInvocationProbe(() => {
        invoked = true;
      });
      const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });
      const context = testPluginContext();

      const result = await host.handleToolCall(
        {
          ...testIdentity(mismatchedIdentity),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira'
          }
        },
        context
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
            status: 'rejected'
          }
        ]
      });
    }
  );

  it('invokes a plugin tool when the call and context identities match exactly', async () => {
    let invoked = false;
    const plugin = createMemorySearchPluginWithInvocationProbe(() => {
      invoked = true;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });
    const identity = testIdentity();
    const context = testPluginContext(identity);

    const result = await host.handleToolCall(
      {
        ...identity,
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      context
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
          status: 'accepted'
        }
      ]
    });
  });

  it('does not persist Character State when a tool-call identity is mismatched', async () => {
    const sessionIdentity = {};
    const plugin = createCharacterStatePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: characterStatePluginId,
      sessionIdentity
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity({ eventId: 'evt_other' }),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'curious'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'tool_call_identity_mismatch'
    });
    expect(fileStore.readJsonl('events.jsonl')).toEqual([]);
    expect(fileStore.readJson('current.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(0);
  });

  it('keeps visible_reply terminal and routes character_state.patch through plugins', () => {
    const host = createDefaultProject02PluginHost();
    const visibleReply = host.pluginToolDefinitions().find(
      (tool) => tool.name === visibleReplyModelToolName
    );
    const characterStatePatch = host.pluginToolDefinitions().find(
      (tool) => tool.name === characterStatePatchModelToolName
    );

    expect(visibleReply).toMatchObject({
      pluginId: firstPartyModelToolsPluginId,
      validationOwner: 'built_in_model_tools',
      callLimit: {
        scope: 'model_response',
        maxCalls: 1
      }
    });
    expect(host.resolveToolPluginId(visibleReplyModelToolName)).toBeUndefined();
    expect(characterStatePatch).toMatchObject({
      pluginId: characterStatePluginId,
      validationOwner: 'plugin_host',
      callLimit: {
        scope: 'user_turn',
        maxCalls: 1
      }
    });
    expect(host.resolveToolPluginId(characterStatePatchModelToolName)).toBe(
      characterStatePluginId
    );
  });

  it('lists enabled plugins by default and includes disabled plugins for all scope', async () => {
    const enabledPlugin = createMemorySearchPlugin('memory.enabled.fixture');
    const disabledPlugin = createMemorySearchPlugin('memory.disabled.fixture');
    const host = createRuntimePluginHost({
      plugins: [enabledPlugin, disabledPlugin],
      enabledPluginIds: [runtimePluginDiscoveryPluginId, enabledPlugin.manifest.id]
    });

    const defaultResult = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {}
      },
      testPluginContext()
    );
    const allResult = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {
          scope: 'all'
        }
      },
      testPluginContext()
    );

    expect(defaultResult.status).toBe('accepted');
    expect(allResult.status).toBe('accepted');

    if (defaultResult.status !== 'accepted' || allResult.status !== 'accepted') {
      throw new Error('Expected plugin.list calls to be accepted.');
    }

    const defaultPluginIds = pluginDiscoveryPluginSummaries(
      defaultResult.output
    ).map((plugin) => plugin['id']);
    const allSummaries = pluginDiscoveryPluginSummaries(allResult.output);
    const disabledSummary = allSummaries.find(
      (plugin) => plugin['id'] === disabledPlugin.manifest.id
    );
    const enabledSummary = allSummaries.find(
      (plugin) => plugin['id'] === enabledPlugin.manifest.id
    );

    expect(defaultPluginIds).not.toContain(disabledPlugin.manifest.id);
    expect(disabledSummary).toMatchObject({
      id: disabledPlugin.manifest.id,
      enabled: false,
      availableForTurn: false,
      activationStatus: 'disabled',
      grantedAccess: {}
    });
    expect(enabledSummary?.['providedTools']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'memory.search',
          description: 'Search memory.',
          validationOwner: 'plugin_host',
          callLimit: {
            scope: 'user_turn',
            maxCalls: 1
          },
          sourceReferencesRequired: false
        })
      ])
    );
  });

  it('does not inject plugin discovery inventory before model calls', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [runtimePluginDiscoveryPluginId, plugin.manifest.id]
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result).toMatchObject({
      status: 'completed',
      contextItems: [],
      runtimeNotes: []
    });
  });

  it('rejects duplicate model-facing tool names across enabled plugins', () => {
    expect(() =>
      createRuntimePluginHost({
        plugins: [
          createMemorySearchPlugin('memory.one'),
          createMemorySearchPlugin('memory.two')
        ],
        enabledPluginIds: [
          runtimePluginDiscoveryPluginId,
          'memory.one',
          'memory.two'
        ]
      })
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
            description: 'Duplicate memory search.'
          }
        ],
        lifecycleHooks: {
          handleToolCall() {
            throw new Error('Duplicate tool fixture should not be called.');
          }
        }
      })
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
          'memory.duplicate-routable-tool.fixture'
        ),
        providedTools: [
          {
            ...tool,
            description: 'Non-routable memory search.',
            requiresConfirmation: true
          },
          {
            ...tool,
            description: 'Model-facing memory search.',
            requiresConfirmation: false
          }
        ],
        lifecycleHooks: {
          handleToolCall() {
            throw new Error('Duplicate tool fixture should not be called.');
          }
        }
      })
    ).toThrow(/provided tool "memory\.search" is declared more than once/iu);
  });

  it('does not resolve tool-provider-only plugin tools as routable', () => {
    const plugin = createMemorySearchToolProviderOnlyPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    expect(host.pluginToolDefinitions().map((tool) => tool.name)).not.toContain(
      'memory.search'
    );
    expect(host.resolveToolPluginId('memory.search')).toBeUndefined();
  });

  it('does not expose tools when the plugin manifest requires confirmation', async () => {
    const plugin = createConfirmationRequiredMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    expect(host.pluginToolDefinitions().map((tool) => tool.name)).not.toContain(
      'memory.search'
    );
    expect(host.resolveToolPluginId('memory.search')).toBeUndefined();

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {}
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected plugin.list to be accepted.');
    }

    expect(JSON.stringify(result.output)).toContain(
      'memory.confirmation-required.fixture'
    );
    expect(JSON.stringify(result.output)).not.toContain('memory.search');
  });

  it('rejects direct calls to confirmation-required tools without executing them', async () => {
    let handlerCalls = 0;
    const plugin = createConfirmationRequiredMemorySearchPlugin(() => {
      handlerCalls += 1;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: { query: 'private memory' }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'tool_not_routable'
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        policyOutcome: 'disallowed_tool_call'
      })
    );
    expect(handlerCalls).toBe(0);
  });

  it('rejects direct calls to external-side-effect tools without executing them', async () => {
    let handlerCalls = 0;
    const plugin = createExternalReadMemorySearchPlugin(() => {
      handlerCalls += 1;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: { query: 'remote memory' }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'tool_not_routable'
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        policyOutcome: 'disallowed_tool_call'
      })
    );
    expect(handlerCalls).toBe(0);
  });

  it('turns handler failures into redacted rejected tool observations', async () => {
    const plugin = createMemorySearchPlugin(
      'memory.failing',
      true,
      'search backend failed api_key=super-secret Bearer secret-token'
    );
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message: 'search backend failed api_key=[redacted] Bearer [redacted]'
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('blocks fileStore writes attempted after handleToolCall timeout', async () => {
    const continueAfterTimeout = createDeferred<null>();
    const lateWrite = createDeferred<LateFileStoreWriteOutcome>();
    const sessionIdentity = {};
    const plugin = createLateFileStoreWritePlugin({
      continueAfterTimeout: continueAfterTimeout.promise,
      recordLateWriteOutcome: lateWrite.resolve
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_timeout'
    });

    continueAfterTimeout.resolve(null);

    await expect(lateWrite.promise).resolves.toBe('blocked');

    const fileStore = createRuntimePluginFileStore({
      sessionId: 'session-plugin-host',
      sessionIdentity,
      pluginId: plugin.manifest.id
    });

    expect(fileStore.readJson('late-write.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(0);
  });

  it('withholds fileStore when an enabled plugin does not declare file_store', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.no-file-store-declaration.fixture',
      requestedAccess: { model_input: 'write' }
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin]
    });

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: false
      }
    });
  });

  it('strips caller-provided fileStore when the plugin has no file_store grant', async () => {
    const sessionIdentity = {};
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.no-inherited-file-store.fixture',
      requestedAccess: { model_input: 'write' }
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const inheritedFileStore = createPluginHostTestFileStore({
      pluginId: 'memory.inherited-file-store.fixture',
      sessionIdentity
    });

    inheritedFileStore.writeJsonAtomic('seed.json', {
      value: 'inherited'
    });

    const result = await callFileStoreAvailabilityProbe(host, plugin, {
      ...testPluginContext(),
      fileStore: inheritedFileStore
    });

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: false
      }
    });
  });

  it('injects fileStore when an enabled non-built-in plugin declares file_store read', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.file-store-read.fixture',
      requestedAccess: { file_store: 'read', model_input: 'write' }
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: true
      }
    });
  });

  it('scrubs turn context when an enabled plugin does not declare turn_context read', async () => {
    const captured: TurnContextCapture = {};
    const plugin = createTurnContextCapturePlugin({
      pluginId: 'memory.turn-context-scrubbed.fixture',
      requestedAccess: {},
      capture: captured
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    await host.beforeRoleModelCall(testPluginContext());
    await host.afterTurnCommitted(
      createRuntimePluginAfterTurnCommittedContext({
        ...testIdentity(),
        sessionId: 'session-plugin-host',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'hello',
        character: {
          id: 'mira',
          displayName: 'Mira'
        },
        committedAt: '2026-06-15T00:00:00.000Z',
        visibleMessages: [
          {
            id: 'message-user',
            role: 'user',
            speakerId: 'user',
            speakerName: 'User',
            text: 'hello'
          },
          {
            id: 'message-character',
            role: 'character',
            speakerId: 'mira',
            speakerName: 'Mira',
            text: 'hi'
          }
        ]
      })
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
      requestedAccess: { turn_context: 'read' },
      capture: captured
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    await host.beforeRoleModelCall(testPluginContext());
    await host.afterTurnCommitted(
      createRuntimePluginAfterTurnCommittedContext({
        ...testIdentity(),
        sessionId: 'session-plugin-host',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'hello',
        character: {
          id: 'mira',
          displayName: 'Mira'
        },
        committedAt: '2026-06-15T00:00:00.000Z',
        visibleMessages: [
          {
            id: 'message-user',
            role: 'user',
            speakerId: 'user',
            speakerName: 'User',
            text: 'hello'
          }
        ]
      })
    );

    expect(captured.beforeCurrentUserMessage).toBe('hello');
    expect(captured.afterCurrentUserMessage).toBe('hello');
    expect(captured.visibleMessageIds).toEqual(['message-user']);
    expect(captured.visibleMessages?.map((message) => message.text)).toEqual([
      'hello'
    ]);
  });

  it('rejects model input contributions when model_input write is not declared', async () => {
    const plugin = createRuntimeNotesWithoutModelInputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected undeclared model input contribution to degrade.');
    }
    expect(result.contextItems).toEqual([]);
    expect(result.runtimeNotes).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      })
    ]);
  });

  it('rejects model-facing tools without requestedAccess.model_input write at creation', () => {
    expect(() =>
      createRuntimePlugin({
        manifest: {
          ...memorySearchPluginManifest('memory.tool-no-model-input.fixture'),
          requestedAccess: {}
        },
        providedTools: memorySearchProvidedTools(),
        lifecycleHooks: {
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: []
            };
          }
        }
      })
    ).toThrow(
      'Model-facing tools require requestedAccess.model_input = "write".'
    );
  });

  it('defensively does not expose or invoke unchecked model-facing tools without model_input write', async () => {
    let invoked = false;
    const plugin = createModelFacingToolWithoutModelInputPlugin(() => {
      invoked = true;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    expect(host.pluginToolDefinitions().map((tool) => tool.name)).not.toContain(
      'memory.search'
    );
    expect(host.resolveToolPluginId('memory.search')).toBeUndefined();

    const discovery = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {}
      },
      testPluginContext()
    );

    expect(JSON.stringify(discovery)).not.toContain('memory.search');

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'model_input_not_granted'
    });
  });

  it('does not expose, advertise, route, or invoke local-memory-write tools without file_store write', async () => {
    let invoked = false;
    const plugin = createLocalMemoryWriteToolWithoutFileStorePlugin(() => {
      invoked = true;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    expect(host.pluginToolDefinitions().map((tool) => tool.name)).not.toContain(
      'memory.search'
    );
    expect(host.resolveToolPluginId('memory.search')).toBeUndefined();

    const discovery = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {}
      },
      testPluginContext()
    );

    expect(JSON.stringify(discovery)).not.toContain('memory.search');

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'file_store_write_not_granted'
    });
  });

  it('rejects duplicate plugin ids before standalone session-end API permission injection', async () => {
    const pluginId = 'memory.duplicate-session-end.fixture';
    const invokedPlugins: string[] = [];
    const deniedPlugin = createSessionEndFileStoreProbePlugin({
      pluginId,
      requestedAccess: {},
      onSessionEnd(context) {
        invokedPlugins.push(
          context.fileStore === undefined ? 'denied:no_file_store' : 'denied:file_store'
        );
      }
    });
    const grantedPlugin = createSessionEndFileStoreProbePlugin({
      pluginId,
      requestedAccess: { file_store: 'write' },
      onSessionEnd(context) {
        invokedPlugins.push(
          context.fileStore === undefined ? 'granted:no_file_store' : 'granted:file_store'
        );
        context.fileStore?.writeJsonAtomic('duplicate-session-end.json', {
          value: 'unexpected'
        });
      }
    });

    await expect(
      runRuntimePluginSessionEndHooks({
        plugins: [deniedPlugin, grantedPlugin],
        context: testPluginContext(),
        hookOptions: {
          allowFileStoreWrites: true
        }
      })
    ).rejects.toThrow(
      /Duplicate plugin id "memory\.duplicate-session-end\.fixture" is not allowed/iu
    );
    expect(invokedPlugins).toEqual([]);
  });

  it('uses captured access grants for host session-end hooks', async () => {
    const sessionIdentity = {};
    let sawFileStore = false;
    const plugin = createSessionEndFileStoreProbePlugin({
      pluginId: 'memory.session-end-mutated-policy.fixture',
      requestedAccess: { file_store: 'write' },
      onSessionEnd(context) {
        sawFileStore = context.fileStore !== undefined;
        context.fileStore?.writeJsonAtomic('mutated-policy-session-end.json', {
          value: 'unexpected'
        });
      }
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });

    const result = await host.onSessionEnd(testPluginContext());
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    expect(result.status).toBe('completed');
    expect(sawFileStore).toBe(true);
    expect(fileStore.readJson('mutated-policy-session-end.json')).toEqual({
      value: 'unexpected'
    });
    expect(fileStore.revision()).toBe(1);
  });

  it('does not trust manifest-declared first_party for default sensitive access', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.fake-first-party.fixture',
      localTrustLevel: 'first_party',
      requestedAccess: { file_store: 'read', model_input: 'write' }
    });
    const host = createRuntimePluginHost({ plugins: [plugin] });

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled'
    });
  });

  it('denies trusted_adapter and test_fixture plugins by default', async () => {
    const trustedAdapter = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.trusted-adapter-denied.fixture',
      localTrustLevel: 'trusted_adapter',
      requestedAccess: { file_store: 'read', model_input: 'write' }
    });
    const testFixture = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.test-fixture-denied.fixture',
      localTrustLevel: 'test_fixture',
      requestedAccess: { file_store: 'read', model_input: 'write' }
    });
    const trustedAdapterHost = createRuntimePluginHost({
      plugins: [trustedAdapter]
    });
    const testFixtureHost = createRuntimePluginHost({
      plugins: [testFixture]
    });

    await expect(
      callFileStoreAvailabilityProbe(trustedAdapterHost, trustedAdapter)
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled'
    });
    await expect(
      callFileStoreAvailabilityProbe(testFixtureHost, testFixture)
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled'
    });
  });

  it('injects fileStore for an explicitly enabled non-built-in plugin that declares it', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: 'memory.file-store-allowed.fixture',
      requestedAccess: { file_store: 'read', model_input: 'write' }
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin]
    });

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        fileStoreAvailable: true
      }
    });
  });

  it('replaces caller-provided fileStore with the plugin-scoped store when file_store read is granted', async () => {
    const sessionIdentity = {};
    const plugin = createReadOnlyFileStoreProbePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const scopedFileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });
    const inheritedFileStore = createPluginHostTestFileStore({
      pluginId: 'memory.inherited-file-store.fixture',
      sessionIdentity
    });

    scopedFileStore.writeJsonAtomic('seed.json', {
      value: 'scoped'
    });
    inheritedFileStore.writeJsonAtomic('seed.json', {
      value: 'inherited'
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      {
        ...testPluginContext(),
        fileStore: inheritedFileStore
      }
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected read-only fileStore probe to be accepted.');
    }

    expect(result.output).toEqual({
      seed: {
        value: 'scoped'
      },
      writeBlocked: true
    });
    expect(scopedFileStore.readJson('read-only-write.json')).toBeUndefined();
    expect(inheritedFileStore.readJson('read-only-write.json')).toBeUndefined();
  });

  it('allows host-known Character State built-in file_store write access by default', async () => {
    const plugin = createCharacterStatePlugin();
    const host = createRuntimePluginHost({ plugins: [plugin] });
    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected Character State beforeRoleModelCall to complete.');
    }
    expect(result.contextItems).toHaveLength(1);
  });

  it('withholds Character State default file_store access from an id-spoofed plugin', async () => {
    const plugin = createFileStoreAvailabilityProbePlugin({
      pluginId: characterStatePluginId,
      requestedAccess: { file_store: 'read', model_input: 'write' },
      localTrustLevel: 'first_party'
    });
    const host = createRuntimePluginHost({ plugins: [plugin] });

    const result = await callFileStoreAvailabilityProbe(host, plugin);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_not_enabled'
    });
  });

  it('withholds fileStore writes from read-only handleToolCall tools', async () => {
    const sessionIdentity = {};
    const plugin = createReadOnlyFileStoreProbePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });
    const registration = host
      .registrySnapshot()
      .plugins.find((item) => item.manifest.id === plugin.manifest.id);

    fileStore.writeJsonAtomic('seed.json', {
      value: 'existing'
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected read-only fileStore probe to be accepted.');
    }

    expect(plugin.manifest.runtimePolicy.sideEffectLevel).toBe('runtime_read');
    expect(registration).toMatchObject({
      requestedAccess: { file_store: 'write', model_input: 'write' },
      grantedAccess: { file_store: 'write', model_input: 'write' }
    });
    expect(result.output).toEqual({
      seed: {
        value: 'existing'
      },
      writeBlocked: true
    });
    expect(fileStore.readJson('read-only-write.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('withholds fileStore writes from read-only hook contexts', async () => {
    const sessionIdentity = {};
    const plugin = createReadOnlyBeforeRoleModelFileStoreProbePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    fileStore.writeJsonAtomic('seed.json', {
      value: 'existing'
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected read-only hook probe to complete.');
    }

    expect(result.runtimeNotes).toEqual([
      '{"seed":{"value":"existing"},"writeBlocked":true}'
    ]);
    expect(fileStore.readJson('read-only-hook-write.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('blocks retained fileStore writes after beforeRoleModelCall completes', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedBeforeRoleModelFileStorePlugin((fileStore) => {
      retainedFileStore = fileStore;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    expectRetainedFileStoreWriteBlocked(retainedFileStore, 'after-before.json');

    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    expect(fileStore.readJson('during-before.json')).toEqual({ value: 'during' });
    expect(fileStore.readJson('after-before.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('writes during handleToolCall and blocks retained fileStore writes after completion', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedHandleToolCallFileStorePlugin((fileStore) => {
      retainedFileStore = fileStore;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const registration = host
      .registrySnapshot()
      .plugins.find((item) => item.manifest.id === plugin.manifest.id);

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(plugin.manifest.runtimePolicy.sideEffectLevel).toBe('runtime_read');
    expect(plugin.providedTools[0]?.sideEffectLevel).toBe('local_memory_write');
    expect(registration).toMatchObject({
      requestedAccess: { file_store: 'write', model_input: 'write' },
      grantedAccess: { file_store: 'write', model_input: 'write' }
    });
    expect(result.status).toBe('accepted');
    expectRetainedFileStoreWriteBlocked(retainedFileStore, 'after-handle.json');

    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    expect(fileStore.readJson('during-handle.json')).toEqual({ value: 'during' });
    expect(fileStore.readJson('after-handle.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);

    const afterCommitResult = await host.afterTurnCommitted(
      testPluginAfterTurnCommittedContext()
    );

    expect(afterCommitResult.status).toBe('completed');
    expect(fileStore.readJson('during-handle.json')).toEqual({ value: 'during' });
    expect(fileStore.revision()).toBe(1);
  });

  it('keeps immediate handleToolCall fileStore writes for a later rejected turn context', async () => {
    const sessionIdentity = {};
    const plugin = createStagedAppendFileStorePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const context = testPluginContext();
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'rejected'
        }
      },
      context
    );

    expect(result.status).toBe('accepted');

    const afterCommitResult = await host.afterTurnCommitted(
      testPluginAfterTurnCommittedContext()
    );

    expect(afterCommitResult.status).toBe('completed');
    expect(fileStore.readJsonl('events.jsonl')).toEqual([
      {
        value: 'rejected',
        traceId: context.traceId
      }
    ]);
    expect(fileStore.revision()).toBe(1);
  });

  it('records immediate handleToolCall fileStore writes for same-turn retries', async () => {
    const sessionIdentity = {};
    const plugin = createStagedAppendFileStorePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });
    const rejectedContext = testPluginContext({
      eventId: 'evt_same_turn_retry',
      traceId: 'trace_rejected_attempt'
    });
    const retryContext = testPluginContext({
      eventId: 'evt_same_turn_retry',
      traceId: 'trace_retry_attempt'
    });
    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    await host.handleToolCall(
      {
        ...testIdentity({
          eventId: 'evt_same_turn_retry',
          traceId: 'trace_rejected_attempt'
        }),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'rejected-attempt'
        }
      },
      rejectedContext
    );
    await host.handleToolCall(
      {
        ...testIdentity({
          eventId: 'evt_same_turn_retry',
          traceId: 'trace_retry_attempt'
        }),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'retry-attempt'
        }
      },
      retryContext
    );

    expect(fileStore.readJsonl('events.jsonl')).toEqual([
      {
        value: 'rejected-attempt',
        traceId: 'trace_rejected_attempt'
      },
      {
        value: 'retry-attempt',
        traceId: 'trace_retry_attempt'
      }
    ]);
    expect(fileStore.revision()).toBe(2);
  });

  it('blocks retained fileStore writes after health completes', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedHealthFileStorePlugin((fileStore) => {
      retainedFileStore = fileStore;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
      sessionIdentity
    });

    const result = await host.health(testPluginContext());

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      pluginId: plugin.manifest.id,
      status: 'ok'
    });
    expectRetainedFileStoreWriteBlocked(retainedFileStore, 'after-health.json');

    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    expect(fileStore.readJson('during-health.json')).toEqual({ value: 'during' });
    expect(fileStore.readJson('after-health.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(1);
  });

  it('rejects plugin-host-owned invalid input before invoking the handler', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {}
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_input',
      message: 'memory.search input missing required field "query".'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      policyOutcome: 'handler_rejected'
    });
  });

  it('honors optional degrade policy for plugin-host-owned invalid input', async () => {
    let handledCalls = 0;
    const plugin = createDegradableMemorySearchPlugin(() => {
      handledCalls += 1;
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {}
      },
      testPluginContext()
    );

    expect(handledCalls).toBe(0);
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_input',
      message: 'memory.search input missing required field "query".'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded'
    });
  });

  it('redacts plugin-returned rejected tool result messages', async () => {
    const plugin = createRejectingMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message:
        'lookup failed credential="[redacted]" https://[redacted]@example.test/?token=[redacted]'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      summary:
        'lookup failed credential="[redacted]" https://[redacted]@example.test/?token=[redacted]',
      policyOutcome: 'handler_rejected'
    });
    expect(JSON.stringify(result)).not.toContain('open-sesame');
    expect(JSON.stringify(result)).not.toContain('abc');
  });

  it.each([
    ['empty reason', '', 'search backend failed'],
    ['empty message', 'handler_rejected', ''],
    ['blank reason', '   ', 'search backend failed'],
    ['blank message', 'handler_rejected', '   ']
  ] as const)(
    'rejects plugin-returned rejected tool result with %s',
    async (_caseName, rejectionReason, rejectionMessage) => {
      const plugin = createRejectingMemorySearchPlugin({
        id: `memory.rejecting.${_caseName.replace(' ', '-')}.fixture`,
        rejectionReason,
        rejectionMessage
      });
      const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

      const result = await host.handleToolCall(
        {
          ...testIdentity(),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira'
          }
        },
        testPluginContext()
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'handler_failed',
        message:
          'Plugin rejected tool result reason and message must be non-empty.'
      });
      expect(result.evidence[0]).toMatchObject({
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary:
          'Plugin rejected tool result reason and message must be non-empty.',
        policyOutcome: 'handler_rejected'
      });
    }
  );

  it('preserves degraded evidence from optional rejected plugin tool results', async () => {
    const plugin = createDegradedRejectingMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message: 'search backend degraded'
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded'
    });
  });

  it('synthesizes degraded fallback evidence for optional rejected plugin tool results with degrade policy', async () => {
    const plugin = createRejectingMemorySearchPlugin({
      id: 'memory.rejecting.degraded.fixture',
      handleToolCallFailure: 'degrade'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message:
        'lookup failed credential="[redacted]" https://[redacted]@example.test/?token=[redacted]'
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded'
    });
  });

  it.each(['rejected', 'failed'] as const)(
    'downgrades accepted plugin tool results with %s tool invocation evidence',
    async (evidenceStatus) => {
      const plugin =
        createAcceptedBlockingEvidenceMemorySearchPlugin(evidenceStatus);
      const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

      const result = await host.handleToolCall(
        {
          ...testIdentity(),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira'
          }
        },
        testPluginContext()
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'blocking_tool_invocation_evidence',
        message: `Plugin "${plugin.manifest.id}" tool "memory.search" accepted result included blocking tool invocation evidence.`
      });
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toMatchObject({
        evidenceKind: 'tool_invocation',
        status: evidenceStatus
      });
    }
  );

  it('redacts accepted plugin tool output strings', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query:
            'api_key=super-secret Bearer secret-token https://user:pass@example.test/?token=abc'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    expect(result.output).toMatchObject({
      matched:
        'api_key=[redacted] Bearer [redacted] https://[redacted]@example.test/?token=[redacted]'
    });
  });

  it('redacts accepted plugin tool output values with credential-shaped keys', async () => {
    const plugin = createCredentialKeyOutputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    expect(result.output).toMatchObject({
      api_key: '[redacted]',
      nested: {
        password: '[redacted]',
        safe: 'kept'
      },
      list: [
        {
          access_token: '[redacted]',
          label: 'kept'
        }
      ]
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('open-sesame');
    expect(serialized).not.toContain('secret-token');
  });

  it('preserves own __proto__ keys in accepted plugin tool output objects', async () => {
    const plugin = createProtoKeyOutputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    const output = expectJsonObject(result.output);
    const nested = expectJsonObject(output['nested']);

    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(output['__proto__']).toEqual({
      polluted: true
    });
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(nested['__proto__']).toBe('nested-value');
    expect(JSON.stringify(output)).toContain(
      '"__proto__":{"polluted":true}'
    );
    expect(JSON.stringify(output)).toContain(
      '"nested":{"__proto__":"nested-value"}'
    );
  });

  it('rejects accepted source-required tool output backed only by unrelated source evidence', async () => {
    const plugin = createSourceRequiredMemorySearchPlugin({
      id: 'memory.source-required.unrelated.fixture',
      evidenceKinds: ['policy', 'health']
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message:
        'Plugin "memory.source-required.unrelated.fixture" tool "memory.search" accepted result requires source references.'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      policyOutcome: 'handler_rejected'
    });
  });

  it('degrades optional source-required tool output backed only by unrelated source evidence', async () => {
    const plugin = createSourceRequiredMemorySearchPlugin({
      id: 'memory.source-required.degraded.fixture',
      evidenceKinds: ['policy'],
      handleToolCallFailure: 'degrade'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message:
        'Plugin "memory.source-required.degraded.fixture" tool "memory.search" accepted result requires source references.'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded'
    });
  });

  it('accepts source-required tool output backed by accepted tool invocation source evidence', async () => {
    const plugin = createSourceRequiredMemorySearchPlugin({
      id: 'memory.source-required.accepted.fixture',
      evidenceKinds: ['tool_invocation']
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected source-required memory.search to be accepted.');
    }

    expect(result.output).toEqual({
      matched: 'Mira'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      sourceReferences: [
        {
          kind: 'memory',
          id: 'source.tool_invocation'
        }
      ]
    });
  });

  it('degrades optional source-required runtime notes before prompting', async () => {
    const plugin = createSourceRequiredRuntimeNotesPlugin({
      id: 'memory.source-required-notes.degraded.fixture'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected optional source-required notes to degrade.');
    }

    expect(result.runtimeNotes).toEqual([]);
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'before_role_model_call',
      status: 'degraded',
      policyOutcome: 'optional_degraded',
      summary:
        'Optional before-role-model plugin hook degraded: Plugin "memory.source-required-notes.degraded.fixture" runtime notes require source references.'
    });
  });

  it('rejects required source-required runtime notes before prompting', async () => {
    const plugin = createSourceRequiredRuntimeNotesPlugin({
      id: 'memory.source-required-notes.required.fixture',
      requiredForTurn: true
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result).toMatchObject({
      status: 'rejected',
      pluginId: plugin.manifest.id,
      message:
        'Plugin "memory.source-required-notes.required.fixture" runtime notes require source references.'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'before_role_model_call',
      status: 'rejected',
      policyOutcome: 'required_rejected'
    });
  });

  it.each(['rejected', 'failed'] as const)(
    'rejects required accepted beforeRoleModelCall results with %s evidence',
    async (evidenceStatus) => {
      const plugin = createAcceptedBlockingBeforeRoleModelCallPlugin({
        id: `memory.before-blocking.required.${evidenceStatus}.fixture`,
        requiredForTurn: true,
        evidenceStatus
      });
      const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

      const result = await host.beforeRoleModelCall(testPluginContext());

      expect(result).toMatchObject({
        status: 'rejected',
        pluginId: plugin.manifest.id,
        message: `Plugin "${plugin.manifest.id}" accepted beforeRoleModelCall result included blocking before-role-model evidence.`
      });
      expect(result.evidence).toEqual([
        expect.objectContaining({
          evidenceKind: 'before_role_model_call',
          status: evidenceStatus
        }),
        expect.objectContaining({
          evidenceKind: 'before_role_model_call',
          status: 'rejected',
          policyOutcome: 'required_rejected'
        })
      ]);
    }
  );

  it('degrades optional accepted beforeRoleModelCall results with blocking evidence', async () => {
    const plugin = createAcceptedBlockingBeforeRoleModelCallPlugin({
      id: 'memory.before-blocking.optional.fixture',
      evidenceStatus: 'rejected'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected optional blocking beforeRoleModelCall evidence to degrade.');
    }

    expect(result.contextItems).toEqual([]);
    expect(result.runtimeNotes).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        evidenceKind: 'before_role_model_call',
        status: 'rejected'
      }),
      expect.objectContaining({
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      })
    ]);
  });

  it('budgets beforeRoleModelCall runtime notes before prompting', async () => {
    const plugin = createRuntimeNotesPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(result.runtimeNotes).toEqual(['short note']);
    const budgetEvidence = result.evidence.find(
      (evidence) =>
        evidence.pluginId === plugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded'
    );
    expect(budgetEvidence?.summary).toContain('runtime note');
    expect(JSON.stringify(result.runtimeNotes)).not.toContain('super-secret');
  });

  it('budgets beforeRoleModelCall context item text with a host-side estimate', async () => {
    const plugin = createUnderestimatedContextItemPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(result.contextItems).toEqual([]);
    const budgetEvidence = result.evidence.find(
      (evidence) =>
        evidence.pluginId === plugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded'
    );

    expect(budgetEvidence?.summary).toContain('1 item(s)');
    expect(budgetEvidence?.summary).toContain('dropped ids oversized-context');
    expect(JSON.stringify(result.contextItems)).not.toContain('oversized context');
  });

  it('retains higher-priority Character State and runtime notes before lower-priority context', async () => {
    const pressurePlugin = createLowPriorityBudgetPressurePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [createCharacterStatePlugin(), pressurePlugin],
      sessionIdentity: {
        test: 'priority-budget-pressure'
      }
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(
      result.contextItems.map((item) => `${item.pluginId}:${item.id}`)
    ).toEqual([`${characterStatePluginId}:current`]);
    expect(result.contextItems[0]?.budget.priority).toBe(90);
    expect(result.runtimeNotes).toEqual(['runtime note from host']);
    const budgetEvidence = result.evidence.find(
      (evidence) =>
        evidence.pluginId === pressurePlugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded'
    );

    expect(budgetEvidence?.summary).toContain(
      'dropped ids low-priority-bulk'
    );
    expect(JSON.stringify(result.contextItems)).not.toContain('low ');
  });

  it.each([
    [
      'TencentDB',
      'tencentdb-memory-gateway.json',
      mapTencentDbMemoryGatewayFixture,
      'memory_tencentdb.gateway.fixture',
      ['tdai.recall.fixture'],
      'Mira remembers that the user prefers short implementation notes.'
    ],
    [
      'Hermes',
      'hermes-memory-provider.json',
      mapHermesMemoryProviderFixture,
      'hermes.memory_tencentdb.fixture',
      ['hermes.prefetch.fixture'],
      'Hermes prefetch recalls that Mira should keep plugin evidence compact.'
    ],
    [
      'MCP',
      'mcp-tools-resources.json',
      mapMcpToolsResourcesFixture,
      'mcp.tools_resources.fixture',
      ['mcp.resource.1', 'mcp.resource.2'],
      'MCP resource fixture: project02 has a universal plugin host contract.'
    ]
  ] as const)(
    'keeps source-backed beforeRoleModelCall context for source-required %s proof adapter',
    async (
      _name,
      fixtureName,
      mapFixture,
      expectedPluginId,
      expectedContextIds,
      expectedText
    ) => {
      const mapping = mapFixture(readAgentCapabilityFixture(fixtureName));
      const host = createRuntimePluginHost({
        plugins: [mapping.plugin],
        enabledPluginIds: [mapping.plugin.manifest.id]
      });

      const result = await host.beforeRoleModelCall(testPluginContext());

      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        throw new Error('Expected source-required proof adapter to complete.');
      }

      expect(result.runtimeNotes).toEqual([]);
      expect(result.contextItems.map((item) => item.id)).toEqual(
        expectedContextIds
      );
      expect(result.contextItems.map((item) => item.pluginId)).toEqual(
        expectedContextIds.map(() => expectedPluginId)
      );
      expect(
        result.contextItems.every((item) => item.sourceReferences.length > 0)
      ).toBe(true);
      expect(
        result.contextItems.some((item) => item.text.includes(expectedText))
      ).toBe(true);

      const acceptedEvidence = result.evidence.find(
        (evidence) =>
          evidence.pluginId === expectedPluginId &&
          evidence.evidenceKind === 'before_role_model_call' &&
          evidence.status === 'accepted'
      );

      expect(acceptedEvidence?.sourceReferences?.length).toBeGreaterThan(0);
      expect(
        result.evidence.find(
          (evidence) =>
            evidence.pluginId === expectedPluginId &&
            evidence.evidenceKind === 'before_role_model_call' &&
            evidence.status === 'degraded'
        )
      ).toBeUndefined();
    }
  );

  it('does not request model input for adapter-owned OpenClaw tools', () => {
    const mapping = mapOpenClawMemoryPluginFixture(
      readAgentCapabilityFixture('openclaw-memory-plugin.json')
    );
    const host = createRuntimePluginHost({
      plugins: [mapping.plugin],
      enabledPluginIds: [mapping.plugin.manifest.id]
    });
    const registration = host
      .registrySnapshot()
      .plugins.find(
        (plugin) => plugin.manifest.id === mapping.plugin.manifest.id
      );

    expect(mapping.plugin.manifest.requestedAccess).toEqual({});
    expect(registration).toMatchObject({
      requestedAccess: {},
      grantedAccess: {}
    });
    const adapterToolNames = new Set(
      mapping.plugin.providedTools.map((tool) => tool.name)
    );

    expect(
      host.pluginToolDefinitions().some((tool) => adapterToolNames.has(tool.name))
    ).toBe(false);
  });

  it('accepts first-party model tools as tool-provider-only mappings', () => {
    const plugin = createFirstPartyModelToolsPlugin();
    const mapping = mapFirstPartyModelToolsPlugin();

    expect(plugin.manifest.id).toBe(firstPartyModelToolsPluginId);
    expect(plugin.manifest.declaredPlugins).toEqual(['tool_provider']);
    expect(plugin.lifecycleHooks.handleToolCall).toBeUndefined();
    expect(plugin.providedTools.map((tool) => tool.name)).toEqual([
      visibleReplyModelToolName
    ]);

    expect(mapping.plugin.manifest.id).toBe(firstPartyModelToolsPluginId);
    expect(mapping.plugin.manifest.declaredPlugins).toEqual(['tool_provider']);
    expect(mapping.plugin.lifecycleHooks.handleToolCall).toBeUndefined();
    expect(mapping.plugin.providedTools.map((tool) => tool.name)).toEqual([
      visibleReplyModelToolName
    ]);
  });

  it('rejects handleToolCall hooks without a matching declaration', () => {
    expect(() => createMemorySearchPluginWithoutHandlerDeclaration()).toThrow(
      /handleToolCall hooks must declare handle_tool_call/iu
    );
  });
});

function createMemorySearchPlugin(
  id = 'memory.search.fixture',
  fails = false,
  failureMessage = 'search backend failed',
  onHandle?: () => void
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle?.();

        if (fails) {
          throw new Error(failureMessage);
        }

        const query = call.input['query'];
        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId: id,
          query,
          context
        });
      }
    }
  });
}

function createMemorySearchPluginWithInvocationProbe(
  onHandle: () => void
): RuntimePlugin {
  return createMemorySearchPlugin(
    'memory.identity-probe.fixture',
    false,
    'search backend failed',
    onHandle
  );
}

function createTurnContextCapturePlugin(options: {
  readonly pluginId: string;
  readonly requestedAccess: RuntimePlugin['manifest']['requestedAccess'];
  readonly capture: TurnContextCapture;
}): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(options.pluginId),
      declaredPlugins: ['before_role_model_call', 'after_turn_committed'],
      requestedAccess: options.requestedAccess
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        options.capture.beforeCurrentUserMessage = context.currentUserMessage;

        return {
          contextItems: [],
          runtimeNotes: [],
          evidence: []
        };
      },
      afterTurnCommitted(context) {
        options.capture.afterCurrentUserMessage = context.currentUserMessage;
        options.capture.visibleMessageIds =
          context.committedTurn.visibleMessageIds;
        options.capture.visibleMessages =
          context.committedTurn.visibleMessages;

        return {
          status: 'completed',
          evidence: []
        };
      }
    }
  });
}

function createRuntimeNotesWithoutModelInputPlugin(): RuntimePlugin {
  const pluginId = 'memory.notes-no-model-input.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call'],
      requestedAccess: {}
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall() {
        return {
          contextItems: [],
          runtimeNotes: ['undeclared model input note'],
          evidence: []
        };
      }
    }
  });
}

function createModelFacingToolWithoutModelInputPlugin(
  onHandle: () => void
): RuntimePlugin {
  const pluginId = 'memory.tool-no-model-input.fixture';

  return Object.freeze({
    manifest: createRuntimePluginManifest({
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: {}
    }),
    providedTools: Object.freeze(
      memorySearchProvidedTools().map(createRuntimePluginProvidedTool)
    ),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle();
        const query = call.input['query'];

        return createAcceptedMemorySearchResult({
          pluginId,
          query: typeof query === 'string' ? query : '',
          context
        });
      }
    }
  } satisfies RuntimePlugin);
}

function createLocalMemoryWriteToolWithoutFileStorePlugin(
  onHandle: () => void
): RuntimePlugin {
  const pluginId = 'memory.tool-no-file-store-write.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: { file_store: 'read', model_input: 'write' }
    },
    providedTools: localMemoryWriteSearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle();
        const query = call.input['query'];

        return createAcceptedMemorySearchResult({
          pluginId,
          query: typeof query === 'string' ? query : '',
          context
        });
      }
    }
  });
}

function createDegradableMemorySearchPlugin(onHandle: () => void): RuntimePlugin {
  const id = 'memory.degradable.fixture';
  const manifest = memorySearchPluginManifest(id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        failureBehavior: {
          ...manifest.runtimePolicy.failureBehavior,
          handleToolCall: 'degrade'
        }
      }
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle();
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId: id,
          query,
          context
        });
      }
    }
  });
}

function createConfirmationRequiredMemorySearchPlugin(
  onHandle: () => void = () => {}
): RuntimePlugin {
  const id = 'memory.confirmation-required.fixture';
  const manifest = memorySearchPluginManifest(id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        confirmation: 'required'
      }
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle();
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId: id,
          query,
          context
        });
      }
    }
  });
}

function createExternalReadMemorySearchPlugin(onHandle: () => void): RuntimePlugin {
  const id = 'memory.external-read.fixture';
  const manifest = memorySearchPluginManifest(id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        sideEffectLevel: 'external_read'
      }
    },
    providedTools: memorySearchProvidedTools().map((tool) => ({
      ...tool,
      sideEffectLevel: 'external_read' as const
    })),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle();
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId: id,
          query,
          context
        });
      }
    }
  });
}

function createCredentialKeyOutputPlugin(): RuntimePlugin {
  const id = 'memory.credential-key-output.fixture';

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'accepted',
          output: {
            api_key: 'super-secret',
            nested: {
              password: 'open-sesame',
              safe: 'kept'
            },
            list: [
              {
                access_token: 'secret-token',
                label: 'kept'
              }
            ]
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Search completed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createProtoKeyOutputPlugin(): RuntimePlugin {
  const id = 'memory.proto-output.fixture';

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'accepted',
          output: createProtoKeyOutput(),
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Search completed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createProtoKeyOutput(): RuntimePluginJsonObject {
  const nested: Record<string, RuntimePluginJsonValue> = {};
  Object.defineProperty(nested, '__proto__', {
    value: 'nested-value',
    enumerable: true
  });

  const output: Record<string, RuntimePluginJsonValue> = {
    nested
  };
  Object.defineProperty(output, '__proto__', {
    value: {
      polluted: true
    },
    enumerable: true
  });

  return output;
}

function createRejectingMemorySearchPlugin(options: {
  readonly id?: string;
  readonly handleToolCallFailure?: 'reject_tool_call' | 'degrade';
  readonly rejectionReason?: string;
  readonly rejectionMessage?: string;
} = {}): RuntimePlugin {
  const id = options.id ?? 'memory.rejecting.fixture';
  const manifest = memorySearchPluginManifest(id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        failureBehavior: {
          ...manifest.runtimePolicy.failureBehavior,
          handleToolCall:
            options.handleToolCallFailure ??
            manifest.runtimePolicy.failureBehavior.handleToolCall
        }
      }
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'rejected',
          reason: options.rejectionReason ?? 'handler_rejected',
          message:
            options.rejectionMessage ??
            'lookup failed credential="open-sesame" https://user:pass@example.test/?token=abc',
          evidence: []
        };
      }
    }
  });
}

function createDegradedRejectingMemorySearchPlugin(): RuntimePlugin {
  const id = 'memory.rejecting.optional-degraded.fixture';

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'rejected',
          reason: 'handler_rejected',
          message: 'search backend degraded',
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: 'degraded',
              summary: 'search backend degraded',
              policyOutcome: 'optional_degraded',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createAcceptedBlockingEvidenceMemorySearchPlugin(
  evidenceStatus: 'rejected' | 'failed'
): RuntimePlugin {
  const id = `memory.accepted-blocking.${evidenceStatus}.fixture`;

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return {
          status: 'accepted',
          output: {
            matched: query
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: evidenceStatus,
              summary: 'Search did not complete.',
              policyOutcome:
                evidenceStatus === 'failed' ? 'timeout' : 'handler_rejected',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createSourceRequiredMemorySearchPlugin(options: {
  readonly id: string;
  readonly evidenceKinds: readonly ('policy' | 'health' | 'tool_invocation')[];
  readonly handleToolCallFailure?: 'reject_tool_call' | 'degrade';
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        failureBehavior: {
          ...manifest.runtimePolicy.failureBehavior,
          handleToolCall:
            options.handleToolCallFailure ??
            manifest.runtimePolicy.failureBehavior.handleToolCall
        }
      }
    },
    providedTools: memorySearchProvidedTools().map((tool) =>
      Object.freeze({
        ...tool,
        sourceReferencesRequired: true
      })
    ),
    lifecycleHooks: {
      handleToolCall(call, context) {
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return {
          status: 'accepted',
          output: {
            matched: query
          },
          evidence: options.evidenceKinds.map((evidenceKind) =>
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.id,
              evidenceKind,
              status: 'accepted',
              summary: `${evidenceKind} evidence.`,
              sourceReferences: [
                {
                  kind: 'memory',
                  id: `source.${evidenceKind}`,
                  title: `${evidenceKind} source`
                }
              ],
              redactionLabels: []
            })
          )
        };
      }
    }
  });
}

function createAcceptedMemorySearchResult(options: {
  readonly pluginId: string;
  readonly query: string;
  readonly context: RuntimePluginContext;
}): RuntimePluginToolCallResult {
  return {
    status: 'accepted',
    output: {
      matched: options.query
    },
    evidence: [
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.pluginId,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: 'Search completed.',
        redactionLabels: []
      })
    ]
  };
}

function createMemorySearchToolProviderOnlyPlugin(): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest('memory.tool-provider-only.fixture'),
      declaredPlugins: ['tool_provider']
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {}
  });
}

function createRuntimeNotesPlugin(): RuntimePlugin {
  const pluginId = 'memory.notes.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call']
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [],
          runtimeNotes: [
            `${'large note '.repeat(140)}api_key=super-secret`,
            'short note'
          ],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Notes loaded.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createSourceRequiredRuntimeNotesPlugin(options: {
  readonly id: string;
  readonly requiredForTurn?: boolean;
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      declaredPlugins: ['before_role_model_call'],
      runtimePolicy: {
        ...manifest.runtimePolicy,
        requiredForTurn: options.requiredForTurn ?? false,
        sourceReferencesRequired: true
      }
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [],
          runtimeNotes: ['unsourced runtime note'],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.id,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Loaded runtime note.',
              sourceReferences: [
                {
                  kind: 'memory',
                  id: 'source.before_role_model_call'
                }
              ],
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createAcceptedBlockingBeforeRoleModelCallPlugin(options: {
  readonly id: string;
  readonly requiredForTurn?: boolean;
  readonly evidenceStatus: 'rejected' | 'failed';
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      declaredPlugins: ['before_role_model_call'],
      runtimePolicy: {
        ...manifest.runtimePolicy,
        requiredForTurn: options.requiredForTurn ?? false
      }
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: options.id,
              id: 'blocked-context',
              kind: 'memory',
              text: 'blocked context',
              budget: {
                estimatedTokens: 1,
                priority: 1
              },
              sourceReferences: [],
              redactionLabels: context.privacy.redactionLabels
            })
          ],
          runtimeNotes: ['blocked runtime note'],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.id,
              evidenceKind: 'before_role_model_call',
              status: options.evidenceStatus,
              summary: 'Before-role-model context blocked.',
              policyOutcome:
                options.evidenceStatus === 'failed'
                  ? 'timeout'
                  : options.requiredForTurn === true
                    ? 'required_rejected'
                    : 'handler_rejected',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createUnderestimatedContextItemPlugin(): RuntimePlugin {
  const pluginId = 'memory.underestimated-context.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call']
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId,
              id: 'oversized-context',
              kind: 'memory',
              text: 'oversized context '.repeat(160),
              budget: {
                estimatedTokens: 1,
                priority: 1
              },
              sourceReferences: [],
              redactionLabels: context.privacy.redactionLabels
            })
          ],
          runtimeNotes: [],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Loaded oversized context item.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createLowPriorityBudgetPressurePlugin(): RuntimePlugin {
  const pluginId = 'memory.low-priority-budget-pressure.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call']
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId,
              id: 'low-priority-bulk',
              kind: 'memory',
              text: 'low '.repeat(254),
              budget: {
                estimatedTokens: 254,
                priority: 1
              },
              sourceReferences: [],
              redactionLabels: context.privacy.redactionLabels
            })
          ],
          runtimeNotes: ['runtime note from host'],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Loaded low-priority budget pressure context.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createRetainedBeforeRoleModelFileStorePlugin(
  retainFileStore: (fileStore: RuntimePluginFileStore) => void
): RuntimePlugin {
  const pluginId = 'memory.retained-before.fixture';
  const manifest = memorySearchPluginManifest(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        sideEffectLevel: 'local_memory_write'
      },
      declaredPlugins: ['before_role_model_call'],
      requestedAccess: { file_store: 'write' }
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        writeDuringHookAndRetainFileStore({
          context,
          path: 'during-before.json',
          retainFileStore
        });

        return {
          contextItems: [],
          runtimeNotes: [],
          evidence: []
        };
      }
    }
  });
}

function createReadOnlyFileStoreProbePlugin(): RuntimePlugin {
  const pluginId = 'memory.read-only-file-store.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: { file_store: 'write', model_input: 'write' }
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        if (context.fileStore === undefined) {
          throw new Error('Expected read-only tool context to include fileStore.');
        }

        const seed = context.fileStore.readJson('seed.json');
        if (seed === undefined) {
          throw new Error('Expected seeded fileStore value.');
        }
        let writeBlocked = false;

        try {
          context.fileStore.writeJsonAtomic('read-only-write.json', {
            value: 'blocked'
          });
        } catch {
          writeBlocked = true;
        }

        return {
          status: 'accepted',
          output: {
            seed,
            writeBlocked
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Read-only fileStore probe completed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createReadOnlyBeforeRoleModelFileStoreProbePlugin(): RuntimePlugin {
  const pluginId = 'memory.read-only-before-file-store.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call'],
      requestedAccess: { file_store: 'write', model_input: 'write' }
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        if (context.fileStore === undefined) {
          throw new Error('Expected read-only hook context to include fileStore.');
        }

        const seed = context.fileStore.readJson('seed.json');
        if (seed === undefined) {
          throw new Error('Expected seeded fileStore value.');
        }
        let writeBlocked = false;

        try {
          context.fileStore.writeJsonAtomic('read-only-hook-write.json', {
            value: 'blocked'
          });
        } catch {
          writeBlocked = true;
        }

        return {
          contextItems: [],
          runtimeNotes: [
            JSON.stringify({
              seed,
              writeBlocked
            })
          ],
          evidence: []
        };
      }
    }
  });
}

function createRetainedHandleToolCallFileStorePlugin(
  retainFileStore: (fileStore: RuntimePluginFileStore) => void
): RuntimePlugin {
  const pluginId = 'memory.retained-handle.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: { file_store: 'write', model_input: 'write' }
    },
    providedTools: localMemoryWriteSearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        writeDuringHookAndRetainFileStore({
          context,
          path: 'during-handle.json',
          retainFileStore
        });

        const query = call.input['query'];
        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId,
          query,
          context
        });
      }
    }
  });
}

function createStagedAppendFileStorePlugin(): RuntimePlugin {
  const pluginId = 'memory.staged-append.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: { file_store: 'write', model_input: 'write' }
    },
    providedTools: localMemoryWriteSearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        if (context.fileStore === undefined) {
          throw new Error('Expected staged append fixture to receive fileStore.');
        }

        const query = call.input['query'];
        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        context.fileStore.appendJsonl('events.jsonl', {
          value: query,
          traceId: context.traceId
        });

        return createAcceptedMemorySearchResult({
          pluginId,
          query,
          context
        });
      }
    }
  });
}

function createRetainedHealthFileStorePlugin(
  retainFileStore: (fileStore: RuntimePluginFileStore) => void
): RuntimePlugin {
  const pluginId = 'memory.retained-health.fixture';
  const manifest = memorySearchPluginManifest(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        sideEffectLevel: 'local_memory_write'
      },
      declaredPlugins: ['health'],
      requestedAccess: { file_store: 'write' }
    },
    providedTools: [],
    lifecycleHooks: {
      health(context) {
        writeDuringHookAndRetainFileStore({
          context,
          path: 'during-health.json',
          retainFileStore
        });

        return createRuntimePluginHealthSnapshot({
          pluginId,
          status: 'ok',
          checkedAt: context.timestamp,
          summary: 'Health check completed.',
          redactionLabels: []
        });
      }
    }
  });
}

function writeDuringHookAndRetainFileStore(options: {
  readonly context: RuntimePluginContext;
  readonly path: string;
  readonly retainFileStore: (fileStore: RuntimePluginFileStore) => void;
}): void {
  if (options.context.fileStore === undefined) {
    throw new Error('Expected plugin hook context to include fileStore.');
  }

  options.context.fileStore.writeJsonAtomic(options.path, {
    value: 'during'
  });
  options.retainFileStore(options.context.fileStore);
}

function expectRetainedFileStoreWriteBlocked(
  fileStore: RuntimePluginFileStore | undefined,
  path: string
): void {
  if (fileStore === undefined) {
    throw new Error('Expected retained fileStore.');
  }

  expect(() => {
    fileStore.writeJsonAtomic(path, {
      value: 'after'
    });
  }).toThrow(/after hook completion/iu);
}

function createPluginHostTestFileStore(options: {
  readonly pluginId: string;
  readonly sessionIdentity: object;
}): RuntimePluginFileStore {
  return createRuntimePluginFileStore({
    sessionId: 'session-plugin-host',
    sessionIdentity: options.sessionIdentity,
    pluginId: options.pluginId
  });
}

function createLateFileStoreWritePlugin(options: {
  readonly continueAfterTimeout: Promise<null>;
  readonly recordLateWriteOutcome: (outcome: LateFileStoreWriteOutcome) => void;
}): RuntimePlugin {
  const pluginId = 'memory.late-file-store-write.fixture';
  const manifest = memorySearchPluginManifest(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        timeoutMs: 5
      },
      requestedAccess: { file_store: 'write', model_input: 'write' }
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      async handleToolCall(_call, context) {
        await options.continueAfterTimeout;

        if (context.fileStore === undefined) {
          options.recordLateWriteOutcome('missing_file_store');
          return createAcceptedMemorySearchResult({
            pluginId,
            query: 'missing-file-store',
            context
          });
        }

        try {
          context.fileStore.writeJsonAtomic('late-write.json', {
            value: 'late'
          });
          options.recordLateWriteOutcome('written');
        } catch {
          options.recordLateWriteOutcome('blocked');
        }

        return createAcceptedMemorySearchResult({
          pluginId,
          query: 'late-write',
          context
        });
      }
    }
  });
}

function createMemorySearchPluginWithoutHandlerDeclaration(): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest('memory.handler-mismatch.fixture'),
      declaredPlugins: ['tool_provider']
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall() {
        throw new Error('Handler should not run for invalid plugin fixture.');
      }
    }
  });
}

async function callFileStoreAvailabilityProbe(
  host: RuntimePluginHost,
  plugin: RuntimePlugin,
  context: RuntimePluginContext = testPluginContext()
): Promise<RuntimePluginToolCallResult> {
  return await host.handleToolCall(
    {
      ...testIdentity(),
      pluginId: plugin.manifest.id,
      toolName: 'memory.search',
      input: {
        query: 'Mira'
      }
    },
    context
  );
}

function createFileStoreAvailabilityProbePlugin(options: {
  readonly pluginId: string;
  readonly requestedAccess: RuntimePlugin['manifest']['requestedAccess'];
  readonly localTrustLevel?: RuntimePlugin['manifest']['localTrustLevel'];
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      localTrustLevel: options.localTrustLevel ?? manifest.localTrustLevel,
      requestedAccess: options.requestedAccess
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'accepted',
          output: {
            fileStoreAvailable: context.fileStore !== undefined
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.pluginId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'File store availability probe completed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createSessionEndFileStoreProbePlugin(options: {
  readonly pluginId: string;
  readonly requestedAccess: RuntimePlugin['manifest']['requestedAccess'];
  readonly onSessionEnd: (context: RuntimePluginContext) => void;
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      declaredPlugins: ['on_session_end'],
      runtimePolicy: {
        ...manifest.runtimePolicy,
        sideEffectLevel: 'local_memory_write'
      },
      requestedAccess: options.requestedAccess
    },
    providedTools: [],
    lifecycleHooks: {
      onSessionEnd(context) {
        options.onSessionEnd(context);

        return {
          status: 'completed',
          evidence: []
        };
      }
    }
  });
}

function memorySearchPluginManifest(id: string) {
  return {
    id,
    displayName: 'Memory Search Fixture',
    version: '1.0.0',
    kind: 'memory_provider',
    description: 'Test plugin.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test'
    },
    declaredPlugins: ['tool_provider', 'handle_tool_call'],
    config: {
      fields: []
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: {
      requiredForTurn: false,
      sideEffectLevel: 'runtime_read',
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: false,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        afterTurnCommitted: 'log_failure',
        health: 'degrade'
      }
    },
    activation: {
      defaultEnabled: true,
      reasons: ['test']
    },
    requestedAccess: { model_input: 'write' }
  };
}

function memorySearchProvidedTools() {
  return [
    {
      name: 'memory.search',
      description: 'Search memory.',
      requiredForUserTurn: false,
      callLimit: {
        scope: 'user_turn',
        maxCalls: 1
      },
      inputContract: {
        type: 'object',
        fields: [
          {
            name: 'query',
            description: 'Search query.',
            required: true
          }
        ],
        additionalFields: false
      },
      validationOwner: 'plugin_host',
      sideEffectLevel: 'runtime_read',
      requiresConfirmation: false,
      sourceReferencesRequired: false
    }
  ];
}

function localMemoryWriteSearchProvidedTools() {
  return memorySearchProvidedTools().map((tool) =>
    Object.freeze({
      ...tool,
      sideEffectLevel: 'local_memory_write' as const
    })
  );
}

function testPluginContext(
  identity: {
    readonly eventId?: string;
    readonly traceId?: string;
    readonly createdAt?: string;
  } = {}
) {
  return createRuntimePluginContext({
    ...testIdentity(identity),
    sessionId: 'session-plugin-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

function testPluginAfterTurnCommittedContext(
  identity: {
    readonly eventId?: string;
    readonly traceId?: string;
  } = {}
) {
  return createRuntimePluginAfterTurnCommittedContext({
    ...testIdentity(identity),
    sessionId: 'session-plugin-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: {
      id: 'mira',
      displayName: 'Mira'
    },
    committedAt: '2026-06-15T00:00:00.000Z',
    visibleMessages: []
  });
}

function testIdentity(
  options: {
    readonly eventId?: string;
    readonly traceId?: string;
    readonly createdAt?: string;
  } = {}
) {
  return createRuntimeEventIdentity({
    eventId: options.eventId ?? 'evt_plugin_host',
    traceId: options.traceId ?? 'trace_plugin_host',
    createdAt: options.createdAt ?? '2026-06-15T00:00:00.000Z'
  });
}

function readAgentCapabilityFixture(fileName: string): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL(`./fixtures/agent-capabilities/${fileName}`, import.meta.url),
      'utf8'
    )
  );

  return parsed;
}

function expectJsonObject(
  value: RuntimePluginJsonValue | undefined
): RuntimePluginJsonObject {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    isJsonArray(value)
  ) {
    throw new Error('Expected JSON object.');
  }

  return value;
}

function isJsonArray(
  value: RuntimePluginJsonValue
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] | undefined;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });

  if (resolve === undefined) {
    throw new Error('Expected deferred promise resolver to be initialized.');
  }

  return Object.freeze({
    promise,
    resolve
  });
}
