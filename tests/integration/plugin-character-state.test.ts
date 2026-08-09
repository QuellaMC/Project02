import {testCharacterProfile} from '../support/character-fixtures.ts';
import {mkdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';

import {describe, expect, it} from 'vitest';

import {characterStatePatchModelToolName} from '../../src/plugins/api/contract.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
  createProject02Plugin as createCompatibleProject02Plugin,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {createProject02Plugin} from '../../src/plugins/packages/character-state/index.ts';
import {
  createDefaultCharacterRuntimeState,
  planCharacterStatePatch,
} from '../../src/plugins/packages/character-state/schema.ts';
import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {createRuntimePluginContext} from '../../src/plugins/api/index.ts';
import type {
  RuntimePluginFileStore,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
} from '../../src/plugins/api/index.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {
  durablePathModesFileName,
  durableRevisionFileName,
} from '../../src/runtime/storage/plugin-file-store/shared.ts';
import {createLocalRuntimePluginPaths} from '../../src/runtime/storage/layout-contract.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('Character State plugin', () => {
  it('exposes the descriptor-backed package factory through the compatibility path', () => {
    const manifest = createCharacterStatePluginManifest();
    const plugin = createProject02Plugin({
      pluginId: characterStatePluginId,
      manifest,
      storeRoot: '.project02/character-data/mira',
      resolvedConfig: Object.freeze({}),
      redactedConfig: Object.freeze({}),
    });

    expect(createCompatibleProject02Plugin).toBe(createProject02Plugin);
    expect(plugin.manifest).toEqual(manifest);
    expect(plugin.providedTools.map(tool => tool.name)).toEqual([
      characterStatePatchModelToolName,
    ]);
  });

  it('writes valid patches during handleToolCall', async () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-valid',
    );

    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'curious',
        },
      },
      context,
    );

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'curious',
        },
        appliedChanges: [
          {
            field: 'mood',
            before: 'steady',
            after: 'curious',
          },
        ],
      },
    });
    expect(fileStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(fileStore.readJson('checkpoint.json')).toMatchObject({
      current: {
        current: {
          mood: 'curious',
        },
      },
    });
  });

  it('rejects invalid patches without mutating the plugin event log', async () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-invalid',
    );

    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'angry',
        },
      },
      context,
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_state_value',
    });
    expect(fileStore.readJsonl('events.jsonl')).toEqual([]);
    expect(fileStore.readJson('current.json')).toBeUndefined();
  });

  it('rebuilds current state from events.jsonl when the cache is missing', async () => {
    const storeRoot = createTestTempRoot('project02-character-state-');
    const {plugin, context} = createCharacterStateHarness(
      'session-character-state',
      storeRoot,
    );

    await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          energy: 'high',
        },
      },
      context,
    );
    unlinkSync(
      join(storeRoot, 'plugin-data', characterStatePluginId, 'checkpoint.json'),
    );

    const beforeResult =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(context);

    expect(beforeResult?.contextItems[0]?.text).toContain('energy=high');
  });

  it('records and replays accepted no-op identities', async () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-noop-idempotency',
    );
    const call = {
      ...testIdentity(),
      pluginId: characterStatePluginId,
      toolName: characterStatePatchModelToolName,
      input: {
        mood: 'steady',
      },
    };

    const first = await plugin.lifecycleHooks.handleToolCall?.(call, context);
    const intervening = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...call,
        eventId: 'evt_character_state_intervening',
        traceId: 'trace_character_state_intervening',
        input: {
          mood: 'curious',
        },
      },
      context,
    );
    const retry = await plugin.lifecycleHooks.handleToolCall?.(call, context);
    const conflictingRetry = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...call,
        input: {
          mood: 'curious',
        },
      },
      context,
    );

    expect(first).toMatchObject({
      status: 'accepted',
      output: {
        appliedChanges: [],
      },
    });
    expect(intervening).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'curious',
        },
      },
    });
    expect(retry).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'steady',
        },
        appliedChanges: [],
        idempotent: true,
      },
    });
    expect(conflictingRetry).toMatchObject({
      status: 'rejected',
      reason: 'character_state_idempotency_conflict',
    });
    expect(fileStore.readJsonl('events.jsonl')).toHaveLength(2);
    expect(fileStore.readJson('checkpoint.json')).toMatchObject({
      current: {
        current: {
          mood: 'curious',
        },
      },
    });
  });

  it('migrates a legacy event log once and keeps later prompts and patches off the log', async () => {
    const legacyEvents = createLegacyPatchEvents(1_000);
    const instrumented =
      createInstrumentedCharacterStateFileStore(legacyEvents);
    const {plugin, context} = createCharacterStateHarness(
      'session-character-state-checkpoint',
      undefined,
      instrumented.fileStore,
    );

    const firstContext =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(context);

    expect(firstContext?.contextItems[0]?.text).toContain('mood=steady');
    expect(instrumented.eventLogReadCount()).toBe(1);

    for (let index = 0; index < 100; index += 1) {
      if (index % 2 === 0) {
        await plugin.lifecycleHooks.beforeRoleModelCall?.(context);
        continue;
      }

      const identity = createRuntimeEventIdentity({
        eventId: `evt_character_state_fast_${String(index)}`,
        traceId: `trace_character_state_fast_${String(index)}`,
        createdAt: new Date(
          Date.parse('2026-06-16T00:00:00.000Z') + index * 1_000,
        ).toISOString(),
      });
      const result = await plugin.lifecycleHooks.handleToolCall?.(
        {
          ...identity,
          pluginId: characterStatePluginId,
          toolName: characterStatePatchModelToolName,
          input: {
            mood: index % 4 === 1 ? 'curious' : 'steady',
          },
        },
        context,
      );

      expect(result?.status).toBe('accepted');
    }

    expect(instrumented.eventLogReadCount()).toBe(1);
    expect(instrumented.jsonPaths()).toContain('checkpoint.json');
    expect(
      instrumented
        .jsonPaths()
        .filter(path => /^idempotency\/[0-9a-f]{64}\.json$/u.test(path)),
    ).toHaveLength(1_050);
  });

  it('fails closed on an unknown checkpoint version', () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-unknown-checkpoint',
    );

    fileStore.writeJsonAtomic('checkpoint.json', {
      kind: 'character_state.checkpoint',
      version: 99,
      eventCount: 0,
      storeRevision: 1,
      current: createDefaultCharacterRuntimeState(),
    });

    expect(() => plugin.lifecycleHooks.beforeRoleModelCall?.(context)).toThrow(
      /Character State checkpoint is malformed/iu,
    );
    expect(fileStore.readJsonl('events.jsonl')).toEqual([]);
  });

  it('keeps durable checkpoint reads bounded as idempotency paths grow', async () => {
    const small = await measureDurableCharacterStatePromptReads({
      pathCount: 8,
      sessionId: 'session-character-state-scale-small',
    });
    const large = await measureDurableCharacterStatePromptReads({
      pathCount: 8_000,
      sessionId: 'session-character-state-scale-large',
    });

    expect(
      large,
      `durable Character State prompt reads scaled from ${small.toFixed(1)}ms to ${large.toFixed(1)}ms`,
    ).toBeLessThan(small * 8 + 100);
  }, 15_000);

  it('rejects malformed persisted appliedChanges instead of recomputing them', () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-malformed-replay',
    );
    const before = createDefaultCharacterRuntimeState();
    const result = planCharacterStatePatch({
      before,
      patchInput: {
        mood: 'curious',
      },
    });

    if (result.status !== 'accepted') {
      throw new Error('Expected valid Character State patch fixture.');
    }

    fileStore.appendJsonl('events.jsonl', {
      type: 'character_state.patch',
      ...testIdentity(),
      input: {
        mood: 'curious',
      },
      result: {
        ...result,
        appliedChanges: [
          {
            field: 'mood',
            before: 'playful',
            after: 'curious',
          },
        ],
      },
    });

    expect(() => plugin.lifecycleHooks.beforeRoleModelCall?.(context)).toThrow(
      /stored Character State plugin event field/iu,
    );
    expect(() =>
      plugin.lifecycleHooks.handleToolCall?.(
        {
          ...testIdentity(),
          pluginId: characterStatePluginId,
          toolName: characterStatePatchModelToolName,
          input: {
            mood: 'curious',
          },
        },
        context,
      ),
    ).toThrow(/stored Character State plugin event field/iu);
  });

  it('rejects non-canonical persisted event timestamps', () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-noncanonical-timestamp',
    );
    const initial = createDefaultCharacterRuntimeState();
    const result = acceptedPatchResult(initial, {mood: 'curious'});

    fileStore.appendJsonl('events.jsonl', {
      type: 'character_state.patch',
      eventId: 'evt_character_state_noncanonical',
      traceId: 'trace_character_state_noncanonical',
      createdAt: '2026-06-15T00:00:00Z',
      input: {mood: 'curious'},
      result,
    });

    expect(() => plugin.lifecycleHooks.beforeRoleModelCall?.(context)).toThrow(
      /Character State plugin event is malformed/iu,
    );
  });

  it('rejects a discontinuous authoritative event chain', () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-discontinuous-log',
    );
    const initial = createDefaultCharacterRuntimeState();
    const first = acceptedPatchResult(initial, {mood: 'curious'});
    const discontinuous = acceptedPatchResult(initial, {mood: 'playful'});

    appendPatchEvent(fileStore, {
      identity: testIdentity(),
      input: {mood: 'curious'},
      result: first,
    });
    appendPatchEvent(fileStore, {
      identity: createRuntimeEventIdentity({
        eventId: 'evt_character_state_discontinuous',
        traceId: 'trace_character_state_discontinuous',
        createdAt: '2026-06-15T00:01:00.000Z',
      }),
      input: {mood: 'playful'},
      result: discontinuous,
    });

    expect(() => plugin.lifecycleHooks.beforeRoleModelCall?.(context)).toThrow(
      /Character State plugin event chain/iu,
    );
  });

  it('requires the first authoritative event to start from the default state', () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-invalid-first-before',
    );
    const nonDefault = acceptedPatchResult(
      createDefaultCharacterRuntimeState(),
      {mood: 'curious'},
    ).after;
    const first = acceptedPatchResult(nonDefault, {mood: 'playful'});

    appendPatchEvent(fileStore, {
      identity: testIdentity(),
      input: {mood: 'playful'},
      result: first,
    });

    expect(() => plugin.lifecycleHooks.beforeRoleModelCall?.(context)).toThrow(
      /Character State plugin event chain/iu,
    );
  });

  it('does not let a cache without events seed the authoritative event chain', async () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-cache-without-log',
    );
    const staleCache = acceptedPatchResult(
      createDefaultCharacterRuntimeState(),
      {mood: 'curious'},
    ).after;

    fileStore.writeJsonAtomic('current.json', staleCache);

    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...testIdentity(),
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood: 'playful',
        },
      },
      context,
    );

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        appliedChanges: [
          {
            field: 'mood',
            before: 'steady',
            after: 'playful',
          },
        ],
      },
    });
    expect(() =>
      plugin.lifecycleHooks.beforeRoleModelCall?.(context),
    ).not.toThrow();
  });

  it('rejects duplicate persisted idempotency identities', () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-duplicate-identity',
    );
    const identity = testIdentity();
    const first = acceptedPatchResult(createDefaultCharacterRuntimeState(), {
      mood: 'curious',
    });
    const second = acceptedPatchResult(first.after, {mood: 'playful'});

    appendPatchEvent(fileStore, {
      identity,
      input: {mood: 'curious'},
      result: first,
    });
    appendPatchEvent(fileStore, {
      identity,
      input: {mood: 'playful'},
      result: second,
    });

    expect(() => plugin.lifecycleHooks.beforeRoleModelCall?.(context)).toThrow(
      /Character State plugin event identity is duplicated/iu,
    );
  });

  it('validates the complete authoritative log before replaying an early duplicate', () => {
    const {plugin, context, fileStore} = createCharacterStateHarness(
      'session-character-state-malformed-after-duplicate',
    );
    const identity = testIdentity();
    const initial = createDefaultCharacterRuntimeState();
    const first = acceptedPatchResult(initial, {mood: 'curious'});

    appendPatchEvent(fileStore, {
      identity,
      input: {mood: 'curious'},
      result: first,
    });
    fileStore.appendJsonl('events.jsonl', {
      type: 'character_state.patch',
      ...createRuntimeEventIdentity({
        eventId: 'evt_character_state_after_duplicate',
        traceId: 'trace_character_state_after_duplicate',
        createdAt: '2026-06-15T00:01:00.000Z',
      }),
      input: {mood: 'playful'},
      result: {
        status: 'accepted',
      },
    });

    expect(() =>
      plugin.lifecycleHooks.handleToolCall?.(
        {
          ...identity,
          pluginId: characterStatePluginId,
          toolName: characterStatePatchModelToolName,
          input: {
            mood: 'curious',
          },
        },
        context,
      ),
    ).toThrow(/Stored Character State plugin event field/iu);
  });
});

