import {testCharacterProfile} from '../support/character-fixtures.ts';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {createRuntimePluginContext} from '../../src/plugins/api/index.ts';
import type {RuntimePluginFactoryInput} from '../../src/plugins/api/factory.ts';
import type {ResolvedPluginRuntimeConfig} from '../../src/runtime/config/index.ts';
import {createMemoryProviderRuntimePlugin} from '../../src/plugins/builtin/memory-provider/index.ts';
import {createProject02Plugin} from '../../src/plugins/packages/hermes-compat/index.ts';
import {
  createHermesCompatPluginManifest,
  hermesCompatPluginId,
} from '../../src/plugins/packages/hermes-compat/plugin.ts';
import {wrapHermesMemoryProvider} from '../../src/plugins/packages/hermes-compat/foreign.ts';
import {
  runMemoryProviderConformanceSuite,
  type MemoryProviderConformanceScenario,
} from '../support/memory-provider-conformance.ts';

const fixturesRoot = join(
  process.cwd(),
  'tests',
  'fixtures',
  'hermes-memory-provider',
);

runMemoryProviderConformanceSuite({
  name: 'hermes-compat wrapper over a scenario-backed module',
  pluginId: hermesCompatPluginId,
  capabilities: new Set(['recall', 'captureTurn', 'search', 'close']),
  createPlugin(scenario) {
    return createMemoryProviderRuntimePlugin(
      wrapHermesMemoryProvider(scenarioForeignProvider(scenario)),
      {toolNamespace: hermesCompatPluginId},
    );
  },
});

describe('Hermes memory-provider compat plugin', () => {
  it('mounts a pinned-v1 module with the compat tool surface', async () => {
    const manifest = createHermesCompatPluginManifest();
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'provider.mjs')),
    );

    expect(plugin.manifest).toEqual(manifest);
    expect(plugin.providedTools.map(tool => tool.name)).toEqual([
      'hermes-compat.search',
    ]);
  });

  it('bridges prefetch, turn sync, and search through the module', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'provider.mjs')),
    );

    const before =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(compatContext());
    const search = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: hermesCompatPluginId,
        toolName: 'hermes-compat.search',
        input: {query: 'prior sessions'},
      },
      compatContext(),
    );

    expect(before?.contextItems[0]).toMatchObject({
      pluginId: hermesCompatPluginId,
      kind: 'memory',
      text: 'Prefetched for "remember this" after 0 synced turn(s).',
      sourceReferences: [{kind: 'memory', id: 'row-1', title: 'Fixture row'}],
    });
    expect(search).toMatchObject({
      status: 'accepted',
      output: {items: [{id: 'search-1'}]},
    });
  });

  it('rejects modules that do not satisfy the pinned v1 interface', async () => {
    await expect(
      createProject02Plugin(
        compatFactoryInput(join(fixturesRoot, 'missing-sync.mjs')),
      ),
    ).rejects.toThrow('does not implement pinned v1 member "syncTurn"');
    await expect(
      createProject02Plugin(compatFactoryInput('relative/provider.mjs')),
    ).rejects.toThrow('must be an absolute path');
    await expect(
      createProject02Plugin({
        ...compatFactoryInput(join(fixturesRoot, 'provider.mjs')),
        resolvedConfig: {},
      }),
    ).rejects.toThrow('needs the modulePath config field');
  });
});

function scenarioForeignProvider(scenario: MemoryProviderConformanceScenario) {
  return {
    prefetch() {
      return {items: foreignRows(scenario.recallItems ?? [])};
    },
    syncTurn() {
      const capture = scenario.captureResult;

      if (capture === undefined || !capture.captured) {
        return {captured: false, summary: capture?.summary ?? 'Nothing.'};
      }

      return {
        summary: capture.summary,
        sources: (capture.sourceReferences ?? []).map(reference => ({
          id: reference.id,
          ...(reference.title === undefined ? {} : {title: reference.title}),
        })),
      };
    },
    search() {
      return {items: foreignRows(scenario.searchItems ?? [])};
    },
    shutdown() {},
  };
}

function foreignRows(
  items: readonly {
    readonly id: string;
    readonly text: string;
    readonly confidence?: number;
    readonly sourceReferences: readonly {
      readonly id: string;
      readonly title?: string;
    }[];
  }[],
) {
  return items.map(item => ({
    id: item.id,
    text: item.text,
    ...(item.confidence === undefined ? {} : {confidence: item.confidence}),
    sources: item.sourceReferences.map(reference => ({
      id: reference.id,
      ...(reference.title === undefined ? {} : {title: reference.title}),
    })),
  }));
}

function compatFactoryInput(modulePath: string): RuntimePluginFactoryInput {
  return {
    pluginId: hermesCompatPluginId,
    manifest: createHermesCompatPluginManifest(),
    storeRoot: '.project02/character-data/mira',
    characterId: 'mira',
    resolvedConfig: hermesCompatResolvedConfig(modulePath),
    redactedConfig: {},
  };
}

function hermesCompatResolvedConfig(
  modulePath: string,
): ResolvedPluginRuntimeConfig {
  return Object.freeze({
    modulePath: Object.freeze({
      name: 'modulePath',
      secret: false,
      source: 'config' as const,
      resolved: true,
      value: modulePath,
    }),
  });
}

function compatContext() {
  return createRuntimePluginContext({
    ...testIdentity(),
    sessionId: 'session-hermes-compat',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: testCharacterProfile,
  });
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_hermes_compat',
    traceId: 'trace_hermes_compat',
    createdAt: '2026-08-10T00:00:00.000Z',
  });
}
