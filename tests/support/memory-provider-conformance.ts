import {
  boundedMemoryToolName,
  memoryProviderMaxItems,
} from '../../src/plugins/builtin/memory-provider/index.ts';
import {afterEach, describe, expect, it} from 'vitest';

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
  /** Session each stateful verb was routed to; wrong routing crosses conversations. */
  sessionIds?: Record<string, string>;
  recallQuery?: string;
  recallMaxItems?: number;
  searchQuery?: string;
  searchMaxItems?: number;
  addText?: string;
  addSourceReferenceIds?: readonly string[];
  capturedUserMessage?: string;
  capturedCharacterMessage?: string;
  capturedSourceReferenceIds?: readonly string[];
  /** Verbs that received a live deadline and cancellation signal. */
  scopedVerbs?: Record<string, boolean>;
};

export type MemoryProviderConformanceScenario = {
  /** Records what each verb actually received at the provider boundary. */
  readonly requestProbe?: MemoryProviderConformanceRequestProbe;
  /** Makes the adapter's backend fail, the way an outage would. */
  readonly failBackend?: boolean;
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
    afterEach(async () => {
      const hosts = openConformanceHosts.splice(0);

      for (const host of hosts) {
        await host.shutdown(conformanceContext());
      }
    });

    it('declares exactly the capability-matched plugin surface', async () => {
      // Registered like every other case, so whatever the adapter opened
      // during construction is closed with the rest.
      const plugin = await conformancePlugin(adapter, {});

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
      // access the interface cannot justify -- at the level each verb
      // uses, since a wider grant is one the host must satisfy.
      expect(plugin.manifest.requestedAccess).toEqual({
        ...(has('recall') || has('captureTurn') ? {turn_context: 'read'} : {}),
        ...(has('recall') || has('search') || has('add')
          ? {model_input: 'write'}
          : {}),
      });
      // Host-generated timeout and failure evidence takes its labels from
      // the manifest, so a provider without this one persists backend
      // errors -- private by nature -- unclassified.
      expect(plugin.manifest.runtimePolicy.redactionLabels).toContain('memory');
      // Memory reads may overlap; a write to it may not overlap itself.
      expect(
        plugin.providedTools.map(tool => [tool.name, tool.concurrency]),
      ).toEqual([
        ...(has('search') ? [[searchToolName, 'shared']] : []),
        ...(has('add') ? [[addToolName, 'exclusive']] : []),
      ]);
    });

    if (has('search') || has('add')) {
      it('rejects tool input its contract does not accept', async () => {
        const host = await conformanceHost(adapter, {});
        const malformed = [
          ...(has('search')
            ? [{toolName: searchToolName, input: {query: ''}}]
            : []),
          ...(has('add') ? [{toolName: addToolName, input: {text: ''}}] : []),
        ];

        // Validation is what stands between a permissive backend and a
        // durable write of whatever the model happened to emit.
        for (const call of malformed) {
          const result = await host.handleToolCall(
            conformanceToolCall(adapter, call.toolName, call.input),
            conformanceContext(),
          );

          expect(result.status).toBe('rejected');
        }
      });
    }

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
        // An adapter that reads everything and trims locally still pays
        // for the oversized backend read on every turn.
        expect(requestProbe.recallMaxItems).toBe(memoryProviderMaxItems);
      }
      if (has('captureTurn')) {
        expect(requestProbe.capturedUserMessage).toContain('remember this');
        // Half a turn is not a turn: what the character answered is where
        // most of what is worth remembering actually lives.
        expect(requestProbe.capturedCharacterMessage).toContain(
          'noted for later',
        );
        // The turn a memory came from travels with the capture too, not
        // only with an explicit add.
        expect(requestProbe.capturedSourceReferenceIds).toContain('evt_memory');
      }
      if (has('search')) {
        expect(requestProbe.searchQuery).toBe('prior');
        expect(requestProbe.searchMaxItems).toBe(memoryProviderMaxItems);
      }
      // A verb that drops or hard-codes the session reads and writes
      // another conversation's memory.
      for (const verb of [
        ...(has('recall') ? ['recall'] : []),
        ...(has('captureTurn') ? ['captureTurn'] : []),
        ...(has('search') ? ['search'] : []),
        ...(has('add') ? ['add'] : []),
      ]) {
        expect(requestProbe.sessionIds?.[verb]).toBe('session-memory');
      }
      if (has('add')) {
        expect(requestProbe.addText).toBe('New memory.');
        // The host supplies the turn a memory came from; an adapter that
        // drops it persists memories with no conversation provenance.
        expect(requestProbe.addSourceReferenceIds).toContain('evt_memory');
      }
      // Cancellation and the deadline are what stop backend work: a verb
      // that drops them leaves its request running after the host gave up.
      for (const verb of [
        ...(has('recall') ? ['recall'] : []),
        ...(has('captureTurn') ? ['captureTurn'] : []),
        ...(has('search') ? ['search'] : []),
        ...(has('add') ? ['add'] : []),
        ...(has('health') ? ['health'] : []),
      ]) {
        expect(requestProbe.scopedVerbs?.[verb]).toBe(true);
      }
    });

    if (has('recall')) {
      it('degrades the turn when its backend fails', async () => {
        const host = await conformanceHost(adapter, {failBackend: true});
        const result = await host.beforeRoleModelCall(conformanceContext());

        // An outage costs the turn its memory, never the turn itself: the
        // factory declares degrade, and a packaged manifest that declared
        // otherwise would reject the user's message instead.
        expect(result.status).toBe('completed');
        if (result.status !== 'completed') {
          return;
        }

        expect(result.contextItems).toEqual([]);
        expect(result.evidence).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            evidenceKind: 'before_role_model_call',
            status: 'degraded',
          }),
        );
      });

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

      it('completes an empty recall instead of degrading the turn', async () => {
        const host = await conformanceHost(adapter, {recallItems: []});
        const result = await host.beforeRoleModelCall(conformanceContext());

        // A new store, or a query nothing matches, is the ordinary case an
        // adapter meets first; throwing there costs the turn its memory.
        expect(result.status).toBe('completed');
        if (result.status !== 'completed') {
          return;
        }

        expect(result.contextItems).toEqual([]);
        // Degrade evidence here would mean the adapter threw on an empty
        // backend, which the policy hides behind the same host result.
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

      it('degrades evidence for a capture the provider declined', async () => {
        const host = await conformanceHost(adapter, {
          captureResult: {captured: false, summary: 'Backend declined.'},
        });
        const result = await host.afterTurnCommitted(
          conformanceAfterTurnContext(),
        );

        // Recording an accepted capture for a turn the backend refused
        // tells the operator memory holds what it does not.
        expect(result.evidence).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            evidenceKind: 'after_turn_committed',
            status: 'degraded',
          }),
        );
      });

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

        // The summary is the operator's explanation of the status, so it
        // has to carry the backend's own words; only the reference
        // adapter can be seeded with the exact text.
        expect(healthy.snapshots).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            status: 'ok',
            summary: expect.stringMatching(/\S/u) as string,
          }),
        );
        if (seam) {
          expect(healthy.snapshots[0]?.summary).toContain('Backend reachable.');
          expect(degraded.snapshots[0]?.summary).toContain('Backend degraded.');
        }
        expect(healthy.evidence).toEqual([]);
        // A degraded backend must reach the operator as evidence rather
        // than passing silently through the health boundary.
        expect(degraded.snapshots).toContainEqual(
          expect.objectContaining({
            pluginId: adapter.pluginId,
            status: 'degraded',
            summary: expect.stringMatching(/\S/u) as string,
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

      it('accepts a no-hit search instead of failing the call', async () => {
        const host = await conformanceHost(adapter, {searchItems: []});
        const search = await host.handleToolCall(
          conformanceToolCall(adapter, searchToolName, {
            query: 'missing memory',
          }),
          conformanceContext(),
        );

        // A backend with nothing to match is an ordinary answer; an
        // adapter that throws or invents rows here fails the model.
        expect(search.status).toBe('accepted');
        if (search.status !== 'accepted') {
          return;
        }

        expect(search.output).toEqual({items: []});

        if (seam) {
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
        }
      });

      it('returns no more than the bounded number of search results', async () => {
        const host = await conformanceHost(adapter, {
          searchItems: Array.from(
            {length: memoryProviderMaxItems + 3},
            (_unused, index) => ({
              id: `hit-${String(index)}`,
              text: `Short hit ${String(index)}.`,
              sourceReferences: [
                {kind: 'memory' as const, id: `hit-${String(index)}`},
              ],
            }),
          ),
        });
        const search = await host.handleToolCall(
          conformanceToolCall(adapter, searchToolName, {query: 'prior'}),
          conformanceContext(),
        );

        expect(search.status).toBe('accepted');
        if (search.status !== 'accepted') {
          return;
        }

        // Many short rows pass the per-item bound and would still fill the
        // model's context with one tool result.
        expect(search.output).toMatchObject({
          items: Array.from(
            {length: memoryProviderMaxItems},
            (_unused, index) => ({id: `hit-${String(index)}`}),
          ),
        });
      });

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

      it('hands the provider the bounded add text, not the raw input', async () => {
        const requestProbe: MemoryProviderConformanceRequestProbe = {};
        const host = await conformanceHost(adapter, {requestProbe});

        await host.handleToolCall(
          conformanceToolCall(adapter, addToolName, {text: 'B'.repeat(700)}),
          conformanceContext(),
        );

        // The tool schema sets no maximum, so an adapter that forwards the
        // model's text unbounded persists whatever it was handed.
        expect(requestProbe.addText).toBe(`${'B'.repeat(597)}...`);
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

async function conformancePlugin(
  adapter: MemoryProviderConformanceAdapter,
  scenario: MemoryProviderConformanceScenario,
): Promise<RuntimePlugin> {
  const plugin = await adapter.createPlugin(scenario);

  registerConformanceHost(plugin);

  return plugin;
}

function registerConformanceHost(plugin: RuntimePlugin) {
  const host = createRuntimePluginHost({
    plugins: [plugin],
    enabledPluginIds: [plugin.manifest.id],
  });

  // Every case builds its own host, and an adapter that holds a database,
  // a worker, or a timer keeps it until its shutdown hook runs.
  openConformanceHosts.push(host);

  return host;
}

async function conformanceHost(
  adapter: MemoryProviderConformanceAdapter,
  scenario: MemoryProviderConformanceScenario,
) {
  return registerConformanceHost(await adapter.createPlugin(scenario));
}

const openConformanceHosts: {shutdown(context: unknown): Promise<unknown>}[] =
  [];

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
        text: 'noted for later',
      },
    ],
  });
}
