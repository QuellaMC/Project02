import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import type {RuntimePluginFactoryInput} from '../../src/plugins/api/factory.ts';
import {
  resolveRuntimeSectionConfigs,
  runtimeConfigVersion,
  type ResolvedRuntimeSectionConfig,
} from '../../src/runtime/config/index.ts';
import {createProject02Plugin} from '../../src/plugins/packages/mem0/index.ts';
import {
  createMem0PluginFromInput,
  createMem0PluginManifest,
  mem0OssSettingsFromInput,
  mem0PluginId,
} from '../../src/plugins/packages/mem0/plugin.ts';
import type {
  Mem0FetchFunction,
  Mem0OssEngine,
} from '../../src/plugins/packages/mem0/backend.ts';
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
    // Capture runs behind the turn, so the drain is what settles what the
    // backend was sent.
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());

    const [recall, search, capture] = requests.map(request => ({
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

  it('hands the embedded engine the same requests as the REST transports', async () => {
    const calls: {readonly verb: string; readonly payload: unknown}[] = [];
    const engine: Mem0OssEngine = {
      search(query, searchOptions) {
        calls.push({verb: 'search', payload: {query, ...searchOptions}});

        return Promise.resolve({results: []});
      },
      add(messages, addOptions) {
        calls.push({verb: 'add', payload: {messages, ...addOptions}});

        return Promise.resolve({results: [{id: 'stored-1'}]});
      },
    };
    const plugin = createMem0PluginFromInput(mem0FactoryInput('oss'), {
      ossEngineLoader: () => Promise.resolve(engine),
    });

    await plugin.lifecycleHooks.beforeRoleModelCall?.(mem0Context());
    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());

    // The engine takes the identities and the bound in its own shape, and
    // the captured turn carries the host's provenance as its metadata.
    expect(calls[0]).toMatchObject({
      verb: 'search',
      payload: {
        query: 'remember this',
        topK: 5,
        filters: {user_id: 'project02-user', agent_id: 'mira'},
      },
    });
    expect(calls[1]).toMatchObject({
      verb: 'add',
      payload: {
        userId: 'project02-user',
        agentId: 'mira',
        runId: 'session-mem0',
        infer: true,
        metadata: {project02_sources: ['evt_mem0']},
      },
    });
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

  it('resolves embedded-engine settings around one rule: the cloud default needs a key', () => {
    const inherited = mem0OssSettingsFromInput(
      mem0FactoryInput('oss', {
        ossLlmBaseUrl: 'https://gateway.example/v1',
        ossEmbedderDims: 3072,
      }),
    );
    const ownEmbedderEndpoint = mem0OssSettingsFromInput(
      mem0FactoryInput('oss', {
        ossEmbedderBaseUrl: 'http://localhost:11434/v1',
        ossEmbedderModel: 'nomic-embed-text',
      }),
    );
    const trailingSlash = mem0OssSettingsFromInput({
      ...mem0FactoryInput('oss'),
      resolvedConfig: resolvedConfig({
        backend: 'oss',
        ossLlmApiKey: 'oss-llm-key',
        ossLlmBaseUrl: 'https://gateway.example/v1',
        ossEmbedderBaseUrl: 'https://gateway.example/v1/',
      }),
    });
    const keylessLocal = mem0OssSettingsFromInput({
      ...mem0FactoryInput('oss'),
      resolvedConfig: resolvedConfig({
        backend: 'oss',
        ossLlmBaseUrl: 'http://localhost:1234/v1',
      }),
    });
    const cloudWithoutKey = mem0OssSettingsFromInput({
      ...mem0FactoryInput('oss'),
      resolvedConfig: resolvedConfig({backend: 'oss'}),
    });

    expect(inherited).toMatchObject({
      status: 'resolved',
      value: {
        embedderApiKey: 'oss-llm-key',
        embedderBaseUrl: 'https://gateway.example/v1',
        embedderDims: 3072,
        storageDir: expect.stringContaining('plugin-data/mem0/oss') as string,
      },
    });
    // Two spellings of one endpoint are one endpoint; withholding the key
    // over a trailing slash would leave the embedder unauthenticated.
    expect(trailingSlash).toMatchObject({
      status: 'resolved',
      value: {embedderApiKey: 'oss-llm-key'},
    });
    expect(ownEmbedderEndpoint).toMatchObject({
      status: 'resolved',
      value: {
        embedderBaseUrl: 'http://localhost:11434/v1',
        embedderModel: 'nomic-embed-text',
      },
    });
    expect(keylessLocal).toMatchObject({status: 'resolved'});
    if (keylessLocal.status === 'resolved') {
      expect(keylessLocal.value.llmApiKey).toBeUndefined();
      expect(keylessLocal.value.embedderBaseUrl).toBe(
        'http://localhost:1234/v1',
      );
    }
    expect(cloudWithoutKey).toMatchObject({
      status: 'rejected',
      message: expect.stringContaining('MEM0_OSS_LLM_API_KEY') as string,
    });

    // Every rule runs on the effective endpoints, so spelling out the
    // cloud default behaves exactly like leaving it unset.
    const spelledOutDefault = mem0OssSettingsFromInput(
      mem0FactoryInput('oss', {
        ossEmbedderBaseUrl: 'https://api.openai.com/v1',
      }),
    );
    const cloudEmbedderWithoutKey = mem0OssSettingsFromInput({
      ...mem0FactoryInput('oss'),
      resolvedConfig: resolvedConfig({
        backend: 'oss',
        ossLlmBaseUrl: 'http://localhost:1234/v1',
        ossEmbedderBaseUrl: 'https://api.openai.com/v1',
      }),
    });
    const schemeless = mem0OssSettingsFromInput({
      ...mem0FactoryInput('oss'),
      resolvedConfig: resolvedConfig({
        backend: 'oss',
        ossLlmApiKey: 'oss-llm-key',
        ossLlmBaseUrl: 'localhost:11434/v1',
      }),
    });

    expect(spelledOutDefault).toMatchObject({
      status: 'resolved',
      value: {embedderApiKey: 'oss-llm-key'},
    });
    expect(cloudEmbedderWithoutKey).toMatchObject({
      status: 'rejected',
      message: expect.stringContaining('MEM0_OSS_EMBEDDER_API_KEY') as string,
    });
    expect(schemeless).toMatchObject({
      status: 'rejected',
      message: expect.stringContaining('ossLlmBaseUrl') as string,
    });
  });

  it('captures turns with speaker names instead of role labels', async () => {
    const added: unknown[] = [];
    const plugin = createMem0PluginFromInput(
      {...mem0FactoryInput('oss'), userDisplayName: 'Mike'},
      {
        ossEngineLoader: () =>
          Promise.resolve({
            add(messages) {
              added.push(messages);

              return Promise.resolve({results: []});
            },
            search() {
              return Promise.resolve({results: []});
            },
          }),
      },
    );

    await plugin.lifecycleHooks.afterTurnCommitted?.(
      mem0AfterTurnContext('Mike'),
    );
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());

    expect(added[0]).toEqual([
      {role: 'user', content: 'Mike: remember this'},
      {role: 'assistant', content: 'Mira: noted'},
    ]);
  });

  it('queues capture behind the turn and drains it on shutdown', async () => {
    let resolveAdd: (value: {results: {id: string}[]}) => void = () => {};
    let addCalls = 0;
    const plugin = createMem0PluginFromInput(mem0FactoryInput('oss'), {
      ossEngineLoader: () =>
        Promise.resolve({
          add() {
            addCalls += 1;

            return new Promise(resolve => {
              resolveAdd = resolve;
            });
          },
          search() {
            return Promise.resolve({results: []});
          },
        }),
    });

    const capture = await plugin.lifecycleHooks.afterTurnCommitted?.(
      mem0AfterTurnContext(),
    );

    // The hook returned while the backend add had not even started.
    expect(capture?.status).toBe('completed');
    expect(capture?.evidence[0]).toMatchObject({
      status: 'accepted',
      summary: expect.stringContaining('Queued') as string,
      sourceReferences: [expect.objectContaining({kind: 'external_contract'})],
    });
    expect(addCalls).toBe(0);

    // One macrotask flush lets the queued work reach the backend.
    await new Promise(resolve => setImmediate(resolve));
    expect(addCalls).toBe(1);

    resolveAdd({results: [{id: 'stored-late'}]});
    const shutdown = await plugin.lifecycleHooks.onShutdown?.(mem0Context());
    const health = await plugin.lifecycleHooks.health?.(mem0Context());

    expect(shutdown?.status).toBe('completed');
    expect(health).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('Stored 1 memory item(s)') as string,
    });
  });

  it('degrades health while a background capture has failed', async () => {
    let addCalls = 0;
    const fetchFn: Mem0FetchFunction = url => {
      if (url.endsWith('/memories')) {
        addCalls += 1;

        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: []}),
      });
    };
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });

    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    // Draining the queue is what makes the background outcome observable.
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());
    const health = await plugin.lifecycleHooks.health?.(mem0Context());

    expect(addCalls).toBe(1);
    // A capture that did not complete must not read as healthy.
    expect(health).toMatchObject({
      status: 'degraded',
      summary: expect.stringContaining('did not complete') as string,
    });
  });

  it('refuses a turn once the extraction backlog is full', async () => {
    let releaseAdds: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      releaseAdds = resolve;
    });
    const fetchFn: Mem0FetchFunction = async url => {
      if (url.endsWith('/memories')) {
        await held;
      }

      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: [{id: 'stored-1'}]}),
      };
    };
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });
    const captures = [];

    for (let index = 0; index < 10; index += 1) {
      captures.push(
        await plugin.lifecycleHooks.afterTurnCommitted?.(
          mem0AfterTurnContext(),
        ),
      );
    }

    releaseAdds?.();
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());
    const health = await plugin.lifecycleHooks.health?.(mem0Context());

    // Extraction slower than the user types must not grow a queue for the
    // whole session; the refused turns say so where a turn is recorded.
    const refused = captures.filter(result =>
      JSON.stringify(result?.evidence ?? []).includes('not queued for capture'),
    );

    expect(refused.length).toBeGreaterThan(0);
    expect(health).toMatchObject({
      status: 'degraded',
      summary: expect.stringContaining('backlog is full') as string,
    });
  });

  it('keeps a lost capture visible after a later one succeeds', async () => {
    let addCalls = 0;
    const fetchFn: Mem0FetchFunction = url => {
      if (url.endsWith('/memories')) {
        addCalls += 1;

        return addCalls === 1
          ? Promise.resolve({
              ok: false,
              status: 500,
              json: () => Promise.resolve({}),
            })
          : Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({results: [{id: 'stored-1'}]}),
            });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: []}),
      });
    };
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });

    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());
    const health = await plugin.lifecycleHooks.health?.(mem0Context());

    // A queued capture has no retry, so the turn it lost stays lost; a
    // later success is not evidence that memory is whole.
    expect(addCalls).toBe(2);
    expect(health).toMatchObject({
      status: 'degraded',
      summary: expect.stringContaining('did not complete') as string,
    });

    // A reload builds a fresh provider whose count starts over, so the
    // loss also rides into the next turn's durable evidence.
    const later = await plugin.lifecycleHooks.afterTurnCommitted?.(
      mem0AfterTurnContext(),
    );

    expect(JSON.stringify(later?.evidence ?? [])).toContain(
      'earlier capture(s) did not complete',
    );
  });

  it('warns that an abandoned write may have landed', async () => {
    const controller = new AbortController();
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn: () => {
        controller.abort();

        return Promise.reject(new Error('aborted'));
      },
    });

    // The model reads this and may retry: a write the backend might
    // already hold must not read as one that simply failed, or the
    // retry stores the memory twice.
    await expect(
      plugin.lifecycleHooks.handleToolCall?.(
        {
          ...testIdentity(),
          pluginId: mem0PluginId,
          toolName: 'mem0.add',
          input: {text: 'User prefers tea.'},
        },
        {...mem0Context(), signal: controller.signal},
      ),
    ).rejects.toThrow('whether it completed is unknown');
  });

  it('reports a capture the shutdown drain could not finish', async () => {
    const fetchFn: Mem0FetchFunction = () =>
      Promise.reject(new Error('socket closed'));
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });

    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    const shutdown = await plugin.lifecycleHooks.onShutdown?.(mem0Context());

    // Nothing observes this provider again: no later turn, no health
    // call, and the next launch counts from zero. An accepted "closed"
    // record would be the last word on a turn memory never took.
    expect(shutdown?.evidence[0]).toMatchObject({
      evidenceKind: 'shutdown',
      status: 'degraded',
    });
    expect(shutdown?.evidence[0]?.summary).toContain('did not complete');
  });

  it('keeps capture losses in health while the outage itself persists', async () => {
    const controller = new AbortController();
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      // Every request fails: the capture that was lost and the ping that
      // would report it are down for the same reason.
      fetchFn: () => Promise.reject(new Error('socket closed')),
    });

    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());
    const health = await plugin.lifecycleHooks.health?.({
      ...mem0Context(),
      signal: controller.signal,
    });

    // The ping failing is exactly when the loss matters most; the
    // unreachable message must not displace it.
    expect(health).toMatchObject({
      status: 'unavailable',
      summary: expect.stringContaining('did not complete') as string,
    });
    expect(health?.summary).toContain('unreachable');
  });

  it('keeps the unknown-outcome warning inside the bounded health summary', async () => {
    const fetchFn: Mem0FetchFunction = (url, init) => {
      // The capture write hangs until abandoned; everything else -- the
      // ping health leads with -- answers normally.
      if (url.endsWith('/memories')) {
        return new Promise((_resolve, reject) => {
          const abandon = () => {
            reject(new Error('aborted'));
          };

          // `fetch` rejects a request whose signal is already aborted; the
          // shutdown can abort before the queued capture reaches the wire,
          // and waiting for an event that has already fired hangs forever.
          if (init.signal.aborted) {
            abandon();
            return;
          }

          init.signal.addEventListener('abort', abandon, {once: true});
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: []}),
      });
    };
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });

    await plugin.lifecycleHooks.afterTurnCommitted?.(mem0AfterTurnContext());
    // A shutdown whose deadline already passed abandons the capture
    // mid-flight, which is what records the unknown-outcome loss.
    await plugin.lifecycleHooks.onShutdown?.({
      ...mem0Context(),
      deadlineAt: Date.now() - 1,
    });

    // The host caps health summaries at 160 characters; leading with the
    // loss keeps the warning whole where trailing it cut it to "whe...",
    // and a truncated warning invites the retry that stores a duplicate.
    const health = await plugin.lifecycleHooks.health?.(mem0Context());
    const bounded = health?.summary.slice(0, 160) ?? '';

    expect(bounded).toContain('whether it completed is unknown');
  });

  it('captures under the name the session was recorded with', async () => {
    const bodies: unknown[] = [];
    const fetchFn: Mem0FetchFunction = (_url, init) => {
      bodies.push(init.body === undefined ? undefined : JSON.parse(init.body));

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({results: [{id: 'stored-1'}]}),
      });
    };
    const plugin = createMem0PluginFromInput(mem0FactoryInput('server'), {
      fetchFn,
    });

    await plugin.lifecycleHooks.afterTurnCommitted?.(
      mem0AfterTurnContext('Recorded Name'),
    );
    await plugin.lifecycleHooks.onShutdown?.(mem0Context());

    // The transcript's speaker wins over whatever the config now says, so
    // extraction attributes memories to one identity.
    expect(JSON.stringify(bodies[0])).toContain('Recorded Name:');
  });

  it('reports embedded-engine misconfiguration through health', async () => {
    const plugin = createMem0PluginFromInput({
      ...mem0FactoryInput('oss'),
      resolvedConfig: resolvedConfig({backend: 'oss'}),
    });

    const health = await plugin.lifecycleHooks.health?.(mem0Context());

    expect(health).toMatchObject({
      status: 'unavailable',
      summary: expect.stringContaining('MEM0_OSS_LLM_API_KEY') as string,
    });
  });
});

