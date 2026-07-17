import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimePluginFileStore,
  createRuntimePluginFileStoreTransaction
} from '../src/runtime/storage/plugin-file-store/index.ts';
import { createDurableRuntimePluginFileStore } from '../src/runtime/storage/plugin-file-store/durable-store.ts';
import {
  createLocalRuntimePluginPaths,
  createLocalRuntimeSessionPaths,
  LocalRuntimeStorageContractError
} from '../src/runtime/storage/layout-contract.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';
import type {
  RuntimePluginJsonObject
} from '../src/plugins/api/index.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime plugin file store', () => {
  it('rejects unsafe durable session and plugin ID path components', () => {
    const storeRoot = createTempRoot();

    expect(() =>
      createRuntimePluginFileStore({
        storeRoot,
        sessionId: '../outside-session',
        pluginId: 'plugin.safe'
      })
    ).toThrow(/session ID/iu);

    expect(() =>
      createRuntimePluginFileStore({
        storeRoot,
        sessionId: 'session-safe',
        pluginId: '../outside-plugin'
      })
    ).toThrow(/plugin ID/iu);

    let pluginIdError: unknown;

    try {
      createRuntimePluginFileStore({
        storeRoot,
        sessionId: 'session-safe',
        pluginId: '../outside-plugin'
      });
    } catch (error: unknown) {
      pluginIdError = error;
    }

    expect(pluginIdError).toBeInstanceOf(LocalRuntimeStorageContractError);
    expect(pluginIdError).toMatchObject({
      code: 'invalid_plugin_id'
    });
  });

  it('seeds and persists durable revisions from existing plugin files', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-durable-revision';
    const pluginId = 'plugin.durable';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'current.json'), '{"value":"existing"}\n', 'utf8');
    writeFileSync(
      join(root, 'events.jsonl'),
      '{"value":1}\n{"value":2}\n',
      'utf8'
    );

    const first = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    expect(first.revision()).toBe(3);

    first.writeJsonAtomic('current.json', { value: 'updated' });

    expect(first.revision()).toBe(4);

    const second = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    expect(second.revision()).toBe(4);

    second.appendJsonl('events.jsonl', { value: 3 });

    expect(second.revision()).toBe(5);
  });

  it('cleans dead atomic temp files and never counts live temps as plugin state', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-durable-orphan-temps';
    const pluginId = 'plugin.durable-orphan-temps';
    const root = pluginRoot(storeRoot, sessionId, pluginId);
    const deadPid = 99_999_999;
    const uuid = '00000000-0000-4000-8000-000000000000';
    const deadTempPaths = [
      join(root, `.state.json.${String(deadPid)}.${uuid}.tmp`),
      join(
        root,
        `..project02-plugin-store-modes.json.${String(deadPid)}.${uuid}.tmp`
      ),
      join(
        root,
        `..project02-plugin-store-revision.${String(deadPid)}.${uuid}.tmp`
      )
    ];
    const liveTempPath = join(
      root,
      `.live.json.${String(process.pid)}.${uuid}.tmp`
    );
    const legitimateUserPath = join(
      root,
      `notes.${String(deadPid)}.${uuid}.tmp`
    );

    mkdirSync(root, { recursive: true });

    for (const path of [...deadTempPaths, liveTempPath]) {
      writeFileSync(path, '{"temporary":true}\n', 'utf8');
    }
    writeFileSync(legitimateUserPath, '{"userData":true}\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    expect(store.revision()).toBe(1);

    for (const path of deadTempPaths) {
      expect(() => readFileSync(path, 'utf8')).toThrow();
    }

    expect(readFileSync(liveTempPath, 'utf8')).toBe('{"temporary":true}\n');
    expect(store.readJson(`notes.${String(deadPid)}.${uuid}.tmp`)).toEqual({
      userData: true
    });
  });

  it('recovers a direct append when metadata persistence fails after content', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-direct-mutation-recovery';
    const pluginId = 'plugin.direct-mutation-recovery';
    const options = { storeRoot, sessionId, pluginId };
    const base = createRuntimePluginFileStore(options);

    base.appendJsonl('events.jsonl', { value: 1 });

    const injected = createDurableRuntimePluginFileStore(options, {
      faultInjector(point) {
        expect(point).toBe('after_content_persisted');
        throw new Error('injected path-mode persistence failure');
      }
    });

    expect(() => {
      injected.appendJsonl('events.jsonl', { value: 2 });
    }).toThrow(/injected path-mode persistence failure/iu);

    const root = pluginRoot(storeRoot, sessionId, pluginId);

    expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).toBe(
      '{"value":1}\n{"value":2}\n'
    );
    expect(
      readFileSync(join(root, '.project02-plugin-store-revision'), 'utf8')
    ).toBe('1\n');

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([
      { value: 1 },
      { value: 2 }
    ]);
    expect(recovered.revision()).toBe(2);
    expect(() =>
      readFileSync(
        join(root, '.project02-plugin-store-direct-mutation.json'),
        'utf8'
      )
    ).toThrow();
  });

  it('reserves metadata and atomic-temp names in every plugin path segment', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-reserved-plugin-paths';
    const pluginId = 'plugin.reserved-paths';
    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });
    const uuid = '00000000-0000-4000-8000-000000000000';
    const reservedPaths = [
      '.project02-plugin-store-revision/child.json',
      'nested/.project02-plugin-store-modes.json/child.json',
      '.project02-plugin-store-direct-mutation.json/child.json',
      `.state.json.99999999.${uuid}.tmp`
    ];

    for (const path of reservedPaths) {
      expect(() => {
        store.writeJsonAtomic(path, { unsafe: true });
      }).toThrow(/safe relative path/iu);
    }

    expect(store.revision()).toBe(0);
  });

  it('isolates in-memory stores by session object when supplied', () => {
    const firstSession = Object.freeze({ id: 'local-session' });
    const secondSession = Object.freeze({ id: 'local-session' });
    const first = createRuntimePluginFileStore({
      sessionId: 'local-session',
      sessionIdentity: firstSession,
      pluginId: 'plugin.memory'
    });
    const second = createRuntimePluginFileStore({
      sessionId: 'local-session',
      sessionIdentity: secondSession,
      pluginId: 'plugin.memory'
    });

    first.writeJsonAtomic('state.json', { value: 'first' });

    expect(second.readJson('state.json')).toBeUndefined();
    expect(second.revision()).toBe(0);

    const firstAgain = createRuntimePluginFileStore({
      sessionId: 'local-session',
      sessionIdentity: firstSession,
      pluginId: 'plugin.memory'
    });

    expect(firstAgain.readJson('state.json')).toEqual({ value: 'first' });
    expect(firstAgain.revision()).toBe(1);
  });

  it('rejects in-memory stores without an owning session identity', () => {
    const unsafeOptions: unknown = {
      sessionId: 'session-without-owner',
      pluginId: 'plugin.memory-without-owner'
    };

    expect(() => {
      Reflect.apply(createRuntimePluginFileStore, undefined, [unsafeOptions]);
    }).toThrow(/sessionIdentity/iu);
  });

  it('rejects mixing distinct in-memory session identities in one transaction', () => {
    const firstSessionIdentity = {};
    const secondSessionIdentity = {};
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction
      .fileStoreFor({
        sessionId: 'shared-session-id',
        sessionIdentity: firstSessionIdentity,
        pluginId: 'plugin.shared'
      })
      .writeJsonAtomic('state.json', { value: 'first' });

    expect(() =>
      transaction.fileStoreFor({
        sessionId: 'shared-session-id',
        sessionIdentity: secondSessionIdentity,
        pluginId: 'plugin.shared'
      })
    ).toThrow(/distinct in-memory session identities/iu);

    transaction.rollback();
    expect(
      createRuntimePluginFileStore({
        sessionId: 'shared-session-id',
        sessionIdentity: firstSessionIdentity,
        pluginId: 'plugin.shared'
      }).readJson('state.json')
    ).toBeUndefined();
    expect(
      createRuntimePluginFileStore({
        sessionId: 'shared-session-id',
        sessionIdentity: secondSessionIdentity,
        pluginId: 'plugin.shared'
      }).readJson('state.json')
    ).toBeUndefined();
  });

  it('preserves own __proto__ keys in plugin file values', () => {
    const memory = createRuntimePluginFileStore({
      sessionId: 'session-proto-key',
      sessionIdentity: {},
      pluginId: 'plugin.proto'
    });
    const durable = createRuntimePluginFileStore({
      storeRoot: createTempRoot(),
      sessionId: 'session-proto-key',
      pluginId: 'plugin.proto'
    });

    memory.writeJsonAtomic('state.json', createProtoKeyValue());
    memory.appendJsonl('events.jsonl', createProtoKeyValue());
    durable.writeJsonAtomic('state.json', createProtoKeyValue());
    durable.appendJsonl('events.jsonl', createProtoKeyValue());

    expectProtoKeyValue(memory.readJson('state.json'));
    expectProtoKeyValue(memory.readJsonl('events.jsonl')[0]);
    expectProtoKeyValue(durable.readJson('state.json'));
    expectProtoKeyValue(durable.readJsonl('events.jsonl')[0]);
  });

  it('rejects non-finite plugin file values before writing', () => {
    const memory = createRuntimePluginFileStore({
      sessionId: 'session-finite-json',
      sessionIdentity: {},
      pluginId: 'plugin.finite'
    });
    const nonFiniteMemoryValue: RuntimePluginJsonObject = {
      score: Number.POSITIVE_INFINITY
    };

    expect(() => {
      memory.writeJsonAtomic('value.json', nonFiniteMemoryValue);
    }).toThrow(/finite JSON/iu);
    expect(memory.readJson('value.json')).toBeUndefined();
    expect(memory.revision()).toBe(0);

    const durable = createRuntimePluginFileStore({
      storeRoot: createTempRoot(),
      sessionId: 'session-finite-json',
      pluginId: 'plugin.finite'
    });
    const nonFiniteDurableValue: RuntimePluginJsonObject = {
      score: Number.NaN
    };

    expect(() => {
      durable.appendJsonl('events.jsonl', nonFiniteDurableValue);
    }).toThrow(/finite JSON/iu);
    expect(durable.readJsonl('events.jsonl')).toEqual([]);
    expect(durable.revision()).toBe(0);
  });

  it('applies the shared JSON boundary limits to plugin file values', () => {
    const store = createRuntimePluginFileStore({
      sessionId: 'session-json-boundary',
      sessionIdentity: {},
      pluginId: 'plugin.json-boundary'
    });
    const cyclic: RuntimePluginJsonObject = {};
    Object.defineProperty(cyclic, 'self', {
      value: cyclic,
      enumerable: true
    });
    let deep: RuntimePluginJsonObject = {};

    for (let depth = 0; depth < 20; depth += 1) {
      deep = { value: deep };
    }

    expect(() => {
      store.writeJsonAtomic('cycle.json', cyclic);
    }).toThrow(/cycle/iu);
    expect(() => {
      store.writeJsonAtomic('deep.json', deep);
    }).toThrow(/depth/iu);
    expect(store.revision()).toBe(0);
  });

  it.each([
    ['a missing terminal newline', '{"value":1}'],
    ['an interior blank record', '{"value":1}\n\n{"value":2}\n']
  ])('rejects durable JSONL containing %s', (_description, content) => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-jsonl-framing';
    const pluginId = 'plugin.jsonl-framing';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'events.jsonl'), content, 'utf8');
    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    expect(() => store.readJsonl('events.jsonl')).toThrow(/JSONL/iu);
  });

  it('rejects JSONL reads and appends on paths that already store JSON', () => {
    const stores = [
      createRuntimePluginFileStore({
        sessionId: 'session-mixed-json-jsonl-memory',
        sessionIdentity: {},
        pluginId: 'plugin.mixed-mode'
      }),
      createRuntimePluginFileStore({
        storeRoot: createTempRoot(),
        sessionId: 'session-mixed-json-jsonl-durable',
        pluginId: 'plugin.mixed-mode'
      })
    ];

    for (const store of stores) {
      store.writeJsonAtomic('mixed.json', { value: 'json' });

      expect(() => {
        store.readJsonl('mixed.json');
      }).toThrow(/non-array JSON/iu);
      expect(() => {
        store.appendJsonl('mixed.json', { value: 'jsonl' });
      }).toThrow(/non-array JSON/iu);
      expect(store.readJson('mixed.json')).toEqual({ value: 'json' });
      expect(store.revision()).toBe(1);
    }

    const storeRoot = createTempRoot();
    const firstDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-json-jsonl-reopened',
      pluginId: 'plugin.mixed-mode-reopened'
    });

    firstDurable.writeJsonAtomic('mixed.json', { value: 'json' });

    const secondDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-json-jsonl-reopened',
      pluginId: 'plugin.mixed-mode-reopened'
    });

    expect(() => {
      secondDurable.readJsonl('mixed.json');
    }).toThrow(/non-array JSON/iu);
    expect(() => {
      secondDurable.appendJsonl('mixed.json', { value: 'jsonl' });
    }).toThrow(/non-array JSON/iu);
    expect(secondDurable.readJson('mixed.json')).toEqual({ value: 'json' });
    expect(secondDurable.revision()).toBe(1);

    const legacyStoreRoot = createTempRoot();
    const legacyRoot = pluginRoot(
      legacyStoreRoot,
      'session-mixed-json-jsonl-legacy',
      'plugin.mixed-mode-legacy'
    );
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(
      join(legacyRoot, 'mixed.json'),
      '{"value":"legacy-json"}\n',
      'utf8'
    );

    const legacyDurable = createRuntimePluginFileStore({
      storeRoot: legacyStoreRoot,
      sessionId: 'session-mixed-json-jsonl-legacy',
      pluginId: 'plugin.mixed-mode-legacy'
    });

    expect(() => {
      legacyDurable.readJsonl('mixed.json');
    }).toThrow(/already stores JSON/iu);
    expect(() => {
      legacyDurable.appendJsonl('mixed.json', { value: 'jsonl' });
    }).toThrow(/already stores JSON/iu);
    expect(legacyDurable.readJson('mixed.json')).toEqual({
      value: 'legacy-json'
    });
    expect(legacyDurable.revision()).toBe(1);
  });

  it('rejects JSONL reads and appends on untracked durable paths that store JSON arrays', () => {
    const storeRoot = createTempRoot();
    const root = pluginRoot(
      storeRoot,
      'session-mixed-json-array-jsonl-legacy',
      'plugin.mixed-mode-array-legacy'
    );
    const mixedJsonPath = join(root, 'mixed.json');
    const mixedJsonContent = '[{"value":"legacy-array-json"}]\n';
    mkdirSync(root, { recursive: true });
    writeFileSync(mixedJsonPath, mixedJsonContent, 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-json-array-jsonl-legacy',
      pluginId: 'plugin.mixed-mode-array-legacy'
    });

    expect(() => {
      store.readJsonl('mixed.json');
    }).toThrow(/already stores JSON/iu);
    expect(() => {
      store.appendJsonl('mixed.json', { value: 'jsonl' });
    }).toThrow(/already stores JSON/iu);
    expect(readFileSync(mixedJsonPath, 'utf8')).toBe(mixedJsonContent);
    expect(store.readJson('mixed.json')).toEqual([
      { value: 'legacy-array-json' }
    ]);
    expect(store.revision()).toBe(1);
  });

  it('preserves untracked .jsonl paths that contain one JSONL record', () => {
    const storeRoot = createTempRoot();
    const root = pluginRoot(
      storeRoot,
      'session-one-record-jsonl-legacy',
      'plugin.one-record-jsonl-legacy'
    );
    const eventsPath = join(root, 'events.jsonl');
    mkdirSync(root, { recursive: true });
    writeFileSync(eventsPath, '{"value":"legacy-jsonl"}\n', 'utf8');

    const firstStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-one-record-jsonl-legacy',
      pluginId: 'plugin.one-record-jsonl-legacy'
    });

    expect(firstStore.readJsonl('events.jsonl')).toEqual([
      { value: 'legacy-jsonl' }
    ]);
    expect(() => {
      firstStore.readJson('events.jsonl');
    }).toThrow(/stores JSONL/iu);

    firstStore.appendJsonl('events.jsonl', { value: 'new-jsonl' });

    expect(readFileSync(eventsPath, 'utf8')).toBe(
      '{"value":"legacy-jsonl"}\n{"value":"new-jsonl"}\n'
    );
    expect(firstStore.revision()).toBe(2);

    const secondStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-one-record-jsonl-legacy',
      pluginId: 'plugin.one-record-jsonl-legacy'
    });

    expect(secondStore.readJsonl('events.jsonl')).toEqual([
      { value: 'legacy-jsonl' },
      { value: 'new-jsonl' }
    ]);
    expect(secondStore.revision()).toBe(2);
  });

  it('rejects JSONL reads and appends on untracked .jsonl paths that store single JSON documents', () => {
    const cases = [
      {
        name: 'array',
        content: '[{"value":"legacy-array-json"}]\n'
      },
      {
        name: 'object',
        content: '{\n"value":"legacy-object-json"\n}\n'
      }
    ];

    for (const { name, content } of cases) {
      const storeRoot = createTempRoot();
      const root = pluginRoot(
        storeRoot,
        `session-mixed-jsonl-${name}-legacy`,
        'plugin.mixed-mode-jsonl-legacy'
      );
      const eventsPath = join(root, 'events.jsonl');
      mkdirSync(root, { recursive: true });
      writeFileSync(eventsPath, content, 'utf8');

      const store = createRuntimePluginFileStore({
        storeRoot,
        sessionId: `session-mixed-jsonl-${name}-legacy`,
        pluginId: 'plugin.mixed-mode-jsonl-legacy'
      });

      expect(() => {
        store.readJsonl('events.jsonl');
      }).toThrow(/already stores JSON/iu);
      expect(() => {
        store.appendJsonl('events.jsonl', { value: 'jsonl' });
      }).toThrow(/already stores JSON/iu);
      expect(readFileSync(eventsPath, 'utf8')).toBe(content);
      expect(store.revision()).toBe(
        content.split('\n').filter((line) => line.trim().length > 0).length
      );
    }
  });

  it('rejects JSON reads and writes on paths that already store JSONL', () => {
    const stores = [
      createRuntimePluginFileStore({
        sessionId: 'session-mixed-jsonl-json-memory',
        sessionIdentity: {},
        pluginId: 'plugin.mixed-mode'
      }),
      createRuntimePluginFileStore({
        storeRoot: createTempRoot(),
        sessionId: 'session-mixed-jsonl-json-durable',
        pluginId: 'plugin.mixed-mode'
      })
    ];

    for (const store of stores) {
      store.appendJsonl('events.jsonl', { value: 'jsonl' });

      expect(() => {
        store.readJson('events.jsonl');
      }).toThrow(/stores JSONL/iu);
      expect(() => {
        store.writeJsonAtomic('events.jsonl', { value: 'json' });
      }).toThrow(/stores JSONL/iu);
      expect(store.readJsonl('events.jsonl')).toEqual([
        { value: 'jsonl' }
      ]);
      expect(store.revision()).toBe(1);
    }

    const storeRoot = createTempRoot();
    const firstDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-jsonl-json-reopened',
      pluginId: 'plugin.mixed-mode-reopened'
    });

    firstDurable.appendJsonl('events.jsonl', { value: 'jsonl' });

    const secondDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-jsonl-json-reopened',
      pluginId: 'plugin.mixed-mode-reopened'
    });

    expect(() => {
      secondDurable.readJson('events.jsonl');
    }).toThrow(/stores JSONL/iu);
    expect(() => {
      secondDurable.writeJsonAtomic('events.jsonl', { value: 'json' });
    }).toThrow(/stores JSONL/iu);
    expect(secondDurable.readJsonl('events.jsonl')).toEqual([
      { value: 'jsonl' }
    ]);
    expect(secondDurable.revision()).toBe(1);

    const legacyStoreRoot = createTempRoot();
    const legacyRoot = pluginRoot(
      legacyStoreRoot,
      'session-mixed-jsonl-json-legacy',
      'plugin.mixed-mode-legacy'
    );
    const legacyEventsPath = join(legacyRoot, 'events.jsonl');
    const legacyEventsContent =
      '{"value":"legacy-jsonl-1"}\n{"value":"legacy-jsonl-2"}\n';
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(legacyEventsPath, legacyEventsContent, 'utf8');

    const legacyDurable = createRuntimePluginFileStore({
      storeRoot: legacyStoreRoot,
      sessionId: 'session-mixed-jsonl-json-legacy',
      pluginId: 'plugin.mixed-mode-legacy'
    });

    expect(() => {
      legacyDurable.readJson('events.jsonl');
    }).toThrow(/stores JSONL/iu);
    expect(() => {
      legacyDurable.writeJsonAtomic('events.jsonl', { value: 'json' });
    }).toThrow(/stores JSONL/iu);
    expect(readFileSync(legacyEventsPath, 'utf8')).toBe(legacyEventsContent);
    expect(legacyDurable.readJsonl('events.jsonl')).toEqual([
      { value: 'legacy-jsonl-1' },
      { value: 'legacy-jsonl-2' }
    ]);
    expect(legacyDurable.revision()).toBe(2);
  });

  it('keeps durable JSONL paths appendable across store instances', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-durable-jsonl-mode';
    const pluginId = 'plugin.durable-jsonl-mode';
    const first = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });
    const second = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    first.appendJsonl('events.jsonl', { value: 1 });

    expect(first.readJsonl('events.jsonl')).toEqual([{ value: 1 }]);
    expect(second.readJsonl('events.jsonl')).toEqual([{ value: 1 }]);

    second.appendJsonl('events.jsonl', { value: 2 });

    expect(second.readJsonl('events.jsonl')).toEqual([
      { value: 1 },
      { value: 2 }
    ]);
  });

  it('keeps ordered durable operations prepared until finalization', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-ordered-transaction-finalize';
    const pluginId = 'plugin.ordered-transaction-finalize';
    const base = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    base.writeJsonAtomic('state.json', { value: 'before' });
    base.appendJsonl('events.jsonl', { step: 0 });

    const transaction = createRuntimePluginFileStoreTransaction();
    const store = transaction.fileStoreFor({
      storeRoot,
      sessionId,
      pluginId
    });

    store.appendJsonl('events.jsonl', { step: 1 });
    store.writeJsonAtomic('state.json', { value: 'after-1' });
    store.appendJsonl('events.jsonl', { step: 2 });
    store.writeJsonAtomic('state.json', { value: 'after-2' });

    const prepared = await transaction.prepare(testTransactionIdentity());

    const beforeFinalize = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    expect(beforeFinalize.readJson('state.json')).toEqual({ value: 'before' });
    expect(beforeFinalize.readJsonl('events.jsonl')).toEqual([{ step: 0 }]);
    expect(beforeFinalize.revision()).toBe(2);

    await prepared.finalize();

    expect(beforeFinalize.readJson('state.json')).toEqual({ value: 'after-2' });
    expect(beforeFinalize.readJsonl('events.jsonl')).toEqual([
      { step: 0 },
      { step: 1 },
      { step: 2 }
    ]);
    expect(beforeFinalize.revision()).toBe(6);
  });

  it('keeps append journals independent of existing JSONL history size', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-bounded-append-journal';
    const pluginId = 'plugin.bounded-append-journal';
    const root = pluginRoot(storeRoot, sessionId, pluginId);
    const existingHistory = Array.from(
      { length: 2_000 },
      (_, index) => `${JSON.stringify({ index, text: 'existing history' })}\n`
    ).join('');

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'events.jsonl'), existingHistory, 'utf8');

    const transaction = createRuntimePluginFileStoreTransaction();
    transaction.fileStoreFor({ storeRoot, sessionId, pluginId }).appendJsonl(
      'events.jsonl',
      { value: 'next' }
    );
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journalText = readFileSync(
      preparedJournalPath(storeRoot, sessionId),
      'utf8'
    );
    const journal = JSON.parse(journalText) as {
      readonly operations: readonly Readonly<Record<string, unknown>>[];
    };

    expect(journalText.length).toBeLessThan(2_000);
    expect(journal.operations[0]).not.toHaveProperty('afterContent');
    expect(journal.operations[0]).toMatchObject({
      appendedLine: '{"value":"next"}\n',
      beforeLength: Buffer.byteLength(existingHistory),
      afterLength: Buffer.byteLength(existingHistory) + 17
    });

    await prepared.discard();
  });

  it('keeps in-memory operations prepared until finalization', async () => {
    const sessionIdentity = {};
    const options = {
      sessionId: 'session-memory-transaction-finalize',
      sessionIdentity,
      pluginId: 'plugin.memory-transaction-finalize'
    };
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const transactionalStore = transaction.fileStoreFor(options);

    transactionalStore.writeJsonAtomic('state.json', { value: 'after' });
    transactionalStore.appendJsonl('events.jsonl', { value: 'after' });

    const prepared = await transaction.prepare(testTransactionIdentity());

    expect(base.readJson('state.json')).toEqual({ value: 'before' });
    expect(base.readJsonl('events.jsonl')).toEqual([]);
    expect(base.revision()).toBe(1);

    await prepared.finalize();
    await prepared.finalize();

    expect(base.readJson('state.json')).toEqual({ value: 'after' });
    expect(base.readJsonl('events.jsonl')).toEqual([{ value: 'after' }]);
    expect(base.revision()).toBe(3);
  });

  it('fails closed instead of overwriting an in-memory same-path write after preparation', async () => {
    const sessionIdentity = {};
    const options = {
      sessionId: 'session-memory-prepared-write-conflict',
      sessionIdentity,
      pluginId: 'plugin.memory-prepared-write-conflict'
    };
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('state.json', { value: 'prepared' });
    const prepared = await transaction.prepare(testTransactionIdentity());

    base.writeJsonAtomic('state.json', { value: 'later' });

    await expect(prepared.finalize()).rejects.toThrow(/transaction conflict/iu);
    expect(base.readJson('state.json')).toEqual({ value: 'later' });
    expect(base.revision()).toBe(2);
  });

  it('fails closed when an in-memory same-path write races staged work before preparation', async () => {
    const sessionIdentity = {};
    const options = {
      sessionId: 'session-memory-staged-write-conflict',
      sessionIdentity,
      pluginId: 'plugin.memory-staged-write-conflict'
    };
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('state.json', { value: 'staged' });
    base.writeJsonAtomic('state.json', { value: 'later' });

    await expect(transaction.prepare(testTransactionIdentity())).rejects.toThrow(
      /transaction conflict/iu
    );
    expect(base.readJson('state.json')).toEqual({ value: 'later' });
    expect(base.revision()).toBe(2);
  });

  it('re-reads durable revisions across existing store instances', () => {
    const options = {
      storeRoot: createTempRoot(),
      sessionId: 'session-revision-race',
      pluginId: 'plugin.revision-race'
    };
    const first = createRuntimePluginFileStore(options);
    const second = createRuntimePluginFileStore(options);

    first.writeJsonAtomic('first.json', { value: 1 });
    second.writeJsonAtomic('second.json', { value: 2 });

    expect(first.revision()).toBe(2);
    expect(second.revision()).toBe(2);
  });

  it('fails closed instead of overwriting a same-path write after preparation', async () => {
    const options = {
      storeRoot: createTempRoot(),
      sessionId: 'session-prepared-write-conflict',
      pluginId: 'plugin.prepared-write-conflict'
    };
    await registerRuntimeSession(
      options.storeRoot,
      options.sessionId
    );
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('state.json', { value: 'prepared' });
    const prepared = await transaction.prepare(testTransactionIdentity());

    base.writeJsonAtomic('state.json', { value: 'later' });

    await expect(prepared.finalize()).rejects.toThrow(/transaction conflict/iu);
    expect(base.readJson('state.json')).toEqual({ value: 'later' });
    expect(base.revision()).toBe(2);
  });

  it('fails closed when a durable same-path write races staged work before preparation', async () => {
    const options = {
      storeRoot: createTempRoot(),
      sessionId: 'session-durable-staged-write-conflict',
      pluginId: 'plugin.durable-staged-write-conflict'
    };
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('state.json', { value: 'staged' });
    base.writeJsonAtomic('state.json', { value: 'later' });

    await expect(transaction.prepare(testTransactionIdentity())).rejects.toThrow(
      /transaction conflict/iu
    );
    expect(base.readJson('state.json')).toEqual({ value: 'later' });
    expect(base.revision()).toBe(2);
  });

  it('keeps a planned recovery journal when preflight rejects before mutation', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-partial-finalize-recovery';
    const pluginId = 'plugin.partial-finalize-recovery';
    const options = { storeRoot, sessionId, pluginId };
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('first.json', { value: 'before' });
    base.writeJsonAtomic('second.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('first.json', { value: 'prepared' });
    staged.writeJsonAtomic('second.json', { value: 'prepared' });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journalPath = preparedJournalPath(storeRoot, sessionId);

    base.writeJsonAtomic('second.json', { value: 'later' });

    await expect(prepared.finalize()).rejects.toThrow(/transaction conflict/iu);

    await prepared.discard();

    expect(readFileSync(journalPath, 'utf8')).toContain('"status":"planned"');
    expect(
      JSON.parse(
        readFileSync(join(pluginRoot(storeRoot, sessionId, pluginId), 'first.json'), 'utf8')
      )
    ).toEqual({ value: 'before' });
  });

  it('preflights completed multi-operation recovery before applying any operation', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-completed-preflight-conflict';
    const pluginId = 'plugin.completed-preflight-conflict';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('first.json', { value: 'before' });
    base.writeJsonAtomic('second.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('first.json', { value: 'transaction' });
    staged.writeJsonAtomic('second.json', { value: 'transaction' });
    const prepared = await transaction.prepare(testTransactionIdentity());

    base.writeJsonAtomic('second.json', { value: 'direct' });
    writeCompletedRuntimeEvidence(
      createLocalRuntimeSessionPaths({ storeRoot, sessionId }),
      testTransactionIdentity()
    );

    await expect(prepared.finalize()).rejects.toThrow(/transaction conflict/iu);
    expect(
      JSON.parse(
        readFileSync(
          join(pluginRoot(storeRoot, sessionId, pluginId), 'first.json'),
          'utf8'
        )
      )
    ).toEqual({ value: 'before' });

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /transaction conflict/iu
    );
    expect(
      JSON.parse(
        readFileSync(
          join(pluginRoot(storeRoot, sessionId, pluginId), 'first.json'),
          'utf8'
        )
      )
    ).toEqual({ value: 'before' });
  });

  it('resumes completed batched recovery after content persists before progress', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-batched-progress-recovery';
    const pluginId = 'plugin.batched-progress-recovery';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('first.json', { value: 'before' });
    base.writeJsonAtomic('second.json', { value: 'before' });
    let injectFailure = true;
    const transaction = createRuntimePluginFileStoreTransaction({
      durableFaultInjector() {
        if (injectFailure) {
          injectFailure = false;
          throw new Error('injected batched progress failure');
        }
      }
    });
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('first.json', { value: 'after' });
    staged.writeJsonAtomic('second.json', { value: 'after' });
    const prepared = await transaction.prepare(testTransactionIdentity());
    writeCompletedRuntimeEvidence(
      createLocalRuntimeSessionPaths({ storeRoot, sessionId }),
      testTransactionIdentity()
    );

    await expect(prepared.finalize()).rejects.toThrow(
      /injected batched progress failure/iu
    );

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJson('first.json')).toEqual({ value: 'after' });
    expect(recovered.readJson('second.json')).toEqual({ value: 'after' });
    expect(recovered.revision()).toBe(4);
  });

  it('discards a preflight-rejected journal with no terminal evidence', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-partial-finalize-no-terminal';
    const pluginId = 'plugin.partial-finalize-no-terminal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('first.json', { value: 'before' });
    base.writeJsonAtomic('second.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('first.json', { value: 'prepared' });
    staged.writeJsonAtomic('second.json', { value: 'prepared' });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journalPath = preparedJournalPath(storeRoot, sessionId);

    base.writeJsonAtomic('second.json', { value: 'later' });
    await expect(prepared.finalize()).rejects.toThrow(/transaction conflict/iu);

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJson('first.json')).toEqual({ value: 'before' });
    expect(recovered.readJson('second.json')).toEqual({ value: 'later' });
    expect(() => readFileSync(journalPath, 'utf8')).toThrow();
  });

  it('fails closed when planned journal content changed without terminal evidence', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-planned-content-no-terminal';
    const pluginId = 'plugin.planned-content-no-terminal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'events.jsonl'), '{"value":1}\n', 'utf8');
    writeFileSync(join(root, '.project02-plugin-store-revision'), '1\n', 'utf8');

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /partially applied.*terminal evidence/iu
    );
    expect(readFileSync(journal.path, 'utf8')).toContain('"status":"planned"');
  });

  it('preserves a same-content planned write when its revision already advanced', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-same-content-no-terminal';
    const pluginId = 'plugin.same-content-no-terminal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', { value: 'same' });

    const transaction = createRuntimePluginFileStoreTransaction();
    transaction
      .fileStoreFor(options)
      .writeJsonAtomic('state.json', { value: 'same' });
    const prepared = await transaction.prepare(testTransactionIdentity());

    base.writeJsonAtomic('state.json', { value: 'same' });
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /partially applied.*terminal evidence/iu
    );
    expect(readFileSync(journal.path, 'utf8')).toContain('"status":"planned"');
  });

  it('preserves a same-content planned write after rejected terminal evidence', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-same-content-rejected';
    const pluginId = 'plugin.same-content-rejected';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', { value: 'same' });

    const transaction = createRuntimePluginFileStoreTransaction();
    transaction
      .fileStoreFor(options)
      .writeJsonAtomic('state.json', { value: 'same' });
    const prepared = await transaction.prepare(testTransactionIdentity());

    base.writeJsonAtomic('state.json', { value: 'same' });
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    writeRejectedRuntimeEvidence(
      createLocalRuntimeSessionPaths({ storeRoot, sessionId }),
      testTransactionIdentity()
    );

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /partially applied.*terminal evidence/iu
    );
    expect(readFileSync(journal.path, 'utf8')).toContain('"status":"planned"');
  });

  it('discards a preflight-rejected journal after rejected terminal evidence', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-partial-finalize-rejected';
    const pluginId = 'plugin.partial-finalize-rejected';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('first.json', { value: 'before' });
    base.writeJsonAtomic('second.json', { value: 'before' });

    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('first.json', { value: 'prepared' });
    staged.writeJsonAtomic('second.json', { value: 'prepared' });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journalPath = preparedJournalPath(storeRoot, sessionId);

    base.writeJsonAtomic('second.json', { value: 'later' });
    await expect(prepared.finalize()).rejects.toThrow(/transaction conflict/iu);

    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    writeRejectedRuntimeEvidence(sessionPaths, testTransactionIdentity());

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJson('first.json')).toEqual({ value: 'before' });
    expect(recovered.readJson('second.json')).toEqual({ value: 'later' });
    expect(() => readFileSync(journalPath, 'utf8')).toThrow();
  });

  it('rejects an exact durable plugin-root symlink without following it', () => {
    const storeRoot = createTempRoot();
    const outsideRoot = createTempRoot();
    const sessionId = 'session-plugin-root-symlink';
    const pluginId = 'plugin.root-symlink';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(join(root, '..'), { recursive: true });
    writeFileSync(join(outsideRoot, 'sentinel.json'), '{"safe":true}\n', 'utf8');
    symlinkSync(outsideRoot, root, 'dir');

    expect(() =>
      createRuntimePluginFileStore({ storeRoot, sessionId, pluginId })
    ).toThrow(/real directory/iu);
    expect(readFileSync(join(outsideRoot, 'sentinel.json'), 'utf8')).toBe(
      '{"safe":true}\n'
    );
  });

  it('rejects a symlinked plugins ancestor without writing outside the store', () => {
    const storeRoot = createTempRoot();
    const outsideRoot = createTempRoot();
    const sessionId = 'session-plugins-ancestor-symlink';
    const pluginId = 'plugin.plugins-ancestor-symlink';
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    const pluginsRoot = join(sessionPaths.sessionRoot, 'plugins');

    mkdirSync(sessionPaths.sessionRoot, { recursive: true });
    symlinkSync(outsideRoot, pluginsRoot, 'dir');

    expect(() => {
      createRuntimePluginFileStore({ storeRoot, sessionId, pluginId })
        .writeJsonAtomic('state.json', { value: 'escaped' });
    }).toThrow(/symlink/iu);
    expect(() => readFileSync(join(outsideRoot, pluginId, 'state.json'), 'utf8'))
      .toThrow();
  });

  it('canonicalizes a store-root alias without discarding its live prepared journal', async () => {
    const storeRoot = createTempRoot();
    const aliasParent = createTempRoot();
    const aliasRoot = join(aliasParent, 'store-alias');
    const sessionId = 'session-store-root-alias';
    const pluginId = 'plugin.store-root-alias';
    const options = { storeRoot, sessionId, pluginId };
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journalPath = preparedJournalPath(storeRoot, sessionId);

    symlinkSync(storeRoot, aliasRoot, 'dir');

    const aliasedStore = createRuntimePluginFileStore({
      storeRoot: aliasRoot,
      sessionId,
      pluginId
    });

    expect(aliasedStore.readJsonl('events.jsonl')).toEqual([]);
    expect(readFileSync(journalPath, 'utf8')).toContain('"status":"planned"');

    await prepared.discard();
  });

  it('rejects a symlinked transaction-journal ancestor without writing outside', async () => {
    const storeRoot = createTempRoot();
    const outsideRoot = createTempRoot();
    const sessionId = 'session-journal-ancestor-symlink';
    const pluginId = 'plugin.journal-ancestor-symlink';
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction
      .fileStoreFor({ storeRoot, sessionId, pluginId })
      .appendJsonl('events.jsonl', { value: 1 });

    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    mkdirSync(sessionPaths.sessionRoot, { recursive: true });
    symlinkSync(
      outsideRoot,
      join(sessionPaths.sessionRoot, '.plugin-transactions'),
      'dir'
    );

    await expect(transaction.prepare(testTransactionIdentity())).rejects.toThrow(
      /symlink/iu
    );
    expect(readdirSync(outsideRoot)).toEqual([]);
  });

  it('keeps transaction journal identities distinct by createdAt', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-created-at-journal-identity';
    const firstTransaction = createRuntimePluginFileStoreTransaction();
    const secondTransaction = createRuntimePluginFileStoreTransaction();

    firstTransaction
      .fileStoreFor({
        storeRoot,
        sessionId,
        pluginId: 'plugin.created-at-first'
      })
      .appendJsonl('events.jsonl', { value: 1 });
    secondTransaction
      .fileStoreFor({
        storeRoot,
        sessionId,
        pluginId: 'plugin.created-at-second'
      })
      .appendJsonl('events.jsonl', { value: 2 });

    const first = await firstTransaction.prepare(testTransactionIdentity());
    const second = await secondTransaction.prepare({
      ...testTransactionIdentity(),
      createdAt: '2026-06-15T00:00:01.000Z'
    });
    const journalRoot = join(
      createLocalRuntimeSessionPaths({ storeRoot, sessionId }).sessionRoot,
      '.plugin-transactions'
    );

    expect(
      readdirSync(journalRoot).filter((name) => name.endsWith('.json'))
    ).toHaveLength(2);

    await first.discard();
    await second.discard();
  });

  it('allows only one prepared journal for the same full event identity', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-shared-journal-identity';
    const firstTransaction = createRuntimePluginFileStoreTransaction();
    const secondTransaction = createRuntimePluginFileStoreTransaction();

    firstTransaction
      .fileStoreFor({
        storeRoot,
        sessionId,
        pluginId: 'plugin.claim-first'
      })
      .appendJsonl('events.jsonl', { value: 1 });
    secondTransaction
      .fileStoreFor({
        storeRoot,
        sessionId,
        pluginId: 'plugin.claim-second'
      })
      .appendJsonl('events.jsonl', { value: 2 });

    const first = await firstTransaction.prepare(testTransactionIdentity());

    await expect(
      secondTransaction.prepare(testTransactionIdentity())
    ).rejects.toThrow(/already exists/iu);
    await first.discard();
  });

  it('rejects a journal whose persisted identity does not match its path', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-journal-path-identity';
    const pluginId = 'plugin.journal-path-identity';
    const options = { storeRoot, sessionId, pluginId };
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({
      storeRoot,
      sessionId,
      prepared,
      createdAt: '2026-06-15T00:00:01.000Z'
    });

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /journal identity.*path/iu
    );
    expect(readFileSync(journal.path, 'utf8')).toContain(
      '"createdAt":"2026-06-15T00:00:01.000Z"'
    );
  });

  it('never recovers or removes a journal owned on another host', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-foreign-journal-owner';
    const pluginId = 'plugin.foreign-journal-owner';
    const options = { storeRoot, sessionId, pluginId };
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({
      storeRoot,
      sessionId,
      prepared,
      ownerHostname: 'remote-host.invalid'
    });
    const store = createRuntimePluginFileStore(options);

    expect(store.readJsonl('events.jsonl')).toEqual([]);
    expect(store.revision()).toBe(0);
    expect(readFileSync(journal.path, 'utf8')).toContain(
      '"ownerHostname":"remote-host.invalid"'
    );
  });

  it('preserves journal temp files whose host ownership is unknown', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-foreign-journal-temp';
    const pluginId = 'plugin.foreign-journal-temp';
    const journalRoot = join(
      createLocalRuntimeSessionPaths({ storeRoot, sessionId }).sessionRoot,
      '.plugin-transactions'
    );
    const tempPath = join(
      journalRoot,
      '.journal.json.99999999.00000000-0000-4000-8000-000000000000.tmp'
    );

    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(tempPath, '{"foreignHostWrite":true}\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    expect(store.revision()).toBe(0);
    expect(readFileSync(tempPath, 'utf8')).toBe(
      '{"foreignHostWrite":true}\n'
    );
  });

  it('rejects malformed journal owner nonces', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-malformed-journal-owner';
    const pluginId = 'plugin.malformed-journal-owner';
    const options = { storeRoot, sessionId, pluginId };
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());

    await abandonPreparedJournal({
      storeRoot,
      sessionId,
      prepared,
      ownerNonce: 'not-a-valid-owner-nonce'
    });

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /journal.*malformed/iu
    );
  });

  it('finalizes a crash-left journal only when completed terminal evidence exists', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-crash-journal-completed';
    const pluginId = 'plugin.crash-journal-completed';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });

    writeCompletedRuntimeEvidence(
      sessionPaths,
      testTransactionIdentity()
    );

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([{ value: 1 }]);
    expect(recovered.revision()).toBe(1);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('recovers an append journal idempotently when the full line already exists', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-append-journal-exact-after';
    const pluginId = 'plugin.append-journal-exact-after';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'events.jsonl'), '{"value":1}\n', 'utf8');

    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    writeCompletedRuntimeEvidence(sessionPaths, testTransactionIdentity());

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([{ value: 1 }]);
    expect(recovered.revision()).toBe(1);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('recovers an append journal from an exact partial-line prefix', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-append-journal-partial-line';
    const pluginId = 'plugin.append-journal-partial-line';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'events.jsonl'), '{"value":', 'utf8');

    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    writeCompletedRuntimeEvidence(sessionPaths, testTransactionIdentity());

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([{ value: 1 }]);
    expect(recovered.revision()).toBe(1);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('recovers an append journal from a partial UTF-8 code point', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-append-journal-partial-utf8';
    const pluginId = 'plugin.append-journal-partial-utf8';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction
      .fileStoreFor(options)
      .appendJsonl('events.jsonl', { value: '雪' });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const root = pluginRoot(storeRoot, sessionId, pluginId);
    const appendedLine = Buffer.from('{"value":"雪"}\n', 'utf8');
    const multibyteStart = appendedLine.indexOf(Buffer.from('雪', 'utf8'));

    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'events.jsonl'),
      appendedLine.subarray(0, multibyteStart + 1)
    );

    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    writeCompletedRuntimeEvidence(sessionPaths, testTransactionIdentity());

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([{ value: '雪' }]);
    expect(recovered.revision()).toBe(1);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('fails closed when append recovery finds a foreign suffix', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-append-journal-foreign-suffix';
    const pluginId = 'plugin.append-journal-foreign-suffix';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'events.jsonl'), '{"foreign":true}\n', 'utf8');

    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    writeCompletedRuntimeEvidence(sessionPaths, testTransactionIdentity());

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /transaction conflict/iu
    );
    expect(readFileSync(journal.path, 'utf8')).toContain('"status":"planned"');
    expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).toBe(
      '{"foreign":true}\n'
    );
  });

  it('rejects a lone completed terminal record and preserves its journal', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-crash-journal-lone-terminal';
    const pluginId = 'plugin.crash-journal-lone-terminal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });

    writeRawEventFixtures(sessionPaths.rawEventsPath, [
      {
        ...testTransactionIdentity(),
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed'
      }
    ]);

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      LocalRuntimeStorageContractError
    );
    expect(readFileSync(journal.path, 'utf8')).toContain('"status":"planned"');
  });

  it('does not authorize recovery from a terminal with a different createdAt', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-crash-journal-stale-terminal';
    const pluginId = 'plugin.crash-journal-stale-terminal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();
    const staleIdentity = {
      ...testTransactionIdentity(),
      createdAt: '2026-06-14T00:00:00.000Z'
    };

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });

    writeCompletedRuntimeEvidence(sessionPaths, staleIdentity);

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([]);
    expect(recovered.revision()).toBe(0);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('discards a crash-left journal when no terminal evidence exists', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-crash-journal-no-terminal';
    const pluginId = 'plugin.crash-journal-no-terminal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([]);
    expect(recovered.revision()).toBe(0);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('discards repeated same-path JSONL operations when none applied', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-repeated-jsonl-no-terminal';
    const pluginId = 'plugin.repeated-jsonl-no-terminal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.appendJsonl('events.jsonl', { value: 1 });
    staged.appendJsonl('events.jsonl', { value: 2 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([]);
    expect(recovered.revision()).toBe(0);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('discards a crash-left journal when rejected terminal evidence exists', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-crash-journal-rejected';
    const pluginId = 'plugin.crash-journal-rejected';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });

    writeRejectedRuntimeEvidence(sessionPaths, testTransactionIdentity());

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([]);
    expect(recovered.revision()).toBe(0);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('discards repeated same-path JSON writes after a rejected turn', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-repeated-json-rejected';
    const pluginId = 'plugin.repeated-json-rejected';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();
    const staged = transaction.fileStoreFor(options);

    staged.writeJsonAtomic('state.json', { value: 1 });
    staged.writeJsonAtomic('state.json', { value: 2 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({ storeRoot, sessionId, prepared });
    const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
    writeRejectedRuntimeEvidence(sessionPaths, testTransactionIdentity());

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJson('state.json')).toBeUndefined();
    expect(recovered.revision()).toBe(0);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });

  it('does not discard a no-terminal journal owned by another live process', async () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-live-owner-journal';
    const pluginId = 'plugin.live-owner-journal';
    const options = { storeRoot, sessionId, pluginId };
    await registerRuntimeSession(storeRoot, sessionId);
    const transaction = createRuntimePluginFileStoreTransaction();
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' }
    );

    if (child.pid === undefined) {
      throw new Error('Expected live journal owner process.');
    }

    transaction.fileStoreFor(options).appendJsonl('events.jsonl', { value: 1 });
    const prepared = await transaction.prepare(testTransactionIdentity());
    const journal = await abandonPreparedJournal({
      storeRoot,
      sessionId,
      prepared,
      ownerPid: child.pid
    });

    try {
      const whileOwnerIsLive = createRuntimePluginFileStore(options);

      expect(whileOwnerIsLive.readJsonl('events.jsonl')).toEqual([]);
      expect(readFileSync(journal.path, 'utf8')).toContain(
        `"ownerPid":${String(child.pid)}`
      );
    } finally {
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        child.kill();
      });
    }

    const afterOwnerExit = createRuntimePluginFileStore(options);

    expect(afterOwnerExit.readJsonl('events.jsonl')).toEqual([]);
    expect(() => readFileSync(journal.path, 'utf8')).toThrow();
  });
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'project02-plugin-file-store-'));

  tempRoots.push(root);
  return root;
}

