import { mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  characterStatePatchModelToolName
} from '../src/role-model/model-tools.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin
} from '../src/plugins/builtin/character-state/index.ts';
import {
  createDefaultCharacterRuntimeState,
  planCharacterStatePatch
} from '../src/plugins/builtin/character-state/schema.ts';
import {
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  createRuntimePluginContext
} from '../src/plugins/types.ts';
import type {
  RuntimePluginFileStore,
  RuntimePluginJsonObject
} from '../src/plugins/types.ts';
import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';

describe('Character State plugin', () => {
  it('writes valid patches during handleToolCall', async () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-valid');

    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'curious'
        }
      },
      context
    );

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'curious'
        },
        appliedChanges: [
          {
            field: 'mood',
            before: 'steady',
            after: 'curious'
          }
        ]
      }
    });
    expect(fileStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(fileStore.readJson('current.json')).toMatchObject({
      current: {
        mood: 'curious'
      }
    });
  });

  it('rejects invalid patches without mutating the plugin event log', async () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-invalid');

    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'angry'
        }
      },
      context
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_state_value'
    });
    expect(fileStore.readJsonl('events.jsonl')).toEqual([]);
    expect(fileStore.readJson('current.json')).toBeUndefined();
  });

  it('rebuilds current state from events.jsonl when the cache is missing', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-character-state-'));
    const { plugin, context } = createCharacterStateHarness(
      'session-character-state',
      storeRoot
    );

    await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          energy: 'high'
        }
      },
      context
    );
    unlinkSync(
      join(
        storeRoot,
        'sessions',
        'session-character-state',
        'plugins',
        characterStatePluginId,
        'current.json'
      )
    );

    const beforeResult = await plugin.lifecycleHooks.beforeRoleModelCall?.(
      context
    );

    expect(beforeResult?.contextItems[0]?.text).toContain('energy=high');
  });

  it('recovers current state from events when current snapshot write fails after append', async () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-split-write');

    fileStore.writeJsonAtomic('current.json', createDefaultCharacterRuntimeState());

    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'curious'
        }
      },
      {
        ...context,
        fileStore: createCurrentWriteFailingFileStore(fileStore)
      }
    );

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'curious'
        },
        warnings: ['Character State current snapshot write failed: current snapshot write failed']
      }
    });
    expect(
      result?.evidence.some(
        (evidence) =>
          evidence.evidenceKind === 'tool_invocation' &&
          evidence.status === 'degraded'
      )
    ).toBe(true);
    expect(fileStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(fileStore.readJson('current.json')).toMatchObject({
      current: {
        mood: 'steady'
      }
    });

    const beforeResult = await plugin.lifecycleHooks.beforeRoleModelCall?.(
      context
    );

    expect(beforeResult?.contextItems[0]?.text).toContain('mood=curious');
  });

  it('records and replays accepted no-op identities', async () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-noop-idempotency');
    const call = {
      ...testIdentity(),
      pluginId: characterStatePluginId,
      toolName: characterStatePatchModelToolName,
      input: {
        mood: 'steady'
      }
    };

    const first = await plugin.lifecycleHooks.handleToolCall?.(call, context);
    const intervening = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...call,
        eventId: 'evt_character_state_intervening',
        traceId: 'trace_character_state_intervening',
        input: {
          mood: 'curious'
        }
      },
      context
    );
    const retry = await plugin.lifecycleHooks.handleToolCall?.(call, context);
    const conflictingRetry = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...call,
        input: {
          mood: 'curious'
        }
      },
      context
    );

    expect(first).toMatchObject({
      status: 'accepted',
      output: {
        appliedChanges: []
      }
    });
    expect(intervening).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'curious'
        }
      }
    });
    expect(retry).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'steady'
        },
        appliedChanges: [],
        idempotent: true
      }
    });
    expect(conflictingRetry).toMatchObject({
      status: 'rejected',
      reason: 'character_state_idempotency_conflict'
    });
    expect(fileStore.readJsonl('events.jsonl')).toHaveLength(2);
    expect(fileStore.readJson('current.json')).toMatchObject({
      current: {
        mood: 'curious'
      }
    });
  });

  it('rejects malformed persisted appliedChanges instead of recomputing them', () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-malformed-replay');
    const before = createDefaultCharacterRuntimeState();
    const result = planCharacterStatePatch({
      before,
      patchInput: {
        mood: 'curious'
      }
    });

    if (result.status !== 'accepted') {
      throw new Error('Expected valid Character State patch fixture.');
    }

    fileStore.appendJsonl('events.jsonl', {
      type: 'character_state.patch',
      ...testIdentity(),
      input: {
        mood: 'curious'
      },
      result: {
        ...result,
        appliedChanges: [
          {
            field: 'mood',
            before: 'playful',
            after: 'curious'
          }
        ]
      }
    });

    expect(() =>
      plugin.lifecycleHooks.beforeRoleModelCall?.(context)
    ).toThrow(/stored Character State plugin event field/iu);
    expect(() =>
      plugin.lifecycleHooks.handleToolCall?.(
        {
          ...testIdentity(),
          pluginId: characterStatePluginId,
          toolName: characterStatePatchModelToolName,
          input: {
            mood: 'curious'
          }
        },
        context
      )
    ).toThrow(/stored Character State plugin event field/iu);
  });

  it('rejects a discontinuous authoritative event chain', () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-discontinuous-log');
    const initial = createDefaultCharacterRuntimeState();
    const first = acceptedPatchResult(initial, { mood: 'curious' });
    const discontinuous = acceptedPatchResult(initial, { mood: 'playful' });

    appendPatchEvent(fileStore, {
      identity: testIdentity(),
      input: { mood: 'curious' },
      result: first
    });
    appendPatchEvent(fileStore, {
      identity: createRuntimeEventIdentity({
        eventId: 'evt_character_state_discontinuous',
        traceId: 'trace_character_state_discontinuous',
        createdAt: '2026-06-15T00:01:00.000Z'
      }),
      input: { mood: 'playful' },
      result: discontinuous
    });

    expect(() =>
      plugin.lifecycleHooks.beforeRoleModelCall?.(context)
    ).toThrow(/Character State plugin event chain/iu);
  });

  it('requires the first authoritative event to start from the default state', () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-invalid-first-before');
    const nonDefault = acceptedPatchResult(
      createDefaultCharacterRuntimeState(),
      { mood: 'curious' }
    ).after;
    const first = acceptedPatchResult(nonDefault, { mood: 'playful' });

    appendPatchEvent(fileStore, {
      identity: testIdentity(),
      input: { mood: 'playful' },
      result: first
    });

    expect(() =>
      plugin.lifecycleHooks.beforeRoleModelCall?.(context)
    ).toThrow(/Character State plugin event chain/iu);
  });

  it('does not let a cache without events seed the authoritative event chain', async () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-cache-without-log');
    const staleCache = acceptedPatchResult(
      createDefaultCharacterRuntimeState(),
      { mood: 'curious' }
    ).after;

    fileStore.writeJsonAtomic('current.json', staleCache);

    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'playful'
        }
      },
      context
    );

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        appliedChanges: [
          {
            field: 'mood',
            before: 'steady',
            after: 'playful'
          }
        ]
      }
    });
    expect(() =>
      plugin.lifecycleHooks.beforeRoleModelCall?.(context)
    ).not.toThrow();
  });

  it('rejects duplicate persisted idempotency identities', () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-duplicate-identity');
    const identity = testIdentity();
    const first = acceptedPatchResult(
      createDefaultCharacterRuntimeState(),
      { mood: 'curious' }
    );
    const second = acceptedPatchResult(first.after, { mood: 'playful' });

    appendPatchEvent(fileStore, {
      identity,
      input: { mood: 'curious' },
      result: first
    });
    appendPatchEvent(fileStore, {
      identity,
      input: { mood: 'playful' },
      result: second
    });

    expect(() =>
      plugin.lifecycleHooks.beforeRoleModelCall?.(context)
    ).toThrow(/Character State plugin event identity is duplicated/iu);
  });

  it('validates the complete authoritative log before replaying an early duplicate', () => {
    const { plugin, context, fileStore } =
      createCharacterStateHarness('session-character-state-malformed-after-duplicate');
    const identity = testIdentity();
    const initial = createDefaultCharacterRuntimeState();
    const first = acceptedPatchResult(initial, { mood: 'curious' });

    appendPatchEvent(fileStore, {
      identity,
      input: { mood: 'curious' },
      result: first
    });
    fileStore.appendJsonl('events.jsonl', {
      type: 'character_state.patch',
      ...createRuntimeEventIdentity({
        eventId: 'evt_character_state_after_duplicate',
        traceId: 'trace_character_state_after_duplicate',
        createdAt: '2026-06-15T00:01:00.000Z'
      }),
      input: { mood: 'playful' },
      result: {
        status: 'accepted'
      }
    });

    expect(() =>
      plugin.lifecycleHooks.handleToolCall?.(
        {
          ...identity,
          pluginId: characterStatePluginId,
          toolName: characterStatePatchModelToolName,
          input: {
            mood: 'curious'
          }
        },
        context
      )
    ).toThrow(/Stored Character State plugin event field/iu);
  });
});

