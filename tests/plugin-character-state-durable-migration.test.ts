import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { characterStatePatchModelToolName } from '../src/plugins/packages/character-state/contract.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin
} from '../src/plugins/packages/character-state/plugin.ts';
import {
  createDefaultCharacterRuntimeState,
  planCharacterStatePatch
} from '../src/plugins/packages/character-state/schema.ts';
import {
  createRuntimePluginFileStoreTransaction
} from '../src/plugins/file-store.ts';
import {
  durablePathModesFileName,
  durableRevisionFileName
} from '../src/plugins/file-store/shared.ts';
import {
  createRuntimePluginContext,
  type RuntimePluginFileStore,
  type RuntimePluginJsonObject
} from '../src/plugins/types.ts';
import { createRuntimeEventIdentity } from '../src/runtime/event.ts';
import { createLocalRuntimePluginPaths } from '../src/runtime/storage/layout.ts';
import { createTestTempRoot } from './support/temp-root.ts';

describe('durable Character State migration', () => {
  it(
    'replays 1,000 legacy events once and performs zero event-log reads in the next 100 turns',
    async () => {
      const storeRoot = createTestTempRoot(
        'project02-character-state-durable-migration-'
      );
      const sessionId = 'session-character-state-durable-migration';
      const pluginRoot = createLocalRuntimePluginPaths({
        storeRoot,
        sessionId,
        pluginId: characterStatePluginId
      }).pluginRoot;
      const legacyEvents = createLegacyPatchEvents(1_000);

      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(
        join(pluginRoot, 'events.jsonl'),
        `${legacyEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8'
      );
      writeFileSync(
        join(pluginRoot, durablePathModesFileName),
        '{"events.jsonl":"jsonl"}\n',
        'utf8'
      );
      writeFileSync(
        join(pluginRoot, durableRevisionFileName),
        '1000\n',
        'utf8'
      );

      const counts = createFileStoreOperationCounts();
      const migrationIdentity = createRuntimeEventIdentity({
        eventId: 'evt_character_state_durable_migration',
        traceId: 'trace_character_state_durable_migration',
        createdAt: '2026-07-11T00:00:00.000Z'
      });
      const migrationTimings = await runCharacterStateTransaction({
        storeRoot,
        sessionId,
        identity: migrationIdentity,
        counts,
        action: 'prompt'
      });

      expect(counts.eventLogReads).toBe(1);
      expect(counts.jsonWrites).toBe(1_001);
      expect(
        Object.values(migrationTimings).every((value) =>
          Number.isFinite(value)
        )
      ).toBe(true);

      counts.eventLogReads = 0;
      counts.jsonWrites = 0;
      counts.jsonlAppends = 0;

      for (let index = 0; index < 100; index += 1) {
        await runCharacterStateTransaction({
          storeRoot,
          sessionId,
          identity: createRuntimeEventIdentity({
            eventId: `evt_character_state_durable_fast_${String(index)}`,
            traceId: `trace_character_state_durable_fast_${String(index)}`,
            createdAt: new Date(
              Date.parse('2026-07-11T00:01:00.000Z') + index * 1_000
            ).toISOString()
          }),
          counts,
          action: index % 2 === 0 ? 'prompt' : 'patch'
        });
      }

      expect(counts.eventLogReads).toBe(0);
      expect(counts.jsonWrites).toBe(100);
      expect(counts.jsonlAppends).toBe(50);
      expect(readdirSync(join(pluginRoot, 'idempotency'))).toHaveLength(1_050);
    },
    60_000
  );
});

type FileStoreOperationCounts = {
  eventLogReads: number;
  jsonWrites: number;
  jsonlAppends: number;
};

function createFileStoreOperationCounts(): FileStoreOperationCounts {
  return {
    eventLogReads: 0,
    jsonWrites: 0,
    jsonlAppends: 0
  };
}

async function runCharacterStateTransaction(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly identity: ReturnType<typeof createRuntimeEventIdentity>;
  readonly counts: FileStoreOperationCounts;
  readonly action: 'patch' | 'prompt';
}): Promise<{
  readonly hookMs: number;
  readonly prepareMs: number;
  readonly finalizeMs: number;
}> {
  const transaction = createRuntimePluginFileStoreTransaction();
  const fileStore = countFileStoreOperations(
    transaction.fileStoreFor({
      storeRoot: options.storeRoot,
      sessionId: options.sessionId,
      pluginId: characterStatePluginId
    }),
    options.counts
  );
  const context = {
    ...createRuntimePluginContext({
      ...options.identity,
      sessionId: options.sessionId,
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
  const plugin = createCharacterStatePlugin();
  const hookStartedAt = performance.now();

  if (options.action === 'prompt') {
    await plugin.lifecycleHooks.beforeRoleModelCall?.(context);
  } else {
    const result = await plugin.lifecycleHooks.handleToolCall?.(
      {
        ...options.identity,
        pluginId: characterStatePluginId,
        toolName: characterStatePatchModelToolName,
        input: {
          mood:
            Number(options.identity.eventId.match(/\d+$/u)?.[0] ?? 0) % 4 === 1
              ? 'curious'
              : 'steady'
        }
      },
      context
    );

    expect(result?.status).toBe('accepted');
  }

  const hookMs = performance.now() - hookStartedAt;
  const prepareStartedAt = performance.now();
  const prepared = transaction.prepare(options.identity);
  const prepareMs = performance.now() - prepareStartedAt;
  const finalizeStartedAt = performance.now();

  prepared.finalize();
  return Object.freeze({
    hookMs,
    prepareMs,
    finalizeMs: performance.now() - finalizeStartedAt
  });
}

function countFileStoreOperations(
  fileStore: RuntimePluginFileStore,
  counts: FileStoreOperationCounts
): RuntimePluginFileStore {
  return Object.freeze({
    readJson(path) {
      return fileStore.readJson(path);
    },
    readJsonl(path) {
      if (path === 'events.jsonl') {
        counts.eventLogReads += 1;
      }

      return fileStore.readJsonl(path);
    },
    writeJsonAtomic(path, value) {
      counts.jsonWrites += 1;
      fileStore.writeJsonAtomic(path, value);
    },
    appendJsonl(path, value) {
      counts.jsonlAppends += 1;
      fileStore.appendJsonl(path, value);
    },
    revision() {
      return fileStore.revision();
    }
  } satisfies RuntimePluginFileStore);
}

function createLegacyPatchEvents(
  count: number
): readonly RuntimePluginJsonObject[] {
  const events: RuntimePluginJsonObject[] = [];
  let current = createDefaultCharacterRuntimeState();

  for (let index = 0; index < count; index += 1) {
    const input = {
      mood: index % 2 === 0 ? 'curious' : 'steady'
    } as const;
    const result = planCharacterStatePatch({ before: current, patchInput: input });

    if (result.status !== 'accepted') {
      throw new Error('Expected valid Character State migration fixture.');
    }

    events.push({
      type: 'character_state.patch',
      ...createRuntimeEventIdentity({
        eventId: `evt_character_state_durable_legacy_${String(index)}`,
        traceId: `trace_character_state_durable_legacy_${String(index)}`,
        createdAt: new Date(
          Date.parse('2026-07-10T00:00:00.000Z') + index * 1_000
        ).toISOString()
      }),
      input,
      result
    });
    current = result.after;
  }

  return Object.freeze(events);
}
