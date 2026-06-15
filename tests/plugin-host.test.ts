import { describe, expect, it } from 'vitest';

import {
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  createFirstPartyModelToolsPlugin,
  createRuntimePlugin,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
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

  it('does not resolve tool-provider-only plugin tools as routable', () => {
    const plugin = createMemorySearchToolProviderOnlyPlugin();
    const host = createRuntimePluginHost({ plugins: [plugin] });

    expect(host.pluginToolDefinitions().map((tool) => tool.name)).not.toContain(
      'memory.search'
    );
    expect(host.resolveToolPluginId('memory.search')).toBeUndefined();
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

function createRejectingMemorySearchPlugin(): RuntimePlugin {
  const id = 'memory.rejecting.fixture';

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
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

function testPluginContext() {
  return createRuntimePluginContext({
    ...testIdentity(),
    sessionId: 'session-plugin-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_plugin_host',
    traceId: 'trace_plugin_host',
    createdAt: '2026-06-15T00:00:00.000Z'
  });
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
