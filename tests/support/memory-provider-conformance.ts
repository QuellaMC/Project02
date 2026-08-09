import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from './character-fixtures.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import type {RuntimePlugin} from '../../src/plugins/api/index.ts';
import type {
  MemoryAddResult,
  MemoryCaptureResult,
  MemoryRecallItem,
} from '../../src/plugins/builtin/memory-provider/index.ts';

export type MemoryProviderConformanceCapability =
  'recall' | 'captureTurn' | 'search' | 'add' | 'endSession' | 'close';

export type MemoryProviderConformanceLifecycleProbe = {
  readonly endedSessions: string[];
  closeCalls: number;
};

/**
 * Seeds the adapter's fake backing store; the suite only asserts
 * host-observable behavior, so how an adapter honors the seed (in-memory
 * map, fake transport, wrapped foreign module) is its own business.
 */
export type MemoryProviderConformanceScenario = {
  readonly recallItems?: readonly MemoryRecallItem[];
  readonly searchItems?: readonly MemoryRecallItem[];
  readonly addResult?: MemoryAddResult;
  readonly captureResult?: MemoryCaptureResult;
  readonly lifecycleProbe?: MemoryProviderConformanceLifecycleProbe;
};

export type MemoryProviderConformanceAdapter = {
  readonly name: string;
  readonly pluginId: string;
  /** Tool namespace the adapter uses; defaults to the plugin id. */
  readonly toolNamespace?: string;
  readonly capabilities: ReadonlySet<MemoryProviderConformanceCapability>;
  /**
   * Seam-guarantee cases (source-less filtering, degraded capture,
   * reference synthesis, no-results references) need seeds a real backend
   * adapter can never produce — its references derive from backend rows.
   * Only the reference adapter proves them; translation cases run for all.
   */
  readonly provesSeamGuarantees?: boolean;
  createPlugin(
    scenario: MemoryProviderConformanceScenario,
  ): RuntimePlugin | Promise<RuntimePlugin>;
};