function writeRawEventFixtures(
  path: string,
  records: readonly Readonly<Record<string, unknown>>[]
): void {
  writeFileSync(
    path,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8'
  );
}

function writeCompletedRuntimeEvidence(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>,
  identity: ReturnType<typeof testTransactionIdentity>
): void {
  writeRawEventFixtures(paths.rawEventsPath, [
    {
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    },
    {
      ...identity,
      kind: 'runtime_event_normalized',
      eventType: 'USER_MESSAGE'
    },
    {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed'
    }
  ]);
  writeRawEventFixtures(paths.tracePath, [
    { ...identity, step: 'runtime_event_received' },
    { ...identity, step: 'runtime_event_normalized' },
    { ...identity, step: 'runtime_turn_started' },
    { ...identity, step: 'raw_event_log_appended' },
    { ...identity, step: 'runtime_turn_completed' }
  ]);
}

function writeRejectedRuntimeEvidence(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>,
  identity: ReturnType<typeof testTransactionIdentity>
): void {
  writeRawEventFixtures(paths.rawEventsPath, [
    {
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    },
    {
      ...identity,
      kind: 'runtime_event_normalized',
      eventType: 'USER_MESSAGE'
    },
    {
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'test rejection'
    }
  ]);
  writeRawEventFixtures(paths.tracePath, [
    { ...identity, step: 'runtime_event_received' },
    { ...identity, step: 'runtime_event_normalized' },
    { ...identity, step: 'runtime_turn_started' },
    { ...identity, step: 'raw_event_log_appended' },
    { ...identity, step: 'runtime_turn_rejected' }
  ]);
}