function createCharacterStateHarness(sessionId: string, storeRoot?: string) {
  const fileStore = createRuntimePluginFileStore({
    ...(storeRoot === undefined ? {} : { storeRoot }),
    sessionId,
    pluginId: characterStatePluginId
  });
  const context = {
    ...createRuntimePluginContext({
      ...testIdentity(),
      sessionId,
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'hello',
      character: {
        id: 'mira',
        displayName: 'Mira'
      }
    }),
    pluginId: characterStatePluginId,
    fileStore
  };

  return {
    plugin: createCharacterStatePlugin(),
    context,
    fileStore
  };
}

function createCurrentWriteFailingFileStore(
  fileStore: RuntimePluginFileStore
): RuntimePluginFileStore {
  return Object.freeze({
    readJson(path) {
      return fileStore.readJson(path);
    },
    readJsonl(path) {
      return fileStore.readJsonl(path);
    },
    writeJsonAtomic(path, value) {
      if (path === 'current.json') {
        throw new Error('current snapshot write failed');
      }

      fileStore.writeJsonAtomic(path, value);
    },
    appendJsonl(path, value) {
      fileStore.appendJsonl(path, value);
    },
    revision() {
      return fileStore.revision();
    }
  } satisfies RuntimePluginFileStore);
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_character_state',
    traceId: 'trace_character_state',
    createdAt: '2026-06-15T00:00:00.000Z'
  });
}

function acceptedPatchResult(
  before: ReturnType<typeof createDefaultCharacterRuntimeState>,
  input: RuntimePluginJsonObject
) {
  const result = planCharacterStatePatch({
    before,
    patchInput: input
  });

  if (result.status !== 'accepted') {
    throw new Error('Expected valid Character State patch fixture.');
  }

  return result;
}

function appendPatchEvent(
  fileStore: RuntimePluginFileStore,
  options: {
    readonly identity: ReturnType<typeof createRuntimeEventIdentity>;
    readonly input: RuntimePluginJsonObject;
    readonly result: ReturnType<typeof acceptedPatchResult>;
  }
) {
  fileStore.appendJsonl('events.jsonl', {
    type: 'character_state.patch',
    ...options.identity,
    input: options.input,
    result: options.result
  });
}