function createCharacterStateHarness(
  sessionId: string,
  storeRoot?: string,
  injectedFileStore?: RuntimePluginFileStore,
) {
  const fileStore =
    injectedFileStore ??
    createRuntimePluginFileStore({
      ...(storeRoot === undefined ? {} : {storeRoot}),
      sessionId,
      ...(storeRoot === undefined ? {sessionIdentity: {}} : {}),
      pluginId: characterStatePluginId,
      scope: 'character',
    });
  const context = {
    ...createCharacterStateContext({sessionId, fileStore}),
  };

  return {
    plugin: createCharacterStatePlugin(),
    context,
    fileStore,
  };
}

function createCharacterStateContext(options: {
  readonly sessionId: string;
  readonly fileStore: RuntimePluginFileStore;
}) {
  return {
    ...createRuntimePluginContext({
      ...testIdentity(),
      sessionId: options.sessionId,
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'hello',
      character: testCharacterProfile,
    }),
    pluginId: characterStatePluginId,
    characterFileStore: options.fileStore,
  };
}

function createLegacyPatchEvents(
  count: number,
): readonly RuntimePluginJsonObject[] {
  const events: RuntimePluginJsonObject[] = [];
  let current = createDefaultCharacterRuntimeState();

  for (let index = 0; index < count; index += 1) {
    const input = {
      mood: index % 2 === 0 ? 'curious' : 'steady',
    } as const;
    const result = acceptedPatchResult(current, input);

    events.push({
      type: 'character_state.patch',
      ...createRuntimeEventIdentity({
        eventId: `evt_character_state_legacy_${String(index)}`,
        traceId: `trace_character_state_legacy_${String(index)}`,
        createdAt: new Date(
          Date.parse('2026-06-15T00:00:00.000Z') + index * 1_000,
        ).toISOString(),
      }),
      input,
      result,
    });
    current = result.after;
  }

  return Object.freeze(events);
}

