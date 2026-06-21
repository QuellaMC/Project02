import { describe, expect, it } from 'vitest';

import {
  createMemoryProviderRuntimePlugin,
  type Project02MemoryProvider
} from '../src/plugins/memory/index.ts';
import {
  createRuntimePluginContext
} from '../src/plugins/index.ts';
import {
  createRuntimePluginHost
} from '../src/plugins/host.ts';
import {
  createRuntimePluginAfterTurnCommittedContext
} from '../src/plugins/types.ts';

describe('memory provider runtime plugin helper', () => {
  it('declares only implemented provider methods', () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.recall-only',
      displayName: 'Recall Only',
      recall() {
        return Promise.resolve({ items: [] });
      }
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);

    expect(plugin.manifest.kind).toBe('memory_provider');
    expect(plugin.manifest.declaredPlugins).toEqual(
      expect.arrayContaining(['before_role_model_call'])
    );
    expect(plugin.manifest.declaredPlugins).not.toContain('handle_tool_call');
    expect(plugin.providedTools).toEqual([]);
    expect(plugin.manifest.runtimePolicy.failureBehavior).toMatchObject({
      beforeRoleModelCall: 'degrade',
      afterTurnCommitted: 'log_failure',
      health: 'degrade'
    });
  });

  it('provides bounded memory context with source references', async () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.recall',
      displayName: 'Recall Provider',
      recall() {
        return Promise.resolve({
          items: [
            {
              id: 'remembered-fact',
              text: 'A'.repeat(700),
              sourceReferences: [
                {
                  kind: 'memory',
                  id: 'memory-1',
                  title: 'Memory row'
                }
              ],
              confidence: 0.8
            }
          ]
        });
      }
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);
    const result = await plugin.lifecycleHooks.beforeRoleModelCall?.(
      testContext()
    );

    expect(result?.contextItems[0]).toMatchObject({
      pluginId: 'memory.recall',
      kind: 'memory',
      sourceReferences: [
        {
          kind: 'memory',
          id: 'memory-1'
        }
      ],
      confidence: 0.8
    });
    expect(result?.contextItems[0]?.text.length).toBeLessThanOrEqual(600);
    expect(result?.evidence[0]).toMatchObject({
      pluginId: 'memory.recall',
      evidenceKind: 'before_role_model_call',
      status: 'accepted'
    });
  });

  it('records after-turn capture evidence with the after-turn kind', async () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.capture',
      displayName: 'Capture Provider',
      captureTurn() {
        return Promise.resolve({
          captured: true,
          summary: 'Captured.'
        });
      }
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);
    const result = await plugin.lifecycleHooks.afterTurnCommitted?.(
      createRuntimePluginAfterTurnCommittedContext({
        eventId: 'evt_memory',
        traceId: 'trace_memory',
        createdAt: '2026-06-21T00:00:00.000Z',
        sessionId: 'session-memory',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'remember this',
        character: {
          id: 'mira',
          displayName: 'Mira'
        },
        committedAt: '2026-06-21T00:00:01.000Z',
        visibleMessages: [
          {
            id: 'visible-character',
            role: 'character',
            speakerId: 'mira',
            speakerName: 'Mira',
            text: 'done'
          }
        ]
      })
    );

    expect(result?.evidence[0]).toMatchObject({
      pluginId: 'memory.capture',
      evidenceKind: 'after_turn_committed',
      status: 'accepted'
    });
  });

  it('runs provider close on the session-end lifecycle', async () => {
    const closedSessions: string[] = [];
    const provider: Project02MemoryProvider = {
      id: 'memory.close',
      displayName: 'Close Provider',
      close() {
        closedSessions.push('closed');

        return Promise.resolve();
      }
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id]
    });
    const result = await host.onSessionEnd(testContext());
    const registeredPlugin = host
      .registrySnapshot()
      .plugins.find((snapshot) => snapshot.manifest.id === 'memory.close');

    expect(plugin.manifest.declaredPlugins).toContain('on_session_end');
    expect(registeredPlugin?.registeredLifecycleHooks).toContain('on_session_end');
    expect(closedSessions).toEqual(['closed']);
    expect(result).toMatchObject({
      status: 'completed',
      evidence: [
        {
          pluginId: 'memory.close',
          evidenceKind: 'session_end',
          status: 'accepted'
        }
      ]
    });
  });

  it('exposes optional search and add tools when methods exist', async () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.tools',
      displayName: 'Tool Provider',
      search() {
        return Promise.resolve({
          items: [
            {
              id: 'result',
              text: 'Prior session detail.',
              sourceReferences: [{ kind: 'memory', id: 'result-1' }]
            }
          ]
        });
      },
      add() {
        return Promise.resolve({
          id: 'added',
          sourceReferences: [{ kind: 'memory', id: 'added' }]
        });
      }
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id]
    });

    expect(plugin.providedTools.map((tool) => tool.name)).toEqual([
      'memory.search',
      'memory.add'
    ]);
    expect(plugin.providedTools.every((tool) => tool.sourceReferencesRequired)).toBe(true);

    const search = await host.handleToolCall(
      {
        eventId: 'evt_memory',
        traceId: 'trace_memory',
        createdAt: '2026-06-21T00:00:00.000Z',
        pluginId: 'memory.tools',
        toolName: 'memory.search',
        input: { query: 'prior' }
      },
      testContext()
    );

    expect(search.status).toBe('accepted');
    if (search.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }
    expect(search).toMatchObject({
      status: 'accepted',
      output: {
        items: [
          {
            id: 'result'
          }
        ]
      }
    });
    expect(search.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      sourceReferences: [
        {
          kind: 'memory',
          id: 'result-1'
        }
      ]
    });

    const add = await host.handleToolCall(
      {
        eventId: 'evt_memory',
        traceId: 'trace_memory',
        createdAt: '2026-06-21T00:00:00.000Z',
        pluginId: 'memory.tools',
        toolName: 'memory.add',
        input: { text: 'New durable memory.' }
      },
      testContext()
    );

    expect(add.status).toBe('accepted');
    if (add.status !== 'accepted') {
      throw new Error('Expected memory.add to be accepted.');
    }
    expect(add).toMatchObject({
      status: 'accepted',
      output: {
        id: 'added',
        sourceReferences: [
          {
            kind: 'memory',
            id: 'added'
          }
        ]
      }
    });
    expect(add.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      sourceReferences: [
        {
          kind: 'conversation',
          id: 'evt_memory'
        },
        {
          kind: 'memory',
          id: 'added'
        }
      ]
    });
  });

  it('accepts no-hit memory.search results with empty items', async () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.search-empty',
      displayName: 'Empty Search Provider',
      search() {
        return Promise.resolve({
          items: []
        });
      }
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id]
    });

    const search = await host.handleToolCall(
      {
        eventId: 'evt_memory',
        traceId: 'trace_memory',
        createdAt: '2026-06-21T00:00:00.000Z',
        pluginId: 'memory.search-empty',
        toolName: 'memory.search',
        input: { query: 'missing memory' }
      },
      testContext()
    );

    expect(search.status).toBe('accepted');
    if (search.status !== 'accepted') {
      throw new Error('Expected empty memory.search to be accepted.');
    }
    expect(search.output).toEqual({
      items: []
    });
    expect(search.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      sourceReferences: [
        {
          kind: 'runtime',
          id: 'evt_memory:memory.search.no_results'
        }
      ]
    });
  });

  it('omits memory.search items without source references before accepting', async () => {
    const provider: Project02MemoryProvider = {
      id: 'memory.search-source-filter',
      displayName: 'Source Filter Search Provider',
      search() {
        return Promise.resolve({
          items: [
            {
              id: 'source-less',
              text: 'This item lacks evidence.',
              sourceReferences: []
            }
          ]
        });
      }
    };
    const plugin = createMemoryProviderRuntimePlugin(provider);
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id]
    });

    const search = await host.handleToolCall(
      {
        eventId: 'evt_memory',
        traceId: 'trace_memory',
        createdAt: '2026-06-21T00:00:00.000Z',
        pluginId: 'memory.search-source-filter',
        toolName: 'memory.search',
        input: { query: 'source-less memory' }
      },
      testContext()
    );

    expect(search.status).toBe('accepted');
    if (search.status !== 'accepted') {
      throw new Error('Expected source-filtered memory.search to be accepted.');
    }
    expect(search.output).toEqual({
      items: []
    });
    expect(search.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      sourceReferences: [
        {
          kind: 'runtime',
          id: 'evt_memory:memory.search.no_results'
        }
      ]
    });
  });
});

function testContext() {
  return createRuntimePluginContext({
    eventId: 'evt_memory',
    traceId: 'trace_memory',
    createdAt: '2026-06-21T00:00:00.000Z',
    sessionId: 'session-memory',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}
