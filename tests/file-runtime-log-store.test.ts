import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  createFileRuntimeLogStore
} from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import {
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  LocalRuntimeStorageContractError
} from '../src/runtime/storage/layout.ts';

describe('file runtime log store plugin tool event validation', () => {
  it('rejects started tool calls without matching finished records', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-tools',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-tools'
    });

    appendTurnPrefix(logStore);
    logStore.appendRawEvent({
      ...identity(),
      kind: 'tool_call_started',
      eventType: 'USER_MESSAGE',
      toolCallId: 'round-1.1.memory.search',
      toolRound: 1,
      toolName: 'memory.search',
      toolPluginId: 'memory.fixture',
      toolInput: {
        query: 'Mira'
      }
    });

    expect(() => logStore.rawEvents()).toThrow(LocalRuntimeStorageContractError);
  });

  it('rejects terminal events that reference unfinished tool calls', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-terminal-tools',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-terminal-tools'
    });

    appendTurnPrefix(logStore, 'evt_terminal_tool_ref');
    expect(() =>
      logStore.appendRawEvent({
        ...identity('evt_terminal_tool_ref'),
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        toolCallIds: ['round-1.1.memory.search']
      })
    ).toThrow(LocalRuntimeStorageContractError);
  });
});

function createStoreRoot(): string {
  return mkdtempSync(join(tmpdir(), 'project02-log-store-'));
}

function identity(eventId = 'evt_tool_events') {
  return createRuntimeEventIdentity({
    eventId,
    traceId: `trace_${eventId}`,
    createdAt: '2026-06-15T00:00:00.000Z'
  });
}

function appendTurnPrefix(
  logStore: ReturnType<typeof createFileRuntimeLogStore>,
  eventId = 'evt_tool_events'
): void {
  logStore.appendTrace({
    ...identity(eventId),
    step: 'runtime_event_received'
  });
  logStore.appendRawEvent({
    ...identity(eventId),
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE'
  });
  logStore.appendRawEvent({
    ...identity(eventId),
    kind: 'runtime_event_normalized',
    eventType: 'USER_MESSAGE'
  });
}
