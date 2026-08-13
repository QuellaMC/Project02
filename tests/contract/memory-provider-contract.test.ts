import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  createMemoryProviderRuntimePlugin,
  type Project02MemoryProvider,
} from '../../src/plugins/builtin/memory-provider/index.ts';
import {
  createRuntimePluginContext,
  createRuntimePluginManifest,
  runtimePluginContractVersion,
} from '../../src/plugins/api/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {createRuntimePluginAfterTurnCommittedContext} from '../../src/plugins/api/index.ts';
import {
  runMemoryProviderConformanceSuite,
  type MemoryProviderConformanceScenario,
} from '../support/memory-provider-conformance.ts';

const referencePluginId = 'memory.reference';

/**
 * The reference in-memory implementation every adapter is measured against:
 * a provider that simply honors the scenario seed.
 */
function createReferenceProvider(
  scenario: MemoryProviderConformanceScenario,
): Project02MemoryProvider {
  return {
    id: referencePluginId,
    displayName: 'Reference Memory Provider',
    recall() {
      return Promise.resolve({items: scenario.recallItems ?? []});
    },
    captureTurn() {
      return Promise.resolve(
        scenario.captureResult ?? {captured: false, summary: 'Nothing.'},
      );
    },
    search() {
      return Promise.resolve({items: scenario.searchItems ?? []});
    },
    add() {
      return Promise.resolve(
        scenario.addResult ?? {id: 'reference-add', sourceReferences: []},
      );
    },
    health() {
      return Promise.resolve(
        scenario.healthResult ?? {status: 'ok', summary: 'Reference ready.'},
      );
    },
    endSession(sessionId) {
      scenario.lifecycleProbe?.endedSessions.push(sessionId);

      return Promise.resolve();
    },
    close() {
      if (scenario.lifecycleProbe !== undefined) {
        scenario.lifecycleProbe.closeCalls += 1;
      }

      return Promise.resolve();
    },
  };
}

runMemoryProviderConformanceSuite({
  name: 'reference in-memory provider',
  pluginId: referencePluginId,
  capabilities: new Set([
    'recall',
    'captureTurn',
    'search',
    'add',
    'health',
    'endSession',
    'close',
  ]),
  provesSeamGuarantees: true,
  createPlugin(scenario) {
    return createMemoryProviderRuntimePlugin(createReferenceProvider(scenario));
  },
});

