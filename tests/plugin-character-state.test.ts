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
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  createRuntimePluginContext
} from '../src/plugins/types.ts';
import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';

describe('Character State plugin', () => {
  it('applies valid patches and records plugin-local state', async () => {
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
    expect(fileStore.readJson('current.json')).toMatchObject({
      current: {
        mood: 'steady'
      }
    });
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

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_character_state',
    traceId: 'trace_character_state',
    createdAt: '2026-06-15T00:00:00.000Z'
  });
}
