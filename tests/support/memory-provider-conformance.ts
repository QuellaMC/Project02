import {
  boundedMemoryToolName,
  memoryProviderMaxItems,
} from '../../src/plugins/builtin/memory-provider/index.ts';
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
  MemoryHealthResult,
  MemoryRecallItem,
} from '../../src/plugins/builtin/memory-provider/index.ts';

export type MemoryProviderConformanceCapability =
  | 'recall'
  | 'captureTurn'
  | 'search'
  | 'add'
  | 'health'
  | 'endSession'
  | 'close';

export type MemoryProviderConformanceLifecycleProbe = {
  readonly endedSessions: string[];
  closeCalls: number;
};

/**
 * Seeds the adapter's fake backing store; the suite only asserts
 * host-observable behavior, so how an adapter honors the seed (in-memory
 * map, fake transport, wrapped foreign module) is its own business.
 */
export type MemoryProviderConformanceRequestProbe = {
  recallQuery?: string;
  searchQuery?: string;
  addText?: string;
  addSourceReferenceIds?: readonly string[];
  capturedUserMessage?: string;
  healthHasSignal?: boolean;
};

export type MemoryProviderConformanceScenario = {
  /** Records what each verb actually received at the provider boundary. */
  readonly requestProbe?: MemoryProviderConformanceRequestProbe;
  readonly recallItems?: readonly MemoryRecallItem[];
  readonly searchItems?: readonly MemoryRecallItem[];
  readonly addResult?: MemoryAddResult;
  readonly captureResult?: MemoryCaptureResult;
  readonly healthResult?: MemoryHealthResult;
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
  // The factory bounds long namespaces, so the kit must ask it for the
  // names rather than assume the unbounded form and miss the real tools.
  const searchToolName = boundedMemoryToolName(namespace, 'search');
  const addToolName = boundedMemoryToolName(namespace, 'add');

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
      expect(declared.includes('health')).toBe(has('health'));
      expect(declared.includes('on_session_end')).toBe(has('endSession'));
      expect(declared.includes('on_shutdown')).toBe(has('close'));
      expect(plugin.providedTools.map(tool => tool.name)).toEqual([
        ...(has('search') ? [searchToolName] : []),
        ...(has('add') ? [addToolName] : []),
      ]);
      // A memory provider works through its own backend, so anything
      // beyond the turn text it reads and the model input it writes is
      // access the interface cannot justify.
      expect(Object.keys(plugin.manifest.requestedAccess).sort()).toEqual(
        ['model_input', 'turn_context'].filter(name =>
          name === 'turn_context'
            ? has('recall') || has('captureTurn')
            : has('recall') || has('search') || has('add'),
        ),
      );
    });

    it('delivers the caller request to each provider verb', async () => {
      const requestProbe: MemoryProviderConformanceRequestProbe = {};
      const host = await conformanceHost(adapter, {requestProbe});

      await host.beforeRoleModelCall(conformanceContext());
      await host.afterTurnCommitted(conformanceAfterTurnContext());
      if (has('search')) {
        await host.handleToolCall(
          conformanceToolCall(adapter, searchToolName, {query: 'prior'}),
          conformanceContext(),
        );
      }
      if (has('add')) {
        await host.handleToolCall(
          conformanceToolCall(adapter, addToolName, {text: 'New memory.'}),
          conformanceContext(),
        );
      }
      if (has('health')) {
        await host.health(conformanceContext());
      }

      // An adapter that dropped the query or text would still return the
      // seeded result, so the payload itself has to be asserted.
      if (has('recall')) {
        expect(requestProbe.recallQuery).toBe('remember this');
      }
      if (has('captureTurn')) {
        expect(requestProbe.capturedUserMessage).toContain('remember this');
      }
      if (has('search')) {
        expect(requestProbe.searchQuery).toBe('prior');
      }
      if (has('add')) {
        expect(requestProbe.addText).toBe('New memory.');
        // The host supplies the turn a memory came from; an adapter that
        // drops it persists memories with no conversation provenance.
        expect(requestProbe.addSourceReferenceIds).toContain('evt_memory');
      }
      if (has('health')) {
        // Cancellation is what stops backend work: an adapter that drops
        // the signal leaves its check running after the host gave up.
        expect(requestProbe.healthHasSignal).toBe(true);
      }
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
        // The exact bounded text, not just its length: an adapter that
        // substitutes a different string of legal length hands the model
        // a memory nobody stored.
        expect(result.contextItems[0]?.text).toBe(`${'A'.repeat(597)}...`);
        expect(result.evidence).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            evidenceKind: 'before_role_model_call',
            status: 'accepted',
          }),
        );
      });

      it('exposes no more than the bounded number of memory items', async () => {
        const host = await conformanceHost(adapter, {
          recallItems: Array.from(
            {length: memoryProviderMaxItems + 3},
            (_unused, index) => ({
              id: `row-${String(index)}`,
              text: `Short memory ${String(index)}.`,
              sourceReferences: [
                {kind: 'memory' as const, id: `row-${String(index)}`},
              ],
            }),
          ),
        });
        const result = await host.beforeRoleModelCall(conformanceContext());

        expect(result.status).toBe('completed');
        if (result.status !== 'completed') {
          return;
        }

        // Many short rows pass the per-item bound and would still crowd
        // out the rest of the prompt.
        expect(result.contextItems).toHaveLength(memoryProviderMaxItems);
      });

      it('normalizes provider recall IDs into stable context item ids', async () => {
        const host = await conformanceHost(adapter, {
          recallItems: [
            {
              id: '123',
              text: 'Numeric provider row ID should still become context.',
              sourceReferences: [{kind: 'memory', id: '123'}],
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
          sourceReferences: [{kind: 'memory', id: '123'}],
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
            ]) as unknown,
          }),
        );
      });
    }

    if (has('endSession')) {
      it('ends only the provider session on the session-end lifecycle', async () => {
        const lifecycleProbe: MemoryProviderConformanceLifecycleProbe = {
          endedSessions: [],
          closeCalls: 0,
        };
        const host = await conformanceHost(adapter, {lifecycleProbe});
        const sessionEnd = await host.onSessionEnd(conformanceContext());

        expect(lifecycleProbe.endedSessions).toEqual(['session-memory']);
        // A provider shut down at the end of one session cannot serve the
        // next one that opens against the same host.
        expect(lifecycleProbe.closeCalls).toBe(0);
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
      });
    }

    if (has('close')) {
      it('shuts the provider down exactly once however often asked', async () => {
        const lifecycleProbe: MemoryProviderConformanceLifecycleProbe = {
          endedSessions: [],
          closeCalls: 0,
        };
        const host = await conformanceHost(adapter, {lifecycleProbe});
        const shutdown = await host.shutdown(conformanceContext());
        const repeatedShutdown = await host.shutdown(conformanceContext());

        expect(lifecycleProbe.closeCalls).toBe(1);
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

    if (has('health')) {
      it('reports provider health through the host health boundary', async () => {
        const host = await conformanceHost(adapter, {
          healthResult: {status: 'ok', summary: 'Backend reachable.'},
        });
        const healthy = await host.health(conformanceContext());
        const degradedHost = await conformanceHost(adapter, {
          healthResult: {status: 'degraded', summary: 'Backend degraded.'},
        });
        const degraded = await degradedHost.health(conformanceContext());

        expect(healthy.snapshots).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            status: 'ok',
          }),
        );
        expect(healthy.evidence).toEqual([]);
        // A degraded backend must reach the operator as evidence rather
        // than passing silently through the health boundary.
        expect(degraded.snapshots).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            status: 'degraded',
          }),
        );
        expect(degraded.evidence).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            evidenceKind: 'health',
          }),
        );
      });
    }

    if (has('search')) {
      it('returns source-backed search results through the tool surface', async () => {
        // Item and reference share one id so adapters that derive
        // references from backend rows resolve to the same output.
        const host = await conformanceHost(adapter, {
          searchItems: [
            {
              id: 'result-1',
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

        // The model reads the output, not the evidence: an adapter that
        // returned ids without text would leave it with no memory to use.
        expect(search.output).toMatchObject({
          items: [
            {
              id: 'result-1',
              text: 'Prior session detail.',
              sourceReferences: [{kind: 'memory', id: 'result-1'}],
            },
          ],
        });
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

        expect(add.output).toMatchObject({
          id: 'persisted-memory-1',
          // Callers read the tool output, so provenance has to be there
          // and not only in evidence.
          sourceReferences: expect.arrayContaining([
            expect.objectContaining({id: 'persisted-memory-1'}),
          ]) as unknown,
        });
        expect(add.evidence[0]).toMatchObject({
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          sourceReferences: expect.arrayContaining([
            expect.objectContaining({kind: 'memory', id: 'persisted-memory-1'}),
          ]) as unknown,
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

const conformanceTimestamp = '2026-06-21T00:00:00.000Z';

function conformanceContext() {
  return createRuntimePluginContext({
    eventId: 'evt_memory',
    traceId: 'trace_memory',
    createdAt: conformanceTimestamp,
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
