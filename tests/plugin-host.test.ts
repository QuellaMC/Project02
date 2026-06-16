import { describe, expect, it } from 'vitest';

import {
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  createFirstPartyModelToolsPlugin,
  createRuntimePlugin,
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  firstPartyModelToolsPluginId,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';
import {
  createRuntimePluginHost,
  runtimePluginDiscoveryPluginId
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
  mapFirstPartyModelToolsPlugin
} from '../src/plugins/adapter-proofs/index.ts';
import {
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';
import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin
} from '../src/plugins/builtin/character-state/index.ts';

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
};

type LateFileStoreWriteOutcome = 'blocked' | 'missing_file_store' | 'written';

describe('runtime plugin host', () => {
  it('routes plugin.list through the host-owned discovery plugin', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [runtimePluginDiscoveryPluginId, plugin.manifest.id]
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
          id: 'memory.search.fixture'
        }
      ]
    });
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
    const host = createRuntimePluginHost({ plugins: [plugin] });

    expect(host.pluginToolDefinitions().map((tool) => tool.name)).not.toContain(
      'memory.search'
    );
    expect(host.resolveToolPluginId('memory.search')).toBeUndefined();
  });

  it('does not expose tools when the plugin manifest requires confirmation', async () => {
    const plugin = createConfirmationRequiredMemorySearchPlugin();
    const host = createRuntimePluginHost({ plugins: [plugin] });

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

  it('turns handler failures into redacted rejected tool observations', async () => {
    const plugin = createMemorySearchPlugin(
      'memory.failing',
      true,
      'search backend failed api_key=super-secret Bearer secret-token'
    );
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({
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

  it('withholds fileStore writes from read-only handleToolCall tools', async () => {
    const sessionIdentity = {};
    const plugin = createReadOnlyFileStoreProbePlugin();
    const host = createRuntimePluginHost({
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
    const host = createRuntimePluginHost({
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
    const host = createRuntimePluginHost({
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

  it('blocks retained fileStore writes after handleToolCall completes', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedHandleToolCallFileStorePlugin((fileStore) => {
      retainedFileStore = fileStore;
    });
    const host = createRuntimePluginHost({
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

    expect(result.status).toBe('accepted');
    expectRetainedFileStoreWriteBlocked(retainedFileStore, 'after-handle.json');

    const fileStore = createPluginHostTestFileStore({
      pluginId: plugin.manifest.id,
      sessionIdentity
    });

    expect(fileStore.readJson('during-handle.json')).toBeUndefined();
    expect(fileStore.readJson('after-handle.json')).toBeUndefined();
    expect(fileStore.revision()).toBe(0);

    const afterCommitResult = await host.afterTurnCommitted(
      testPluginAfterTurnCommittedContext()
    );

    expect(afterCommitResult.status).toBe('completed');
    expect(fileStore.readJson('during-handle.json')).toEqual({ value: 'during' });
    expect(fileStore.revision()).toBe(1);
  });

  it('discards staged handleToolCall fileStore writes for a rejected turn context', async () => {
    const sessionIdentity = {};
    const plugin = createStagedAppendFileStorePlugin();
    const host = createRuntimePluginHost({
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

    host.discardStagedFileStoreWrites(context);

    const afterCommitResult = await host.afterTurnCommitted(
      testPluginAfterTurnCommittedContext()
    );

    expect(afterCommitResult.status).toBe('completed');
    expect(fileStore.readJsonl('events.jsonl')).toEqual([]);
    expect(fileStore.revision()).toBe(0);
  });

  it('isolates staged handleToolCall fileStore writes by trace for same-turn retries', async () => {
    const sessionIdentity = {};
    const plugin = createStagedAppendFileStorePlugin();
    const host = createRuntimePluginHost({
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

    const afterCommitResult = await host.afterTurnCommitted(
      testPluginAfterTurnCommittedContext({
        eventId: 'evt_same_turn_retry',
        traceId: 'trace_retry_attempt'
      })
    );

    expect(afterCommitResult.status).toBe('completed');
    expect(fileStore.readJsonl('events.jsonl')).toEqual([
      {
        value: 'retry-attempt',
        traceId: 'trace_retry_attempt'
      }
    ]);
    expect(fileStore.revision()).toBe(1);
  });

  it('blocks retained fileStore writes after health completes', async () => {
    let retainedFileStore: RuntimePluginFileStore | undefined;
    const sessionIdentity = {};
    const plugin = createRetainedHealthFileStorePlugin((fileStore) => {
      retainedFileStore = fileStore;
    });
    const host = createRuntimePluginHost({
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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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

  it('preserves degraded evidence from optional rejected plugin tool results', async () => {
    const plugin = createDegradedRejectingMemorySearchPlugin();
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
      const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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

  it('budgets beforeRoleModelCall runtime notes before prompting', async () => {
    const plugin = createRuntimeNotesPlugin();
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({ plugins: [plugin] });

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
    const host = createRuntimePluginHost({
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
  failureMessage = 'search backend failed'
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
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

function createConfirmationRequiredMemorySearchPlugin(): RuntimePlugin {
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
          reason: 'handler_rejected',
          message:
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
      requestedApis: ['file_store']
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
      requestedApis: ['file_store']
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
      requestedApis: ['file_store']
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
      requestedApis: ['file_store']
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
      requestedApis: ['file_store']
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
      requestedApis: ['file_store']
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
      requestedApis: ['file_store']
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
    requestedApis: []
  };
}

function memorySearchProvidedTools() {
  return [
    {
      name: 'memory.search',
      description: 'Search memory.',
      requiredForUserTurn: false,
      maxCallsPerUserTurn: 1,
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
  } = {}
) {
  return createRuntimeEventIdentity({
    eventId: options.eventId ?? 'evt_plugin_host',
    traceId: options.traceId ?? 'trace_plugin_host',
    createdAt: '2026-06-15T00:00:00.000Z'
  });
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
