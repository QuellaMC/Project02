import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  characterMemoryPluginId,
  characterMemoryUpdateToolName,
} from '../../src/plugins/api/contract.ts';
import {
  createCharacterMemoryPlugin,
  createCharacterMemoryPluginManifest,
} from '../../src/plugins/packages/character-memory/plugin.ts';
import {createProject02Plugin} from '../../src/plugins/packages/character-memory/index.ts';
import {characterMemoryStorePath} from '../../src/plugins/packages/character-memory/store.ts';
import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {createRuntimePluginContext} from '../../src/plugins/api/index.ts';
import type {
  RuntimePlugin,
  RuntimePluginFileStore,
  RuntimePluginJsonObject,
} from '../../src/plugins/api/index.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';

describe('Character Memory plugin', () => {
  it('exposes the descriptor-backed package factory with the memory.update tool', () => {
    const manifest = createCharacterMemoryPluginManifest();
    const plugin = createProject02Plugin({
      pluginId: characterMemoryPluginId,
      manifest,
      storeRoot: '.project02/character-data/mira',
      resolvedConfig: Object.freeze({}),
      redactedConfig: Object.freeze({}),
    });

    expect(plugin.manifest).toEqual(manifest);
    expect(plugin.manifest.activation.defaultEnabled).toBe(true);
    expect(plugin.manifest.requestedAccess).toEqual({
      character_file_store: 'write',
      model_input: 'write',
      curated_context: 'write',
    });
    expect(plugin.providedTools.map(tool => tool.name)).toEqual([
      characterMemoryUpdateToolName,
    ]);
  });

  it('commits an atomic update batch and reports usage', async () => {
    const {plugin, context, fileStore} = createCharacterMemoryHarness(
      'session-character-memory-commit',
    );

    const result = await callMemoryUpdate(plugin, context, {
      operations: [
        {action: 'add', target: 'notes', text: 'Prefers tea over coffee.'},
        {action: 'add', target: 'user_profile', text: 'Reads TypeScript.'},
      ],
    });

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        status: 'accepted',
        appliedChanges: [
          {action: 'add', target: 'notes', status: 'applied'},
          {action: 'add', target: 'user_profile', status: 'applied'},
        ],
        usage: {
          notes: {usedChars: 24, capChars: 2200, entryCount: 1},
          user_profile: {usedChars: 17, capChars: 1375, entryCount: 1},
        },
        visibleNextSession: true,
      },
    });
    expect(fileStore.readJson(characterMemoryStorePath)).toMatchObject({
      kind: 'character_memory.store',
      formatVersion: 1,
      notes: ['Prefers tea over coffee.'],
      userProfile: ['Reads TypeScript.'],
    });
  });

  it('rejects a failing batch without touching the stored document', async () => {
    const {plugin, context, fileStore} = createCharacterMemoryHarness(
      'session-character-memory-reject',
    );

    await callMemoryUpdate(plugin, context, {
      operations: [
        {action: 'add', target: 'notes', text: 'Prefers tea over coffee.'},
      ],
    });
    const before = fileStore.readJson(characterMemoryStorePath);
    const result = await callMemoryUpdate(
      plugin,
      context,
      {
        operations: [
          {action: 'add', target: 'notes', text: 'Another durable note.'},
          {action: 'remove', target: 'notes', old_text: 'not stored anywhere'},
        ],
      },
      {eventId: 'evt_memory_reject'},
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'memory_old_text_not_found',
    });
    expect(fileStore.readJson(characterMemoryStorePath)).toEqual(before);
  });

  it('replays a duplicate identity idempotently and rejects a mutated retry', async () => {
    const {plugin, context, fileStore} = createCharacterMemoryHarness(
      'session-character-memory-idempotent',
    );
    const input = {
      operations: [
        {action: 'add', target: 'notes', text: 'Prefers tea over coffee.'},
      ],
    };

    const first = await callMemoryUpdate(plugin, context, input);
    const replay = await callMemoryUpdate(plugin, context, input);
    const mutated = await callMemoryUpdate(plugin, context, {
      operations: [
        {action: 'add', target: 'notes', text: 'A different entry.'},
      ],
    });

    expect(first).toMatchObject({status: 'accepted'});
    expect(replay).toMatchObject({
      status: 'accepted',
      output: {idempotent: true},
    });
    expect(mutated).toMatchObject({
      status: 'rejected',
      reason: 'memory_idempotency_conflict',
    });
    expect(fileStore.readJson(characterMemoryStorePath)).toMatchObject({
      notes: ['Prefers tea over coffee.'],
    });
  });

  it('replays a retry that another session committed past', async () => {
    const {plugin, context, fileStore} = createCharacterMemoryHarness(
      'session-character-memory-interleaved',
    );
    const removal = {
      operations: [{action: 'remove', target: 'notes', old_text: 'tea'}],
    };

    await callMemoryUpdate(plugin, context, {
      operations: [
        {action: 'add', target: 'notes', text: 'Prefers tea over coffee.'},
      ],
    });
    await callMemoryUpdate(plugin, context, removal, {eventId: 'evt_remove'});
    // A second window adds the entry back before the first window retries.
    await callMemoryUpdate(
      plugin,
      context,
      {
        operations: [
          {action: 'add', target: 'notes', text: 'Prefers tea over coffee.'},
        ],
      },
      {eventId: 'evt_other_session'},
    );

    const retry = await callMemoryUpdate(plugin, context, removal, {
      eventId: 'evt_remove',
    });

    expect(retry).toMatchObject({
      status: 'accepted',
      output: {idempotent: true},
    });
    // The retry replays its recorded result; it must not delete what the
    // other session committed in between.
    expect(fileStore.readJson(characterMemoryStorePath)).toMatchObject({
      notes: ['Prefers tea over coffee.'],
    });
  });

  it('freezes the curated snapshot per plugin instance until the next launch', async () => {
    const {plugin, context, fileStore} = createCharacterMemoryHarness(
      'session-character-memory-snapshot',
    );

    await callMemoryUpdate(plugin, context, {
      operations: [
        {action: 'add', target: 'notes', text: 'Prefers tea over coffee.'},
      ],
    });

    const firstLook =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(context);

    await callMemoryUpdate(
      plugin,
      context,
      {
        operations: [
          {action: 'add', target: 'user_profile', text: 'Reads TypeScript.'},
        ],
      },
      {eventId: 'evt_memory_second_write'},
    );

    const secondLook =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(context);
    const relaunched = createCharacterMemoryHarness(
      'session-character-memory-snapshot',
      fileStore,
    );
    const nextLaunchLook =
      await relaunched.plugin.lifecycleHooks.beforeRoleModelCall?.(
        relaunched.context,
      );

    expect(firstLook?.curatedContext).toEqual([
      expect.objectContaining({
        pluginId: characterMemoryPluginId,
        id: 'notes',
        title: 'Character notes',
        text: 'Prefers tea over coffee.',
        capChars: 2200,
        usedChars: 24,
      }),
    ]);
    // The launch snapshot is deliberately stale: the mid-session write does
    // not reach the prompt until the next launch.
    expect(secondLook?.curatedContext).toEqual(firstLook?.curatedContext);
    expect(nextLaunchLook?.curatedContext).toEqual([
      expect.objectContaining({id: 'notes'}),
      expect.objectContaining({
        id: 'user-profile',
        title: 'User profile',
        text: 'Reads TypeScript.',
        capChars: 1375,
      }),
    ]);
  });

  it('provides no sections for an empty store and says so in evidence', async () => {
    const {plugin, context} = createCharacterMemoryHarness(
      'session-character-memory-empty',
    );

    const result = await plugin.lifecycleHooks.beforeRoleModelCall?.(context);

    expect(result?.curatedContext).toEqual([]);
    expect(result?.contextItems).toEqual([]);
    expect(result?.evidence).toEqual([
      expect.objectContaining({
        pluginId: characterMemoryPluginId,
        status: 'accepted',
        summary: 'Curated memory is empty.',
      }),
    ]);
  });
});

