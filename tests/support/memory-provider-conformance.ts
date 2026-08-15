import {
  boundedMemoryToolName,
  createMemoryProviderRuntimePlugin,
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
  MemoryCloseResult,
  MemoryHealthResult,
  MemoryRecallItem,
  Project02MemoryProvider,
} from '../../src/plugins/builtin/memory-provider/index.ts';

const referenceMemoryProviderId = 'memory.reference';

/**
 * The reference in-memory implementation every adapter is measured against:
 * a provider that simply honors the scenario seed.
 */
function createReferenceProvider(
  scenario: MemoryProviderConformanceScenario,
): Project02MemoryProvider {
  return {
    id: referenceMemoryProviderId,
    displayName: 'Reference Memory Provider',
    recall(request) {
      if (scenario.requestProbe !== undefined) {
        recordSessionRouting(scenario, 'recall', request.sessionId);
        recordOperationScope(scenario, 'recall', request);
        scenario.requestProbe.recallQuery = request.currentUserMessage;
        scenario.requestProbe.recallMaxItems = request.maxItems;
      }

      return backendAnswer(scenario, {items: scenario.recallItems ?? []});
    },
    captureTurn(turn) {
      if (scenario.requestProbe !== undefined) {
        recordSessionRouting(scenario, 'captureTurn', turn.sessionId);
        recordOperationScope(scenario, 'captureTurn', turn);
        scenario.requestProbe.capturedUserMessage = turn.userMessage;
        if (turn.characterMessage !== undefined) {
          scenario.requestProbe.capturedCharacterMessage =
            turn.characterMessage;
        }
        scenario.requestProbe.capturedSourceReferenceIds =
          turn.sourceReferences.map(reference => reference.id);
      }

      return backendAnswer(
        scenario,
        scenario.captureResult ?? {captured: false, summary: 'Nothing.'},
      );
    },
    search(request) {
      if (scenario.requestProbe !== undefined) {
        recordSessionRouting(scenario, 'search', request.sessionId);
        recordOperationScope(scenario, 'search', request);
        scenario.requestProbe.searchQuery = request.query;
        scenario.requestProbe.searchMaxItems = request.maxItems;
      }

      return backendAnswer(scenario, {items: scenario.searchItems ?? []});
    },
    add(request) {
      if (scenario.requestProbe !== undefined) {
        recordSessionRouting(scenario, 'add', request.sessionId);
        recordOperationScope(scenario, 'add', request);
        scenario.requestProbe.addText = request.text;
        scenario.requestProbe.addSourceReferenceIds =
          request.sourceReferences.map(reference => reference.id);
      }

      return backendAnswer(
        scenario,
        scenario.addResult ?? {id: 'reference-add', sourceReferences: []},
      );
    },
    health(request) {
      if (scenario.requestProbe !== undefined) {
        recordOperationScope(scenario, 'health', request);
      }

      return backendAnswer(
        scenario,
        scenario.healthResult ?? {status: 'ok', summary: 'Reference ready.'},
      );
    },
    endSession(sessionId, scope) {
      recordOperationScope(scenario, 'endSession', scope);
      scenario.lifecycleProbe?.endedSessions.push(sessionId);

      return backendAnswer(scenario, undefined);
    },
    close(scope) {
      recordOperationScope(scenario, 'close', scope);

      if (scenario.lifecycleProbe !== undefined) {
        scenario.lifecycleProbe.closeCalls += 1;
      }

      return backendAnswer(scenario, scenario.closeResult);
    },
  };
}

/**
 * Every verb answers through here, so a seeded outage reaches all of
 * them. A verb that could answer some other way is a verb the contract
 * would quietly stop testing under failure.
 */
function backendAnswer<T>(
  scenario: MemoryProviderConformanceScenario,
  value: T,
): Promise<T> {
  return scenario.failBackend === true
    ? Promise.reject(new Error('Reference backend is unavailable.'))
    : Promise.resolve(value);
}

