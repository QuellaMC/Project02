import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {createRuntimePluginContext} from '../../src/plugins/api/index.ts';
import type {RuntimePluginFactoryInput} from '../../src/plugins/api/factory.ts';
import type {ResolvedPluginRuntimeConfig} from '../../src/runtime/config/index.ts';
import {createProject02Plugin} from '../../src/plugins/packages/mem0/index.ts';
import {
  createMem0PluginFromInput,
  createMem0PluginManifest,
  mem0PluginId,
} from '../../src/plugins/packages/mem0/plugin.ts';
import type {Mem0FetchFunction} from '../../src/plugins/packages/mem0/backend.ts';
import {
  runMemoryProviderConformanceSuite,
  type MemoryProviderConformanceScenario,
} from '../support/memory-provider-conformance.ts';

runMemoryProviderConformanceSuite({
  name: 'mem0 adapter over a fake self-hosted server',
  pluginId: mem0PluginId,
  capabilities: new Set(['recall', 'captureTurn', 'search', 'add', 'health']),
  createPlugin(scenario) {
    return createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn: conformanceServerFetch(scenario),
    });
  },
});

describe('mem0 plugin package', () => {
  it('exposes the descriptor-backed package factory with mem0-namespaced tools', () => {
    const manifest = createMem0PluginManifest();
    const plugin = createProject02Plugin({
      ...mem0FactoryInput('server'),
      manifest,
    });

    expect(plugin.manifest).toEqual(manifest);
    expect(plugin.manifest.activation.defaultEnabled).toBe(false);
    expect(plugin.providedTools.map(tool => tool.name)).toEqual([
      'mem0.search',
      'mem0.add',
    ]);
  });

  it('stores memories under the resolved character identity', async () => {
    const bodies: unknown[] = [];
    const fetchFn: Mem0FetchFunction = (_url, init) => {
      bodies.push(init.body === undefined ? undefined : JSON.parse(init.body));

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: [{id: 'stored-1'}]}),
      });
    };
    const plugin = createMem0PluginFromInput(
      {...mem0FactoryInput('server'), characterId: 'mira'},
      {fetchFn},
    );

    await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: mem0PluginId,
        toolName: 'mem0.add',
        input: {text: 'User prefers tea.'},
      },
      mem0Context(),
    );

    expect(bodies[0]).toMatchObject({
      user_id: 'project02-user',
      agent_id: 'mira',
      infer: false,
    });
  });

  it('keeps a queued platform write out of the persisted-memory claim', async () => {
    const fetchFn: Mem0FetchFunction = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({event_id: 'evt-queued', status: 'PENDING'}),
      });
    const plugin = createMem0PluginFromInput(mem0FactoryInput('platform'), {
      fetchFn,
    });

    const add = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: mem0PluginId,
        toolName: 'mem0.add',
        input: {text: 'User prefers tea.'},
      },
      mem0Context(),
    );

    expect(add).toMatchObject({status: 'accepted'});
    if (add?.status !== 'accepted') {
      return;
    }

    // The platform acknowledges asynchronously, so nothing may claim the
    // memory is already persisted.
    expect(add.output).toMatchObject({
      sourceReferences: [
        {
          kind: 'external_contract',
          id: 'evt-queued',
          title: 'Queued mem0 memory write',
        },
      ],
    });
    expect(JSON.stringify(add.output)).not.toContain('Persisted memory item');
  });

  it('keeps credential-bearing endpoint fields out of character overlays', () => {
    const manifest = createMem0PluginManifest();
    const endpointFields = manifest.config.fields.filter(field =>
      ['backend', 'baseUrl'].includes(field.name),
    );

    // A downloaded character must not be able to point authenticated
    // traffic at an origin of its choosing.
    expect(endpointFields).toHaveLength(2);
    for (const field of endpointFields) {
      expect(field.globalOnly).toBe(true);
    }
  });

  it('reports missing configuration through health instead of pretending memory works', async () => {
    const plugin = createMem0PluginFromInput({
      ...mem0FactoryInput('server'),
      resolvedConfig: resolvedConfig({backend: 'server'}),
    });
    const platformPlugin = createMem0PluginFromInput({
      ...mem0FactoryInput('server'),
      resolvedConfig: resolvedConfig({}),
    });

    const serverHealth = await plugin.lifecycleHooks.health?.(mem0Context());
    const platformHealth =
      await platformPlugin.lifecycleHooks.health?.(mem0Context());

    expect(serverHealth).toMatchObject({
      status: 'unavailable',
      summary: expect.stringContaining('baseUrl') as string,
    });
    expect(platformHealth).toMatchObject({
      status: 'unavailable',
      summary: expect.stringContaining('MEM0_API_KEY') as string,
    });
  });
});

function conformanceServerFetch(
  scenario: MemoryProviderConformanceScenario,
): Mem0FetchFunction {
  return (url, init) => {
    if (url.endsWith('/search')) {
      const items = scenario.recallItems ?? scenario.searchItems ?? [];

      return jsonResponse({
        results: items.map(item => ({
          id: item.sourceReferences[0]?.id ?? item.id,
          memory: item.text,
          ...(item.confidence === undefined ? {} : {score: item.confidence}),
        })),
      });
    }

    if (url.endsWith('/memories')) {
      const body =
        init.body === undefined
          ? {}
          : (JSON.parse(init.body) as {readonly infer?: boolean});
      const references =
        body.infer === false
          ? (scenario.addResult?.sourceReferences ?? [])
          : scenario.captureResult?.captured === true
            ? (scenario.captureResult.sourceReferences ?? [])
            : [];

      return jsonResponse({
        results: references.map(reference => ({id: reference.id})),
      });
    }

    // The server backend pings its root; a seeded non-ok health surfaces
    // as an HTTP failure the provider maps to degraded.
    if (
      scenario.healthResult !== undefined &&
      scenario.healthResult.status !== 'ok'
    ) {
      return Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      });
    }

    return jsonResponse({});
  };
}

function jsonResponse(value: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(value),
  });
}

function mem0FactoryInput(
  backend: 'platform' | 'server',
): RuntimePluginFactoryInput {
  return {
    pluginId: mem0PluginId,
    manifest: createMem0PluginManifest(),
    storeRoot: '.project02/character-data/mira',
    characterId: 'mira',
    resolvedConfig: resolvedConfig({
      backend,
      ...(backend === 'server'
        ? {baseUrl: 'http://127.0.0.1:8765'}
        : {apiKey: 'platform-key'}),
    }),
    redactedConfig: {},
  };
}

function resolvedConfig(
  values: Readonly<Record<string, string>>,
): ResolvedPluginRuntimeConfig {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        Object.freeze({
          name,
          secret: name === 'apiKey',
          source: 'config' as const,
          resolved: true,
          value,
        }),
      ]),
    ),
  );
}

function mem0Context() {
  return createRuntimePluginContext({
    ...testIdentity(),
    sessionId: 'session-mem0',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: testCharacterProfile,
  });
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_mem0',
    traceId: 'trace_mem0',
    createdAt: '2026-08-10T00:00:00.000Z',
  });
}