async function registerRuntimeSession(
  storeRoot: string,
  sessionId: string
): Promise<void> {
  await createLocalRuntimeSessionStore({ storeRoot }).createSession({
    sessionId,
    createdAt: testTransactionIdentity().createdAt
  });
}

function testTransactionIdentity() {
  return {
    eventId: 'evt_plugin_file_store_transaction',
    traceId: 'trace_plugin_file_store_transaction',
    createdAt: '2026-06-15T00:00:00.000Z'
  };
}

async function abandonPreparedJournal(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly prepared: { discard(): Promise<void> };
  readonly createdAt?: string;
  readonly ownerHostname?: string;
  readonly ownerNonce?: string;
  readonly ownerPid?: number;
}): Promise<{ readonly path: string }> {
  const path = preparedJournalPath(options.storeRoot, options.sessionId);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Expected plugin transaction journal object.');
  }

  await options.prepared.discard();
  writeFileSync(
    path,
    `${JSON.stringify({
      ...parsed,
      ...(options.createdAt === undefined
        ? {}
        : { createdAt: options.createdAt }),
      ...(options.ownerHostname === undefined
        ? {}
        : { ownerHostname: options.ownerHostname }),
      ...(options.ownerNonce === undefined
        ? {}
        : { ownerNonce: options.ownerNonce }),
      ownerPid: options.ownerPid ?? 99_999_999
    })}\n`,
    'utf8'
  );

  return { path };
}

