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

  it('reports a many-row add instead of failing a completed write', async () => {
    const fetchFn: Mem0FetchFunction = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: Array.from({length: 40}, (_unused, index) => ({
              id: `stored-${String(index)}`,
            })),
          }),
      });
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
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

    // The rows are already stored; a hook that threw over its evidence
    // budget would report the write as failed.
    expect(add?.status).toBe('accepted');
  });

  it('reports a synchronous add that stored nothing instead of calling it queued', async () => {
    const fetchFn: Mem0FetchFunction = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: []}),
      });
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });

    // The server backend has no queue behind this call: a response that
    // created nothing must not read as a memory still on its way, so the
    // tool fails and the host applies the plugin's degrade policy.
    await expect(
      plugin.lifecycleHooks.handleToolCall?.(
        {
          ...testIdentity(),
          pluginId: mem0PluginId,
          toolName: 'mem0.add',
          input: {text: 'User prefers tea.'},
        },
        mem0Context(),
      ),
    ).rejects.toThrow('created no memory for it');
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
    // memory is already persisted -- including the memory id the tool
    // output would otherwise carry.
    expect(add.output).toMatchObject({
      queued: true,
      sourceReferences: [
        {
          kind: 'external_contract',
          id: 'evt-queued',
          title: 'Queued mem0 memory write',
        },
      ],
    });
    expect(JSON.stringify(add.output)).not.toContain('Persisted memory item');
    expect(add.output).not.toHaveProperty('id');
    expect(JSON.stringify(add.evidence)).toContain('Queued one memory item');
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
  // Recall and search reach the same endpoint, and the conformance run
  // drives recall first, so order names the verb behind each request.
  let searchRequests = 0;

  return (url, init) => {
    const body =
      init.body === undefined
        ? {}
        : (JSON.parse(init.body) as {
            readonly query?: string;
            readonly infer?: boolean;
            readonly messages?: readonly {readonly content?: string}[];
            readonly metadata?: unknown;
            readonly run_id?: string;
          });

    if (url.endsWith('/search')) {
      const items = scenario.recallItems ?? scenario.searchItems ?? [];

      searchRequests += 1;

      if (scenario.requestProbe !== undefined) {
        scenario.requestProbe.scopedVerbs = {
          ...scenario.requestProbe.scopedVerbs,
          [searchRequests === 1 ? 'recall' : 'search']:
            init.signal instanceof AbortSignal,
        };
      }

      if (scenario.requestProbe !== undefined && body.query !== undefined) {
        scenario.requestProbe[
          searchRequests === 1 ? 'recallQuery' : 'searchQuery'
        ] = body.query;
      }

      return jsonResponse({
        results: items.map(item => ({
          id: item.sourceReferences[0]?.id ?? item.id,
          memory: item.text,
          ...(item.confidence === undefined ? {} : {score: item.confidence}),
        })),
      });
    }

    if (url.endsWith('/memories')) {
      if (scenario.requestProbe !== undefined && body.run_id !== undefined) {
        scenario.requestProbe.sessionIds = {
          ...scenario.requestProbe.sessionIds,
          captureTurn: body.run_id,
        };
      }

      const requestedText = body.messages?.[0]?.content;

      if (scenario.requestProbe !== undefined) {
        scenario.requestProbe.scopedVerbs = {
          ...scenario.requestProbe.scopedVerbs,
          [body.infer === false ? 'add' : 'captureTurn']:
            init.signal instanceof AbortSignal,
        };
      }

      if (scenario.requestProbe !== undefined && requestedText !== undefined) {
        if (body.infer === false) {
          scenario.requestProbe.addText = requestedText;
          scenario.requestProbe.addSourceReferenceIds = sourceIdsFromMetadata(
            body.metadata,
          );
        } else {
          scenario.requestProbe.capturedUserMessage = requestedText;
        }
      }

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

    if (scenario.requestProbe !== undefined) {
      scenario.requestProbe.scopedVerbs = {
        ...scenario.requestProbe.scopedVerbs,
        health: init.signal instanceof AbortSignal,
      };
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

function sourceIdsFromMetadata(metadata: unknown): readonly string[] {
  const sources =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as {readonly project02_sources?: unknown})[
          'project02_sources'
        ]
      : undefined;

  return Array.isArray(sources)
    ? sources.filter((id): id is string => typeof id === 'string')
    : [];
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