function createInstrumentedCharacterStateFileStore(
  initialEvents: readonly RuntimePluginJsonObject[],
): {
  readonly fileStore: RuntimePluginFileStore;
  readonly eventLogReadCount: () => number;
  readonly jsonPaths: () => readonly string[];
} {
  const jsonFiles = new Map<string, RuntimePluginJsonValue>();
  const events: RuntimePluginJsonValue[] = [...initialEvents];
  let eventLogReads = 0;
  let revision = events.length;

  return {
    fileStore: Object.freeze({
      readJson(path) {
        return jsonFiles.get(path);
      },
      readJsonl(path) {
        if (path !== 'events.jsonl') {
          return Object.freeze([]);
        }

        eventLogReads += 1;
        return Object.freeze([...events]);
      },
      writeJsonAtomic(path, value) {
        jsonFiles.set(path, value);
        revision += 1;
      },
      appendJsonl(path, value) {
        if (path !== 'events.jsonl') {
          throw new TypeError(`Unexpected JSONL path "${path}".`);
        }

        events.push(value);
        revision += 1;
      },
      revision() {
        return revision;
      },
    } satisfies RuntimePluginFileStore),
    eventLogReadCount: () => eventLogReads,
    jsonPaths: () => Object.freeze([...jsonFiles.keys()]),
  };
}

