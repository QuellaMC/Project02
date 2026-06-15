import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';
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
  return join(storeRoot, 'sessions', sessionId, 'plugins', pluginId);
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
