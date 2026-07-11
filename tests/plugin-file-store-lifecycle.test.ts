import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createRuntimePluginFileStoreTransaction
} from '../src/plugins/file-store.ts';
import { durablePathModesFileName } from '../src/plugins/file-store/shared.ts';
import type { RuntimePluginFileStore } from '../src/plugins/types.ts';
import { createLocalRuntimePluginPaths } from '../src/runtime/storage/layout.ts';
import { createTestTempRoot } from './support/temp-root.ts';

describe('runtime plugin file store transaction lifecycle', () => {
  it('fails every staged file-store method closed after prepare and finalize', () => {
    const transaction = createRuntimePluginFileStoreTransaction();
    const fileStore = transaction.fileStoreFor({
      sessionId: 'session-closed-after-prepare',
      sessionIdentity: {},
      pluginId: 'plugin.closed-after-prepare'
    });

    fileStore.appendJsonl('events.jsonl', { value: 1 });
    const prepared = transaction.prepare(testIdentity());

    expectFileStoreClosed(fileStore);
    prepared.finalize();
    expectFileStoreClosed(fileStore);
  });

  it('fails every staged file-store method closed after rollback', () => {
    const transaction = createRuntimePluginFileStoreTransaction();
    const fileStore = transaction.fileStoreFor({
      sessionId: 'session-closed-after-rollback',
      sessionIdentity: {},
      pluginId: 'plugin.closed-after-rollback'
    });

    fileStore.appendJsonl('events.jsonl', { value: 1 });
    transaction.rollback();

    expectFileStoreClosed(fileStore);
  });

  it('performs zero history cleanup operations during cold durable overlay construction', () => {
    const storeRoot = createTestTempRoot('project02-plugin-cold-overlay-');
    const sessionId = 'session-cold-overlay';
    const pluginId = 'plugin.cold-overlay';
    const pluginRoot = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId
    }).pluginRoot;
    const pathModes = Object.fromEntries(
      Array.from({ length: 8_000 }, (_, index) => [
        `idempotency/${String(index).padStart(8, '0')}.json`,
        'json'
      ])
    );

    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      join(pluginRoot, durablePathModesFileName),
      `${JSON.stringify(pathModes)}\n`,
      'utf8'
    );
    const deadTempPath = join(
      pluginRoot,
      '.state.json.99999999.00000000-0000-4000-8000-000000000000.tmp'
    );
    writeFileSync(deadTempPath, '{"incomplete":true}\n', 'utf8');

    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor({ storeRoot, sessionId, pluginId });

    expect(existsSync(deadTempPath)).toBe(true);
  });
});

function expectFileStoreClosed(fileStore: RuntimePluginFileStore): void {
  const operations = [
    () => fileStore.readJson('state.json'),
    () => fileStore.readJsonl('events.jsonl'),
    () => {
      fileStore.writeJsonAtomic('state.json', { value: 2 });
    },
    () => {
      fileStore.appendJsonl('events.jsonl', { value: 2 });
    },
    () => fileStore.revision()
  ];

  for (const operation of operations) {
    expect(operation).toThrow(/transaction is already closed/iu);
  }
}

function testIdentity() {
  return {
    eventId: 'evt_closed_transaction',
    traceId: 'trace_closed_transaction',
    createdAt: '2026-07-11T00:00:00.000Z'
  };
}