async function measureDurableCharacterStatePromptReads(options: {
  readonly pathCount: number;
  readonly sessionId: string;
}): Promise<number> {
  const storeRoot = createTestTempRoot('project02-character-state-scale-');
  const pluginRoot = createLocalRuntimePluginPaths({
    storeRoot,
    sessionId: options.sessionId,
    pluginId: characterStatePluginId,
  }).pluginRoot;
  const pathModes: Record<string, 'json'> = {
    'checkpoint.json': 'json',
  };

  for (let index = 0; index < options.pathCount; index += 1) {
    pathModes[`idempotency/${String(index).padStart(64, '0')}.json`] = 'json';
  }

  mkdirSync(pluginRoot, {recursive: true});
  writeFileSync(
    join(pluginRoot, 'checkpoint.json'),
    `${JSON.stringify({
      kind: 'character_state.checkpoint',
      version: 1,
      eventCount: 0,
      storeRevision: 1,
      current: createDefaultCharacterRuntimeState(),
    })}\n`,
    'utf8',
  );
  writeFileSync(
    join(pluginRoot, durablePathModesFileName),
    `${JSON.stringify(pathModes)}\n`,
    'utf8',
  );
  writeFileSync(join(pluginRoot, durableRevisionFileName), '1\n', 'utf8');

  const {plugin, context} = createCharacterStateHarness(
    options.sessionId,
    storeRoot,
  );

  await plugin.lifecycleHooks.beforeRoleModelCall?.(context);

  const startedAt = performance.now();

  for (let index = 0; index < 100; index += 1) {
    await plugin.lifecycleHooks.beforeRoleModelCall?.(context);
  }

  return performance.now() - startedAt;
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_character_state',
    traceId: 'trace_character_state',
    createdAt: '2026-06-15T00:00:00.000Z',
  });
}

function acceptedPatchResult(
  before: ReturnType<typeof createDefaultCharacterRuntimeState>,
  input: RuntimePluginJsonObject,
) {
  const result = planCharacterStatePatch({
    before,
    patchInput: input,
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
  },
) {
  fileStore.appendJsonl('events.jsonl', {
    type: 'character_state.patch',
    ...options.identity,
    input: options.input,
    result: options.result,
  });
}