function mem0FactoryInput(
  backend: 'platform' | 'server' | 'oss',
  extraConfig: Readonly<Record<string, string | number>> = {},
): RuntimePluginFactoryInput {
  return {
    pluginId: mem0PluginId,
    manifest: createMem0PluginManifest(),
    storeRoot: '.project02/character-data/mira',
    characterId: 'mira',
    resolvedConfig: resolvedConfig({
      backend,
      ...(backend === 'server' ? {baseUrl: 'http://127.0.0.1:8765'} : {}),
      ...(backend === 'platform' ? {apiKey: 'platform-key'} : {}),
      ...(backend === 'oss' ? {ossLlmApiKey: 'oss-llm-key'} : {}),
      ...extraConfig,
    }),
    redactedConfig: {},
  };
}

/** What the resolver hands the plugin for these settings, declared defaults applied. */
function resolvedConfig(
  values: Readonly<Record<string, string | number>>,
): ResolvedRuntimeSectionConfig {
  const resolved = resolveRuntimeSectionConfigs({
    config: {
      version: runtimeConfigVersion,
      plugins: {[mem0PluginId]: {config: values}},
    },
    target: 'character',
    sections: {plugins: [createMem0PluginManifest()]},
  }).sectionConfigs.plugins[mem0PluginId];

  if (resolved === undefined) {
    throw new Error('Expected the mem0 section to resolve.');
  }

  return resolved;
}

function mem0AfterTurnContext(userSpeakerName = 'Configured Name') {
  return createRuntimePluginAfterTurnCommittedContext({
    ...testIdentity(),
    sessionId: 'session-mem0',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: testCharacterProfile,
    committedAt: '2026-08-10T00:00:01.000Z',
    visibleMessages: [
      {
        id: 'visible-user',
        role: 'user',
        speakerId: 'user',
        speakerName: userSpeakerName,
        text: 'remember this',
      },
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
