import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';
import {
  createLocalRuntimePluginPaths,
  LocalRuntimeStorageContractError
} from '../src/runtime/storage/layout.ts';
import type {
  RuntimePluginJsonObject
} from '../src/plugins/types.ts';

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
      '{"value":1}\n\n{"value":2}\n',
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

  it('preserves own __proto__ keys in plugin file values', () => {
    const memory = createRuntimePluginFileStore({
      sessionId: 'session-proto-key',
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

  it('rejects JSONL reads and appends on paths that already store JSON', () => {
    const stores = [
      createRuntimePluginFileStore({
        sessionId: 'session-mixed-json-jsonl-memory',
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
    }).toThrow(/non-array JSON/iu);
    expect(() => {
      legacyDurable.appendJsonl('mixed.json', { value: 'jsonl' });
    }).toThrow(/non-array JSON/iu);
    expect(legacyDurable.readJson('mixed.json')).toEqual({
      value: 'legacy-json'
    });
    expect(legacyDurable.revision()).toBe(1);
  });

  it('rejects JSON reads on paths that already store JSONL', () => {
    const stores = [
      createRuntimePluginFileStore({
        sessionId: 'session-mixed-jsonl-json-memory',
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
    expect(secondDurable.readJsonl('events.jsonl')).toEqual([
      { value: 'jsonl' }
    ]);
    expect(secondDurable.revision()).toBe(1);
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

    first.appendJsonl('events.jsonl', { value: 1 });
    expect(first.readJsonl('events.jsonl')).toEqual([{ value: 1 }]);

    const second = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId
    });

    second.appendJsonl('events.jsonl', { value: 2 });

    expect(second.readJsonl('events.jsonl')).toEqual([
      { value: 1 },
      { value: 2 }
    ]);
  });
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'project02-plugin-file-store-'));

  tempRoots.push(root);
  return root;
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