async function callMemoryUpdate(
  plugin: RuntimePlugin,
  context: ReturnType<typeof createCharacterMemoryContext>,
  input: RuntimePluginJsonObject,
  identity: {readonly eventId?: string} = {},
) {
  return await plugin.lifecycleHooks.handleToolCall?.(
    {
      ...testIdentity(identity),
      pluginId: characterMemoryPluginId,
      toolName: characterMemoryUpdateToolName,
      toolCallId: `${identity.eventId ?? 'evt_character_memory'}-call`,
      input,
    },
    context,
  );
}

function createCharacterMemoryHarness(
  sessionId: string,
  injectedFileStore?: RuntimePluginFileStore,
) {
  const fileStore =
    injectedFileStore ??
    createRuntimePluginFileStore({
      sessionId,
      sessionIdentity: {},
      pluginId: characterMemoryPluginId,
      scope: 'character',
    });

  return {
    plugin: createCharacterMemoryPlugin(),
    context: createCharacterMemoryContext({sessionId, fileStore}),
    fileStore,
  };
}

function createCharacterMemoryContext(options: {
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
    pluginId: characterMemoryPluginId,
    characterFileStore: options.fileStore,
  };
}

function testIdentity(overrides: {readonly eventId?: string} = {}) {
  return createRuntimeEventIdentity({
    eventId: overrides.eventId ?? 'evt_character_memory',
    traceId: 'trace_character_memory',
    createdAt: '2026-08-10T00:00:00.000Z',
  });
}
