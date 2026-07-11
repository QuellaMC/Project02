import { describe, expect, it, vi } from 'vitest';

import type {
  RawEventLogRecord,
  RuntimeSessionEvidenceSnapshot
} from '../src/runtime/log.ts';
import { runInspectCliFromArgs } from '../src/cli/inspect.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';
import { collect } from './support/runtime-config.ts';
import { createTestTempRoot } from './support/temp-root.ts';

const runtimeLogStoreFixture = vi.hoisted(() => ({
  readSessionEvidence: vi.fn<() => RuntimeSessionEvidenceSnapshot>()
}));

vi.mock('../src/runtime/storage/file-runtime-log-store.ts', () => ({
  createFileRuntimeLogStore: () => ({
    readSessionEvidence: runtimeLogStoreFixture.readSessionEvidence
  })
}));

describe('inspect CLI evidence indexing', () => {
  it('visits each stored raw event at most twice while projecting a turn', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-visit-gate-');
    const sessionId = 'session-inspect-visit-gate';
    const identity = {
      eventId: 'evt_inspect_visit_gate',
      traceId: 'trace_inspect_visit_gate',
      createdAt: '2026-07-11T00:00:00.000Z'
    } as const;
    const rawEvents = [
      {
        ...identity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      },
      {
        ...identity,
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: 'call_inspect_visit_gate',
        toolRound: 1,
        toolName: 'fixture.read',
        toolPluginId: 'fixture'
      },
      {
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        toolCallIds: ['call_inspect_visit_gate']
      }
    ] satisfies readonly RawEventLogRecord[];
    const countedRawEvents = countClassificationVisits(rawEvents);

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: identity.createdAt
    });
    runtimeLogStoreFixture.readSessionEvidence.mockReturnValue({
      stored: {
        traceEntries: [],
        rawEvents: countedRawEvents.values,
        conversationMessages: []
      },
      derived: {
        traceEntries: []
      }
    });

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', sessionId],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      }
    );
    const output = JSON.parse(stdout) as {
      readonly turns: readonly {
        readonly toolEvents: readonly { readonly callId: string }[];
      }[];
    };

    expect(exitCode).toBe(0);
    expect(output.turns).toHaveLength(1);
    expect(output.turns[0]?.toolEvents).toEqual([
      expect.objectContaining({ callId: 'call_inspect_visit_gate' })
    ]);
    expect(countedRawEvents.visits.every((visits) => visits > 0)).toBe(true);
    expect(Math.max(...countedRawEvents.visits)).toBeLessThanOrEqual(2);
  });
});

// A whole-record projection pass classifies through `kind`. Proxying that
// discriminator makes repeated scans observable without a wall-clock assertion.
function countClassificationVisits<T extends { readonly kind: string }>(
  values: readonly T[]
): {
  readonly values: readonly T[];
  readonly visits: readonly number[];
} {
  const visits = values.map(() => 0);

  return {
    values: values.map(
      (value, index) =>
        new Proxy(value, {
          get(target, property, receiver) {
            if (property === 'kind') {
              visits[index] = (visits[index] ?? 0) + 1;
            }

            return Reflect.get(target, property, receiver);
          }
        })
    ),
    visits
  };
}