export function runMemoryProviderConformanceSuite(
  adapter: MemoryProviderConformanceAdapter,
): void {
  const has = (capability: MemoryProviderConformanceCapability) =>
    adapter.capabilities.has(capability);
  const seam = adapter.provesSeamGuarantees === true;
  const namespace = adapter.toolNamespace ?? adapter.pluginId;
  const searchToolName = `${namespace}.search`;
  const addToolName = `${namespace}.add`;

  describe(`memory provider conformance: ${adapter.name}`, () => {
    it('declares exactly the capability-matched plugin surface', async () => {
      const plugin = await adapter.createPlugin({});
      const declared = plugin.manifest.declaredPlugins;
      const toolCapable = has('search') || has('add');

      expect(plugin.manifest.id).toBe(adapter.pluginId);
      expect(plugin.manifest.kind).toBe('memory_provider');
      expect(declared.includes('before_role_model_call')).toBe(has('recall'));
      expect(declared.includes('after_turn_committed')).toBe(
        has('captureTurn'),
      );
      expect(declared.includes('tool_provider')).toBe(toolCapable);
      expect(declared.includes('handle_tool_call')).toBe(toolCapable);
      expect(declared.includes('on_session_end')).toBe(has('endSession'));
      expect(declared.includes('on_shutdown')).toBe(has('close'));
      expect(plugin.providedTools.map(tool => tool.name)).toEqual([
        ...(has('search') ? [searchToolName] : []),
        ...(has('add') ? [addToolName] : []),
      ]);
      // Providers own their storage behind the provider interface, so they
      // never touch the host file stores.
      expect(plugin.manifest.requestedAccess.file_store).toBeUndefined();
      expect(
        plugin.manifest.requestedAccess.character_file_store,
      ).toBeUndefined();
    });

    if (has('recall')) {
      it('provides bounded, source-backed recall context items', async () => {
        const host = await conformanceHost(adapter, {
          recallItems: [
            {
              id: 'remembered-fact',
              text: 'A'.repeat(700),
              sourceReferences: [
                {kind: 'memory', id: 'memory-1', title: 'Memory row'},
              ],
              confidence: 0.8,
            },
          ],
        });
        const result = await host.beforeRoleModelCall(conformanceContext());

        expect(result.status).toBe('completed');
        if (result.status !== 'completed') {
          return;
        }

        expect(result.contextItems[0]).toMatchObject({
          pluginId: adapter.pluginId,
          kind: 'memory',
          sourceReferences: [{kind: 'memory', id: 'memory-1'}],
          confidence: 0.8,
        });
        expect(result.contextItems[0]?.text.length).toBeLessThanOrEqual(600);
        expect(result.evidence).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            evidenceKind: 'before_role_model_call',
            status: 'accepted',
          }),
        );
      });

      it('normalizes provider recall IDs into stable context item ids', async () => {
        const host = await conformanceHost(adapter, {
          recallItems: [
            {
              id: '123',
              text: 'Numeric provider row ID should still become context.',
              sourceReferences: [
                {kind: 'memory', id: '123', title: 'Provider memory row'},
              ],
            },
          ],
        });
        const result = await host.beforeRoleModelCall(conformanceContext());

        expect(result.status).toBe('completed');
        if (result.status !== 'completed') {
          return;
        }

        expect(result.contextItems[0]).toMatchObject({
          id: 'memory.123',
          sourceReferences: [
            {kind: 'memory', id: '123', title: 'Provider memory row'},
          ],
        });
        expect(result.evidence).not.toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            status: 'degraded',
          }),
        );
      });

      it.runIf(seam)(
        'omits source-less recall items without rejecting valid rows',
        async () => {
          const host = await conformanceHost(adapter, {
            recallItems: [
              {
                id: 'source-less',
                text: 'This unauditable item should be omitted.',
                sourceReferences: [],
              },
              {
                id: 'source-backed',
                text: 'This auditable item should remain.',
                sourceReferences: [{kind: 'memory', id: 'source-backed'}],
              },
            ],
          });
          const result = await host.beforeRoleModelCall(conformanceContext());

          expect(result.status).toBe('completed');
          if (result.status !== 'completed') {
            return;
          }

          expect(result.contextItems.map(item => item.id)).toEqual([
            'memory.source-backed',
          ]);
          expect(result.evidence).toContainEqual(
            expect.objectContaining({
              pluginId: adapter.pluginId,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Provided 1 memory item(s).',
            }),
          );
        },
      );
    }

    if (has('captureTurn')) {
      it.runIf(seam)(
        'degrades source-less capture evidence with the current-turn reference',
        async () => {
          const host = await conformanceHost(adapter, {
            captureResult: {captured: true, summary: 'Captured.'},
          });
          const result = await host.afterTurnCommitted(
            conformanceAfterTurnContext(),
          );

          expect(result.status).toBe('completed');
          expect(result.evidence).toContainEqual(
            expect.objectContaining({
              pluginId: adapter.pluginId,
              evidenceKind: 'after_turn_committed',
              status: 'degraded',
              summary: 'Captured. Missing provider source references.',
              sourceReferences: [
                {
                  kind: 'conversation',
                  id: 'evt_memory',
                  title: 'Current conversation turn',
                },
              ],
            }),
          );
        },
      );

      it('preserves provider capture source references as accepted evidence', async () => {
        const host = await conformanceHost(adapter, {
          captureResult: {
            captured: true,
            summary: 'Captured from provider row.',
            sourceReferences: [
              {
                kind: 'memory',
                id: 'memory-capture-1',
                title: 'Captured memory row',
              },
            ],
          },
        });
        const result = await host.afterTurnCommitted(
          conformanceAfterTurnContext(),
        );

        expect(result.evidence).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            evidenceKind: 'after_turn_committed',
            status: 'accepted',
            sourceReferences: expect.arrayContaining([
              expect.objectContaining({kind: 'memory', id: 'memory-capture-1'}),
            ]),
          }),
        );
      });
    }

    if (has('endSession') && has('close')) {
      it('ends the provider session and shuts down exactly once', async () => {
        const lifecycleProbe: MemoryProviderConformanceLifecycleProbe = {
          endedSessions: [],
          closeCalls: 0,
        };
        const host = await conformanceHost(adapter, {lifecycleProbe});
        const sessionEnd = await host.onSessionEnd(conformanceContext());
        const shutdown = await host.shutdown(conformanceContext());
        const repeatedShutdown = await host.shutdown(conformanceContext());

        expect(lifecycleProbe.endedSessions).toEqual(['session-memory']);
        expect(lifecycleProbe.closeCalls).toBe(1);
        expect(sessionEnd).toMatchObject({
          status: 'completed',
          evidence: [
            {
              pluginId: adapter.pluginId,
              evidenceKind: 'session_end',
              status: 'accepted',
            },
          ],
        });
        expect(shutdown).toMatchObject({
          status: 'completed',
          evidence: [
            {
              pluginId: adapter.pluginId,
              evidenceKind: 'shutdown',
              status: 'accepted',
            },
          ],
        });
        expect(repeatedShutdown).toBe(shutdown);
      });
    }

    if (has('search')) {
      it('returns source-backed search results through the tool surface', async () => {
        const host = await conformanceHost(adapter, {
          searchItems: [
            {
              id: 'result',
              text: 'Prior session detail.',
              sourceReferences: [{kind: 'memory', id: 'result-1'}],
            },
          ],
        });
        const search = await host.handleToolCall(
          conformanceToolCall(adapter, searchToolName, {query: 'prior'}),
          conformanceContext(),
        );

        expect(search.status).toBe('accepted');
        if (search.status !== 'accepted') {
          return;
        }

        expect(search.output).toMatchObject({items: [{id: 'result'}]});
        expect(search.evidence[0]).toMatchObject({
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          sourceReferences: [{kind: 'memory', id: 'result-1'}],
        });
      });

      it.runIf(seam)(
        'accepts no-hit search results with a runtime no-results reference',
        async () => {
          const host = await conformanceHost(adapter, {searchItems: []});
          const search = await host.handleToolCall(
            conformanceToolCall(adapter, searchToolName, {
              query: 'missing memory',
            }),
            conformanceContext(),
          );

          expect(search.status).toBe('accepted');
          if (search.status !== 'accepted') {
            return;
          }

          expect(search.output).toEqual({items: []});
          expect(search.evidence[0]).toMatchObject({
            evidenceKind: 'tool_invocation',
            status: 'accepted',
            sourceReferences: [
              {
                kind: 'runtime',
                id: `evt_memory:${searchToolName}.no_results`,
              },
            ],
          });
        },
      );

      it.runIf(seam)(
        'omits source-less search items before accepting the result',
        async () => {
          const host = await conformanceHost(adapter, {
            searchItems: [
              {
                id: 'source-less',
                text: 'This item lacks evidence.',
                sourceReferences: [],
              },
            ],
          });
          const search = await host.handleToolCall(
            conformanceToolCall(adapter, searchToolName, {
              query: 'source-less memory',
            }),
            conformanceContext(),
          );

          expect(search.status).toBe('accepted');
          if (search.status !== 'accepted') {
            return;
          }

          expect(search.output).toEqual({items: []});
          expect(search.evidence[0]).toMatchObject({
            evidenceKind: 'tool_invocation',
            status: 'accepted',
            sourceReferences: [
              {
                kind: 'runtime',
                id: `evt_memory:${searchToolName}.no_results`,
              },
            ],
          });
        },
      );
    }

    if (has('add')) {
      it('persists an explicit memory through the add tool', async () => {
        const host = await conformanceHost(adapter, {
          addResult: {
            id: 'persisted-memory-1',
            sourceReferences: [{kind: 'memory', id: 'persisted-memory-1'}],
          },
        });
        const add = await host.handleToolCall(
          conformanceToolCall(adapter, addToolName, {
            text: 'New durable memory.',
          }),
          conformanceContext(),
        );

        expect(add.status).toBe('accepted');
        if (add.status !== 'accepted') {
          return;
        }

        expect(add.output).toMatchObject({id: 'persisted-memory-1'});
        expect(add.evidence[0]).toMatchObject({
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          sourceReferences: expect.arrayContaining([
            expect.objectContaining({kind: 'memory', id: 'persisted-memory-1'}),
          ]),
        });
      });

      it.runIf(seam)(
        'synthesizes a persisted memory reference for add results without one',
        async () => {
          const host = await conformanceHost(adapter, {
            addResult: {id: 'persisted-memory-1', sourceReferences: []},
          });
          const add = await host.handleToolCall(
            conformanceToolCall(adapter, addToolName, {
              text: 'New durable memory.',
            }),
            conformanceContext(),
          );

          expect(add.status).toBe('accepted');
          if (add.status !== 'accepted') {
            return;
          }

          expect(add.output).toEqual({
            id: 'persisted-memory-1',
            sourceReferences: [
              {
                kind: 'memory',
                id: 'persisted-memory-1',
                title: 'Persisted memory item',
              },
            ],
          });
          expect(add.evidence[0]).toMatchObject({
            evidenceKind: 'tool_invocation',
            status: 'accepted',
            sourceReferences: [
              {kind: 'conversation', id: 'evt_memory'},
              {
                kind: 'memory',
                id: 'persisted-memory-1',
                title: 'Persisted memory item',
              },
            ],
          });
        },
      );
    }
  });
}

async function conformanceHost(
  adapter: MemoryProviderConformanceAdapter,
  scenario: MemoryProviderConformanceScenario,
) {
  const plugin = await adapter.createPlugin(scenario);

  return createRuntimePluginHost({
    plugins: [plugin],
    enabledPluginIds: [plugin.manifest.id],
  });
}

function conformanceToolCall(
  adapter: MemoryProviderConformanceAdapter,
  toolName: string,
  input: Readonly<Record<string, string>>,
) {
  return {
    eventId: 'evt_memory',
    traceId: 'trace_memory',
    createdAt: '2026-06-21T00:00:00.000Z',
    pluginId: adapter.pluginId,
    toolName,
    input,
  };
}

function conformanceContext() {
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

function conformanceAfterTurnContext() {
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
