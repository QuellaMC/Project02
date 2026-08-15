import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import type {RuntimePluginFactoryInput} from '../../src/plugins/api/factory.ts';
import type {ResolvedPluginRuntimeConfig} from '../../src/runtime/config/index.ts';
import {createProject02Plugin} from '../../src/plugins/packages/mem0/index.ts';
import {
  createMem0PluginFromInput,
  createMem0PluginManifest,
  mem0PluginId,
} from '../../src/plugins/packages/mem0/plugin.ts';
import type {Mem0FetchFunction} from '../../src/plugins/packages/mem0/backend.ts';

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

    // The rows are already stored; a hook that threw over its evidence or
    // output budget would report the completed write as failed.
    expect(add?.status).toBe('accepted');
    if (add?.status !== 'accepted') {
      return;
    }

    // The stored row leads the bounded list, so what the write created
    // survives the trim.
    const outputReferences = JSON.stringify(add.output);

    expect(outputReferences.match(/"kind":"memory"/gu)).toHaveLength(32);
    expect(outputReferences).toContain(
      '"sourceReferences":[{"kind":"memory","id":"stored-0"',
    );
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

  it('sends each verb as the wire contract its backend expects', async () => {
    const requests: {
      readonly url: string;
      readonly body: string | undefined;
      readonly scoped: boolean;
    }[] = [];
    const fetchFn: Mem0FetchFunction = (url, init) => {
      requests.push({
        url,
        body: init.body,
        scoped: init.signal instanceof AbortSignal,
      });

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: [{id: 'row-1', memory: 'ok'}]}),
      });
    };
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });

    await plugin.lifecycleHooks.beforeRoleModelCall?.(mem0Context());
    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: mem0PluginId,
        toolName: 'mem0.search',
        input: {query: 'prior sessions'},
      },
      mem0Context(),
    );

    const [recall, capture, search] = requests.map(request => ({
      url: request.url,
      scoped: request.scoped,
      body: JSON.parse(request.body ?? '{}') as Record<string, unknown>,
    }));

    // What this adapter translates the seam's requests into: the query and
    // the bound it was given, the whole turn under its session, and the
    // provenance the host supplied -- each cancellable by the caller.
    expect(recall).toMatchObject({
      url: 'http://127.0.0.1:8765/search',
      scoped: true,
      body: {query: 'remember this', limit: 5, user_id: 'project02-user'},
    });
    expect(capture).toMatchObject({
      url: 'http://127.0.0.1:8765/memories',
      scoped: true,
      body: {
        run_id: 'session-mem0',
        infer: true,
        metadata: {project02_sources: ['evt_mem0']},
      },
    });
    expect(capture?.body['messages']).toMatchObject([
      {role: 'user'},
      {role: 'assistant'},
    ]);
    expect(search).toMatchObject({
      url: 'http://127.0.0.1:8765/search',
      scoped: true,
      body: {query: 'prior sessions', limit: 5},
    });
  });

  it('keeps every credential-routing field out of the model\u2019s reach', () => {
    const manifest = createMem0PluginManifest();

    // agentMutable is what lets the model propose a value, so a field that
    // decides where a credential or the conversation goes -- an endpoint, a
    // backend selector, a billed model -- must not be one.
    for (const field of manifest.config.fields) {
      expect(field.agentMutable ?? false).toBe(false);
    }
  });

  it('names a malformed base URL instead of reporting the backend unreachable', async () => {
    const plugin = createMem0PluginFromInput({
      ...mem0FactoryInput('server'),
      resolvedConfig: resolvedConfig({
        backend: 'server',
        baseUrl: 'localhost:8765',
      }),
    });

    const health = await plugin.lifecycleHooks.health?.(mem0Context());

    // An origin without a scheme fails inside fetch, where every verb
    // would blame the network for a field the operator can fix.
    expect(health).toMatchObject({
      status: 'unavailable',
      summary: expect.stringContaining(
        'absolute http:// or https:// origin',
      ) as string,
    });

    // Endpoint paths are appended as text, so a query or fragment moves
    // where every request lands.
    const withFragment = createMem0PluginFromInput({
      ...mem0FactoryInput('server'),
      resolvedConfig: resolvedConfig({
        backend: 'server',
        baseUrl: 'https://mem0.example/#/admin',
      }),
    });

    expect(
      await withFragment.lifecycleHooks.health?.(mem0Context()),
    ).toMatchObject({status: 'unavailable'});

    // The rejected value itself never travels: health reaches logs and
    // durable evidence, and a mistyped URL can carry the credential.
    const withUserinfo = createMem0PluginFromInput({
      ...mem0FactoryInput('server'),
      resolvedConfig: resolvedConfig({
        backend: 'server',
        baseUrl: 'https://operator:hunter2@mem0.example',
      }),
    });
    const leaked = await withUserinfo.lifecycleHooks.health?.(mem0Context());

    expect(leaked).toMatchObject({status: 'unavailable'});
    expect(JSON.stringify(leaked)).not.toContain('hunter2');
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

function mem0AfterTurnContext() {
  return createRuntimePluginAfterTurnCommittedContext({
    ...testIdentity(),
    sessionId: 'session-mem0',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: testCharacterProfile,
    committedAt: '2026-08-10T00:00:01.000Z',
    visibleMessages: [
      {
        id: 'visible-character',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'noted',
      },
    ],
  });
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