function preparedJournalPath(storeRoot: string, sessionId: string): string {
  const sessionPaths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });
  const journalRoot = join(sessionPaths.sessionRoot, '.plugin-transactions');
  const journalName = readdirSync(journalRoot).find((name) =>
    name.endsWith('.json')
  );

  if (journalName === undefined) {
    throw new Error('Expected prepared plugin transaction journal.');
  }

  return join(journalRoot, journalName);
}

function pluginRoot(
  storeRoot: string,
  sessionId: string,
  pluginId: string
): string {
  return createLocalRuntimePluginPaths({
    storeRoot,
    sessionId,
    pluginId
  }).pluginRoot;
}

function createProtoKeyValue(): RuntimePluginJsonObject {
  const nested: Record<string, RuntimePluginJsonObject[string]> = {};
  Object.defineProperty(nested, '__proto__', {
    value: 'nested-value',
    enumerable: true
  });

  const value: Record<string, RuntimePluginJsonObject[string]> = {
    nested
  };
  Object.defineProperty(value, '__proto__', {
    value: {
      preserved: true
    },
    enumerable: true
  });

  return value;
}

function expectProtoKeyValue(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('Expected plugin file value to be a JSON object.');
  }

  expect(Object.hasOwn(value, '__proto__')).toBe(true);
  expect(value['__proto__']).toEqual({
    preserved: true
  });
  expect(JSON.stringify(value)).toContain('"__proto__":{"preserved":true}');

  const nested = value['nested'];
  if (!isRecord(nested)) {
    throw new Error('Expected nested plugin file value to be a JSON object.');
  }

  expect(Object.hasOwn(nested, '__proto__')).toBe(true);
  expect(nested['__proto__']).toBe('nested-value');
  expect(JSON.stringify(nested)).toContain('"__proto__":"nested-value"');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