function recordOperationScope(
  scenario: MemoryProviderConformanceScenario,
  verb: string,
  scope: {readonly deadlineAt: number; readonly signal: AbortSignal},
): void {
  if (scenario.requestProbe === undefined) {
    return;
  }

  scenario.requestProbe.scopedVerbs = {
    ...scenario.requestProbe.scopedVerbs,
    [verb]:
      typeof scope.deadlineAt === 'number' &&
      scope.signal instanceof AbortSignal,
  };
}

function recordSessionRouting(
  scenario: MemoryProviderConformanceScenario,
  verb: string,
  sessionId: string,
): void {
  if (scenario.requestProbe === undefined) {
    return;
  }

  scenario.requestProbe.sessionIds = {
    ...scenario.requestProbe.sessionIds,
    [verb]: sessionId,
  };
}

type MemoryProviderConformanceLifecycleProbe = {
  readonly endedSessions: string[];
  closeCalls: number;
};

/** What each verb was handed, recorded by the provider this file owns. */
type MemoryProviderConformanceRequestProbe = {
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

type MemoryProviderConformanceScenario = {
  /** Records what each verb actually received at the provider boundary. */
  readonly requestProbe?: MemoryProviderConformanceRequestProbe;
  /** Makes the provider's backend fail, the way an outage would. */
  readonly failBackend?: boolean;
  readonly recallItems?: readonly MemoryRecallItem[];
  readonly searchItems?: readonly MemoryRecallItem[];
  readonly addResult?: MemoryAddResult;
  readonly captureResult?: MemoryCaptureResult;
  readonly healthResult?: MemoryHealthResult;
  readonly closeResult?: MemoryCloseResult;
  readonly lifecycleProbe?: MemoryProviderConformanceLifecycleProbe;
};

/**
 * What the runtime guarantees around any memory provider: bounds,
 * evidence, provenance, lifecycle, and failure policy. It runs once,
 * against a provider this file owns and instruments completely, so what
 * the suite can prove never depends on what an adapter volunteers.
 *
 * An adapter's own translation to its backend -- URLs, wire shapes,
 * config resolution -- is proven in that adapter's own tests, where the
 * assertions are concrete.
 */
export function runMemoryProviderSeamContract(): void {
  // The factory bounds long namespaces, so the kit must ask it for the
  // names rather than assume the unbounded form and miss the real tools.
  const searchToolName = boundedMemoryToolName(
    referenceMemoryProviderId,
    'search',
  );
  const addToolName = boundedMemoryToolName(referenceMemoryProviderId, 'add');

  describe('memory provider seam contract', () => {
    afterEach(async () => {
      const hosts = openConformanceHosts.splice(0);

      for (const host of hosts) {
        await host.shutdown(conformanceContext());
      }
    });

    it('declares the surface its implemented verbs imply', () => {
      // Registered like every other case, so whatever construction opened
      // is closed with the rest -- in exactly one host, since a second
      // would run the provider's close twice.
      const plugin = conformancePlugin({});

      registerConformanceHost(plugin);

      // The factory derives the whole surface from the implemented verbs,
      // so a provider that implements all of them declares all of them.
      expect(plugin.manifest.id).toBe(referenceMemoryProviderId);
      expect(plugin.manifest.kind).toBe('memory_provider');
      expect([...plugin.manifest.declaredPlugins].sort()).toEqual([
        'after_turn_committed',
        'before_role_model_call',
        'handle_tool_call',
        'health',
        'on_session_end',
        'on_shutdown',
        'plugin_discovery',
        'tool_provider',
      ]);
      expect(plugin.providedTools.map(tool => tool.name)).toEqual([
        searchToolName,
        addToolName,
      ]);
      // A memory provider works through its own backend, so anything
      // beyond the turn text it reads and the model input it writes is
      // access the interface cannot justify -- at the level each verb
      // uses, since a wider grant is one the host must satisfy.
      expect(plugin.manifest.requestedAccess).toEqual({
        turn_context: 'read',
        model_input: 'write',
      });
      // Host-generated timeout and failure evidence takes its labels from
      // the manifest, so a provider without this one persists backend
      // errors -- private by nature -- unclassified.
      expect(plugin.manifest.runtimePolicy.redactionLabels).toContain('memory');
      // Memory reads may overlap; a write to it may not overlap itself.
      expect(
        plugin.providedTools.map(tool => [tool.name, tool.concurrency]),
      ).toEqual([
        [searchToolName, 'shared'],
        [addToolName, 'exclusive'],
      ]);
    });

    it('rejects tool input its contract does not accept', async () => {
      const requestProbe: MemoryProviderConformanceRequestProbe = {};
      const host = conformanceHost({requestProbe});
      const malformed = [
        {toolName: searchToolName, input: {query: ''}},
        {toolName: searchToolName, input: {}},
        {toolName: searchToolName, input: {query: 7}},
        {toolName: addToolName, input: {text: ''}},
        {toolName: addToolName, input: {}},
        {toolName: addToolName, input: {text: 7}},
      ];

      // Validation is what stands between a permissive backend and a
      // durable write of whatever the model happened to emit.
      for (const call of malformed) {
        const result = await host.handleToolCall(
          conformanceToolCall(call.toolName, call.input),
          conformanceContext(),
        );

        expect(result.status).toBe('rejected');
      }

      // Rejected input must not have reached the provider at all: what
      // gets past validation is what reaches durable memory.
      expect(requestProbe.searchQuery).toBeUndefined();
      expect(requestProbe.addText).toBeUndefined();
    });

    it('delivers the caller request to each provider verb', async () => {
      const requestProbe: MemoryProviderConformanceRequestProbe = {};
      const host = conformanceHost({requestProbe});

      await host.beforeRoleModelCall(conformanceContext());
      await host.afterTurnCommitted(conformanceAfterTurnContext());
      await host.handleToolCall(
        conformanceToolCall(searchToolName, {query: 'prior'}),
        conformanceContext(),
      );
      await host.handleToolCall(
        conformanceToolCall(addToolName, {text: 'New memory.'}),
        conformanceContext(),
      );
      await host.health(conformanceContext());
      await host.onSessionEnd(conformanceContext());
      await host.shutdown(conformanceContext());

      // An adapter that dropped the query or text would still return the
      // seeded result, so the payload itself has to be asserted.
      expect(requestProbe.recallQuery).toBe('remember this');
      // An adapter that reads everything and trims locally still pays
      // for the oversized backend read on every turn.
      expect(requestProbe.recallMaxItems).toBe(memoryProviderMaxItems);
      expect(requestProbe.capturedUserMessage).toContain('remember this');
      // Half a turn is not a turn: what the character answered is where
      // most of what is worth remembering actually lives.
      expect(requestProbe.capturedCharacterMessage).toContain(
        'noted for later',
      );
      // The turn a memory came from travels with the capture too, not
      // only with an explicit add.
      expect(requestProbe.capturedSourceReferenceIds).toContain('evt_memory');
      expect(requestProbe.searchQuery).toBe('prior');
      expect(requestProbe.searchMaxItems).toBe(memoryProviderMaxItems);
      // A verb that drops or hard-codes the session reads and writes
      // another conversation's memory.
      for (const verb of ['recall', 'captureTurn', 'search', 'add']) {
        expect(requestProbe.sessionIds?.[verb]).toBe('session-memory');
      }
      expect(requestProbe.addText).toBe('New memory.');
      // The host supplies the turn a memory came from; an adapter that
      // drops it persists memories with no conversation provenance.
      expect(requestProbe.addSourceReferenceIds).toContain('evt_memory');
      // Cancellation and the deadline are what stop backend work: a verb
      // that drops them leaves its request running after the host gave up.
      for (const verb of [
        'recall',
        'captureTurn',
        'search',
        'add',
        'health',
        'endSession',
        'close',
      ]) {
        expect(requestProbe.scopedVerbs?.[verb]).toBe(true);
      }
    });

    it('degrades the turn when its backend fails', async () => {
      const host = conformanceHost({failBackend: true});
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
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'before_role_model_call',
          status: 'degraded',
        }),
      );
    });

    it('provides bounded, source-backed recall context items', async () => {
      const host = conformanceHost({
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
        pluginId: referenceMemoryProviderId,
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
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'before_role_model_call',
          status: 'accepted',
        }),
      );
    });

    it('completes an empty recall instead of degrading the turn', async () => {
      const host = conformanceHost({recallItems: []});
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
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'before_role_model_call',
          status: 'accepted',
        }),
      );
    });

    it('bounds the provenance a single recalled row carries', async () => {
      const host = conformanceHost({
        recallItems: [
          {
            id: 'busy-row',
            text: 'A row with more provenance than one item may carry.',
            sourceReferences: Array.from({length: 40}, (_unused, index) => ({
              kind: 'memory' as const,
              id: `source-${String(index)}`,
            })),
          },
        ],
      });
      const result = await host.beforeRoleModelCall(conformanceContext());

      // Past the host's ceiling, context-item validation rejects the
      // whole recall rather than the surplus.
      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        return;
      }

      expect(
        result.contextItems[0]?.sourceReferences.length ?? 0,
      ).toBeLessThanOrEqual(32);
      expect(result.contextItems[0]?.sourceReferences[0]).toMatchObject({
        id: 'source-0',
      });
    });

    it('exposes no more than the bounded number of memory items', async () => {
      const host = conformanceHost({
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
      const host = conformanceHost({
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
          pluginId: referenceMemoryProviderId,
          status: 'degraded',
        }),
      );
    });

    it('omits source-less recall items without rejecting valid rows', async () => {
      const host = conformanceHost({
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
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'before_role_model_call',
          status: 'accepted',
          summary: 'Provided 1 memory item(s).',
        }),
      );
    });

    it('degrades source-less capture evidence with the current-turn reference', async () => {
      const host = conformanceHost({
        captureResult: {captured: true, summary: 'Captured.'},
      });
      const result = await host.afterTurnCommitted(
        conformanceAfterTurnContext(),
      );

      expect(result.status).toBe('completed');
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
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
    });

    it('degrades evidence for a capture the provider declined', async () => {
      const host = conformanceHost({
        captureResult: {captured: false, summary: 'Backend declined.'},
      });
      const result = await host.afterTurnCommitted(
        conformanceAfterTurnContext(),
      );

      // Recording an accepted capture for a turn the backend refused
      // tells the operator memory holds what it does not.
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'after_turn_committed',
          status: 'degraded',
        }),
      );
    });

    it('degrades evidence when the capture backend fails outright', async () => {
      const host = conformanceHost({failBackend: true});
      const result = await host.afterTurnCommitted(
        conformanceAfterTurnContext(),
      );

      // An adapter that swallowed the outage and reported an accepted
      // capture would record a conversation as persisted when it was not.
      expect(result.status).toBe('completed_with_failures');
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'after_turn_committed',
          status: expect.stringMatching(/degraded|failed/u) as unknown,
        }),
      );
      expect(result.evidence).not.toContainEqual(
        expect.objectContaining({
          evidenceKind: 'after_turn_committed',
          status: 'accepted',
        }),
      );
    });

    it('preserves provider capture source references as accepted evidence', async () => {
      const host = conformanceHost({
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
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'after_turn_committed',
          status: 'accepted',
          sourceReferences: expect.arrayContaining([
            expect.objectContaining({kind: 'memory', id: 'memory-capture-1'}),
          ]) as unknown,
        }),
      );
    });

    it('reports a session end its provider could not finish', async () => {
      const host = conformanceHost({failBackend: true});
      const sessionEnd = await host.onSessionEnd(conformanceContext());

      // Memory a provider flushes at session end is memory the next
      // session expects to find: an accepted record for a flush that
      // threw would say the conversation was kept when it was not.
      expect(sessionEnd.status).toBe('completed_with_failures');
      expect(sessionEnd.evidence).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'session_end',
          status: 'failed',
        }),
      );
    });

    it('records work a provider could not finish while closing', async () => {
      const host = conformanceHost({
        closeResult: {
          drained: false,
          summary: 'Closed memory provider. 1 capture(s) did not complete.',
        },
      });
      const shutdown = await host.shutdown(conformanceContext());

      // Nothing runs after shutdown: no later turn, no health call, and
      // the next launch builds a fresh provider. An accepted record here
      // would be the last word on work that never landed.
      expect(shutdown.evidence).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'shutdown',
          status: 'degraded',
          summary: 'Closed memory provider. 1 capture(s) did not complete.',
        }),
      );
    });

    it('ends only the provider session on the session-end lifecycle', async () => {
      const lifecycleProbe: MemoryProviderConformanceLifecycleProbe = {
        endedSessions: [],
        closeCalls: 0,
      };
      const host = conformanceHost({lifecycleProbe});
      const sessionEnd = await host.onSessionEnd(conformanceContext());

      expect(lifecycleProbe.endedSessions).toEqual(['session-memory']);
      // A provider shut down at the end of one session cannot serve the
      // next one that opens against the same host.
      expect(lifecycleProbe.closeCalls).toBe(0);
      expect(sessionEnd).toMatchObject({
        status: 'completed',
        evidence: [
          {
            pluginId: referenceMemoryProviderId,
            evidenceKind: 'session_end',
            status: 'accepted',
          },
        ],
      });
    });

    it('shuts the provider down exactly once however often asked', async () => {
      const lifecycleProbe: MemoryProviderConformanceLifecycleProbe = {
        endedSessions: [],
        closeCalls: 0,
      };
      const host = conformanceHost({lifecycleProbe});
      const shutdown = await host.shutdown(conformanceContext());
      const repeatedShutdown = await host.shutdown(conformanceContext());

      expect(lifecycleProbe.closeCalls).toBe(1);
      expect(shutdown).toMatchObject({
        status: 'completed',
        evidence: [
          {
            pluginId: referenceMemoryProviderId,
            evidenceKind: 'shutdown',
            status: 'accepted',
          },
        ],
      });
      expect(repeatedShutdown).toBe(shutdown);
    });

    it('reports provider health through the host health boundary', async () => {
      const host = conformanceHost({
        healthResult: {status: 'ok', summary: 'Backend reachable.'},
      });
      const healthy = await host.health(conformanceContext());
      const degradedHost = conformanceHost({
        healthResult: {status: 'degraded', summary: 'Backend degraded.'},
      });
      const degraded = await degradedHost.health(conformanceContext());

      // The summary is the operator's explanation of the status, so it
      // has to carry the backend's own words; only the reference
      // adapter can be seeded with the exact text.
      expect(healthy.snapshots).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          status: 'ok',
          summary: expect.stringMatching(/\S/u) as string,
        }),
      );
      expect(healthy.snapshots[0]?.summary).toContain('Backend reachable.');
      expect(healthy.evidence).toEqual([]);
      // A degraded backend must reach the operator as evidence rather
      // than passing silently through the health boundary.
      expect(degraded.snapshots).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          status: 'degraded',
          summary: expect.stringMatching(/\S/u) as string,
        }),
      );
      expect(degraded.evidence).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'health',
        }),
      );

      // A health backend that throws is the outage itself: reporting the
      // plugin healthy, or nothing at all, would hide it from the
      // operator's one diagnosis surface.
      const outageHost = conformanceHost({failBackend: true});
      const outage = await outageHost.health(conformanceContext());

      expect(outage.snapshots).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          status: expect.stringMatching(/degraded|unavailable/u) as unknown,
        }),
      );
      expect(outage.evidence).toContainEqual(
        expect.objectContaining({
          pluginId: referenceMemoryProviderId,
          evidenceKind: 'health',
        }),
      );
    });

    it('returns source-backed search results through the tool surface', async () => {
      // Item and reference share one id so adapters that derive
      // references from backend rows resolve to the same output.
      const host = conformanceHost({
        searchItems: [
          {
            id: 'result-1',
            text: 'Prior session detail.',
            sourceReferences: [{kind: 'memory', id: 'result-1'}],
            confidence: 0.6,
          },
        ],
      });
      const search = await host.handleToolCall(
        conformanceToolCall(searchToolName, {query: 'prior'}),
        conformanceContext(),
      );

      expect(search.status).toBe('accepted');
      if (search.status !== 'accepted') {
        return;
      }

      // The model reads the output, not the evidence: an adapter that
      // returned ids without text would leave it with no memory to use,
      // and one that dropped confidence would erase the signal separating
      // weak matches from strong ones.
      expect(search.output).toMatchObject({
        items: [
          {
            id: 'result-1',
            text: 'Prior session detail.',
            sourceReferences: [{kind: 'memory', id: 'result-1'}],
            confidence: 0.6,
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
      const host = conformanceHost({searchItems: []});
      const search = await host.handleToolCall(
        conformanceToolCall(searchToolName, {
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
    });

    it('bounds the text of a search result the model reads', async () => {
      const host = conformanceHost({
        searchItems: [
          {
            id: 'long-hit',
            text: 'C'.repeat(700),
            sourceReferences: [{kind: 'memory', id: 'long-hit'}],
          },
        ],
      });
      const search = await host.handleToolCall(
        conformanceToolCall(searchToolName, {query: 'prior'}),
        conformanceContext(),
      );

      expect(search.status).toBe('accepted');
      if (search.status !== 'accepted') {
        return;
      }

      // A long stored memory answered in full crowds the model's
      // context out of one tool result.
      expect(search.output).toMatchObject({
        items: [{id: 'long-hit', text: `${'C'.repeat(597)}...`}],
      });
    });

    it('returns no more than the bounded number of search results', async () => {
      const host = conformanceHost({
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
        conformanceToolCall(searchToolName, {query: 'prior'}),
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

    it('omits source-less search items before accepting the result', async () => {
      const host = conformanceHost({
        searchItems: [
          {
            id: 'source-less',
            text: 'This item lacks evidence.',
            sourceReferences: [],
          },
        ],
      });
      const search = await host.handleToolCall(
        conformanceToolCall(searchToolName, {
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
    });

    it('persists an explicit memory through the add tool', async () => {
      const host = conformanceHost({
        addResult: {
          id: 'persisted-memory-1',
          sourceReferences: [{kind: 'memory', id: 'persisted-memory-1'}],
        },
      });
      const add = await host.handleToolCall(
        conformanceToolCall(addToolName, {
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

    it('reports a failed tool call instead of inventing an answer', async () => {
      const host = conformanceHost({failBackend: true});
      const add = await host.handleToolCall(
        conformanceToolCall(addToolName, {text: 'New memory.'}),
        conformanceContext(),
      );
      const search = await host.handleToolCall(
        conformanceToolCall(searchToolName, {query: 'prior'}),
        conformanceContext(),
      );

      // Telling the model a memory was stored when the backend refused
      // it puts a fact in the conversation that nothing holds; answering
      // a failed search with no hits hides the outage behind an ordinary
      // empty result.
      expect(add.status).toBe('rejected');
      expect(search.status).toBe('rejected');
    });

    it('hands the provider the bounded add text, not the raw input', async () => {
      const requestProbe: MemoryProviderConformanceRequestProbe = {};
      const host = conformanceHost({requestProbe});

      await host.handleToolCall(
        conformanceToolCall(addToolName, {text: 'B'.repeat(700)}),
        conformanceContext(),
      );

      // The tool schema sets no maximum, so an adapter that forwards the
      // model's text unbounded persists whatever it was handed.
      expect(requestProbe.addText).toBe(`${'B'.repeat(597)}...`);
    });

    it('synthesizes a persisted memory reference for add results without one', async () => {
      const host = conformanceHost({
        addResult: {id: 'persisted-memory-1', sourceReferences: []},
      });
      const add = await host.handleToolCall(
        conformanceToolCall(addToolName, {
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
    });
  });
}

function conformancePlugin(
  scenario: MemoryProviderConformanceScenario,
): RuntimePlugin {
  return createMemoryProviderRuntimePlugin(createReferenceProvider(scenario));
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

function conformanceHost(scenario: MemoryProviderConformanceScenario) {
  return registerConformanceHost(conformancePlugin(scenario));
}

const openConformanceHosts: {shutdown(context: unknown): Promise<unknown>}[] =
  [];

function conformanceToolCall(
  toolName: string,
  input: Readonly<Record<string, string | number>>,
) {
  return {
    eventId: 'evt_memory',
    traceId: 'trace_memory',
    createdAt: '2026-06-21T00:00:00.000Z',
    pluginId: referenceMemoryProviderId,
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