describe('memory provider runtime plugin factory', () => {
  it('declares only implemented provider methods', () => {
    const recallOnly = createMemoryProviderRuntimePlugin({
      id: 'memory.recall-only',
      displayName: 'Recall Only',
      recall() {
        return Promise.resolve({items: []});
      },
    });
    const captureOnly = createMemoryProviderRuntimePlugin({
      id: 'memory.capture-only',
      displayName: 'Capture Only Provider',
      captureTurn() {
        return Promise.resolve({captured: true, summary: 'Captured.'});
      },
    });

    expect(recallOnly.manifest.kind).toBe('memory_provider');
    expect(recallOnly.manifest.declaredPlugins).toEqual(
      expect.arrayContaining(['before_role_model_call']),
    );
    expect(recallOnly.manifest.declaredPlugins).not.toContain(
      'handle_tool_call',
    );
    expect(recallOnly.providedTools).toEqual([]);
    expect(recallOnly.manifest.runtimePolicy.failureBehavior).toMatchObject({
      beforeRoleModelCall: 'degrade',
      health: 'degrade',
    });
    expect(captureOnly.manifest.requestedAccess.file_store).toBeUndefined();
    expect(captureOnly.manifest.declaredPlugins).toContain(
      'after_turn_committed',
    );
    expect(captureOnly.manifest.declaredPlugins).not.toContain(
      'handle_tool_call',
    );
  });

  it('namespaces tools by the provider id unless overridden', () => {
    const provider: Project02MemoryProvider = {
      id: 'mem-fixture',
      displayName: 'Namespace Fixture',
      search() {
        return Promise.resolve({items: []});
      },
      add() {
        return Promise.resolve({id: 'added', sourceReferences: []});
      },
    };

    expect(
      createMemoryProviderRuntimePlugin(provider).providedTools.map(
        tool => tool.name,
      ),
    ).toEqual(['mem-fixture.search', 'mem-fixture.add']);
    expect(
      createMemoryProviderRuntimePlugin(provider, {
        toolNamespace: 'memory',
      }).providedTools.map(tool => tool.name),
    ).toEqual(['memory.search', 'memory.add']);
  });

  it('hands the provider the turn scope and source references', async () => {
    let searchDeadlineAt: number | undefined;
    let searchSignal: AbortSignal | undefined;
    let captureSourceReferences: unknown;
    let closeDeadlineAt: number | undefined;
    let closeSignal: AbortSignal | undefined;
    const provider: Project02MemoryProvider = {
      id: 'memory.scope-probe',
      displayName: 'Scope Probe Provider',
      captureTurn(turn) {
        captureSourceReferences = turn.sourceReferences;

        return Promise.resolve({captured: true, summary: 'Captured.'});
      },
      search(request) {
        searchDeadlineAt = request.deadlineAt;
        searchSignal = request.signal;

        return Promise.resolve({items: []});
      },
      close(scope) {
        closeDeadlineAt = scope.deadlineAt;
        closeSignal = scope.signal;

        return Promise.resolve();
      },
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id],
    });

    await host.handleToolCall(
      {
        eventId: 'evt_memory',
        traceId: 'trace_memory',
        createdAt: '2026-06-21T00:00:00.000Z',
        pluginId: provider.id,
        toolName: 'memory.scope-probe.search',
        input: {query: 'prior'},
      },
      testContext(),
    );
    await host.afterTurnCommitted(afterTurnContext());
    await host.shutdown(testContext());

    expect(searchDeadlineAt).toBeTypeOf('number');
    expect(searchDeadlineAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(searchSignal?.aborted).toBe(false);
    expect(captureSourceReferences).toEqual([
      {
        kind: 'conversation',
        id: 'evt_memory',
        title: 'Current conversation turn',
      },
    ]);
    expect(closeDeadlineAt).toBeGreaterThan(Date.now());
    expect(closeSignal).toBeInstanceOf(AbortSignal);
    expect(closeSignal?.aborted).toBe(false);
  });

  it('adopts a consistent supplied manifest wholesale', () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.packaged',
      displayName: 'Packaged Provider',
      recall() {
        return Promise.resolve({items: []});
      },
      search() {
        return Promise.resolve({items: []});
      },
    };
    const manifest = packagedProviderManifest();
    const plugin = createMemoryProviderRuntimePlugin(provider, {manifest});

    expect(plugin.manifest).toEqual(manifest);
    expect(plugin.providedTools.map(tool => tool.name)).toEqual([
      'memory.packaged.search',
    ]);
  });

  it('rejects supplied manifests that diverge from the provider', () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.packaged',
      displayName: 'Packaged Provider',
      recall() {
        return Promise.resolve({items: []});
      },
      search() {
        return Promise.resolve({items: []});
      },
    };

    expect(() =>
      createMemoryProviderRuntimePlugin(provider, {
        manifest: packagedProviderManifest(),
        pluginId: 'memory.other',
      }),
    ).toThrow('cannot combine with pluginId or version overrides');
    expect(() =>
      createMemoryProviderRuntimePlugin(provider, {
        manifest: packagedProviderManifest({kind: 'context_provider'}),
      }),
    ).toThrow('must have kind "memory_provider"');
    expect(() =>
      createMemoryProviderRuntimePlugin(provider, {
        manifest: packagedProviderManifest({requestedAccess: {}}),
      }),
    ).toThrow('must request turn_context "read"');
    expect(() =>
      createMemoryProviderRuntimePlugin(provider, {
        manifest: packagedProviderManifest({
          declaredPlugins: ['plugin_discovery'],
        }),
      }),
    ).toThrow(/declare/u);
  });
});

function packagedProviderManifest(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return createRuntimePluginManifest({
    id: 'memory.packaged',
    displayName: 'Packaged Provider',
    version: '2.0.0',
    kind: 'memory_provider',
    description: 'Packaged memory provider fixture.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
    },
    declaredPlugins: [
      'before_role_model_call',
      'tool_provider',
      'handle_tool_call',
    ],
    config: {
      scope: 'global_with_character_overrides',
      fields: [],
    },
    firstParty: false,
    runtimePolicy: {
      timeoutMs: 8000,
      redactionLabels: ['memory'],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'degrade',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: false,
      reasons: ['memory_provider_package'],
    },
    requestedAccess: {turn_context: 'read', model_input: 'write'},
    ...overrides,
  });
}

function testContext() {
  return createRuntimePluginContext({
    eventId: 'evt_memory',
    traceId: 'trace_memory',
    createdAt: '2026-06-21T00:00:00.000Z',
    sessionId: 'session-memory',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: testCharacterProfile,
  });
}

function afterTurnContext() {
  return createRuntimePluginAfterTurnCommittedContext({
    eventId: 'evt_memory',
    traceId: 'trace_memory',
    createdAt: '2026-06-21T00:00:00.000Z',
    sessionId: 'session-memory',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: testCharacterProfile,
    committedAt: '2026-06-21T00:00:01.000Z',
    visibleMessages: [
      {
        id: 'visible-character',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'done',
      },
    ],
  });
}
