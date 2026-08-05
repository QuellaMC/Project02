import {isJsonRecord} from '../../src/shared/json-boundary.ts';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {createDurableRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/durable-store.ts';
import {
  durablePathModesFileName,
  durableRevisionFileName,
} from '../../src/runtime/storage/plugin-file-store/shared.ts';
import {
  createLocalRuntimePluginPaths,
  createLocalRuntimeSessionPaths,
  LocalRuntimeStorageContractError,
} from '../../src/runtime/storage/layout-contract.ts';
import type {RuntimePluginJsonObject} from '../../src/plugins/api/index.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, {recursive: true, force: true});
  }
});

describe('runtime plugin file store', () => {
  it('rejects unsafe durable session and plugin ID path components', () => {
    const storeRoot = createTempRoot();

    expect(() =>
      createRuntimePluginFileStore({
        storeRoot,
        sessionId: '../outside-session',
        pluginId: 'plugin.safe',
      }),
    ).toThrow(/session ID/iu);

    expect(() =>
      createRuntimePluginFileStore({
        storeRoot,
        sessionId: 'session-safe',
        pluginId: '../outside-plugin',
      }),
    ).toThrow(/plugin ID/iu);

    let pluginIdError: unknown;

    try {
      createRuntimePluginFileStore({
        storeRoot,
        sessionId: 'session-safe',
        pluginId: '../outside-plugin',
      });
    } catch (error: unknown) {
      pluginIdError = error;
    }

    expect(pluginIdError).toBeInstanceOf(LocalRuntimeStorageContractError);
    expect(pluginIdError).toMatchObject({
      code: 'invalid_plugin_id',
    });
  });

  it('seeds and persists durable revisions from existing plugin files', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-durable-revision';
    const pluginId = 'plugin.durable';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, {recursive: true});
    writeFileSync(join(root, 'current.json'), '{"value":"existing"}\n', 'utf8');
    writeFileSync(
      join(root, 'events.jsonl'),
      '{"value":1}\n{"value":2}\n',
      'utf8',
    );

    const first = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    expect(first.revision()).toBe(3);

    first.writeJsonAtomic('current.json', {value: 'updated'});

    expect(first.revision()).toBe(4);

    const second = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    expect(second.revision()).toBe(4);

    second.appendJsonl('events.jsonl', {value: 3});

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
        `..project02-plugin-store-modes.json.${String(deadPid)}.${uuid}.tmp`,
      ),
      join(
        root,
        `..project02-plugin-store-revision.${String(deadPid)}.${uuid}.tmp`,
      ),
    ];
    const liveTempPath = join(
      root,
      `.live.json.${String(process.pid)}.${uuid}.tmp`,
    );
    const legitimateUserPath = join(
      root,
      `notes.${String(deadPid)}.${uuid}.tmp`,
    );

    mkdirSync(root, {recursive: true});

    for (const path of [...deadTempPaths, liveTempPath]) {
      writeFileSync(path, '{"temporary":true}\n', 'utf8');
    }
    writeFileSync(legitimateUserPath, '{"userData":true}\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    expect(store.revision()).toBe(1);

    for (const path of deadTempPaths) {
      expect(() => readFileSync(path, 'utf8')).toThrow();
    }

    expect(readFileSync(liveTempPath, 'utf8')).toBe('{"temporary":true}\n');
    expect(store.readJson(`notes.${String(deadPid)}.${uuid}.tmp`)).toEqual({
      userData: true,
    });
  });

  it('recovers a direct append when metadata persistence fails after content', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-direct-mutation-recovery';
    const pluginId = 'plugin.direct-mutation-recovery';
    const options = {storeRoot, sessionId, pluginId};
    const base = createRuntimePluginFileStore(options);

    base.appendJsonl('events.jsonl', {value: 1});

    const injected = createDurableRuntimePluginFileStore(options, {
      faultInjector(point) {
        expect(point).toBe('after_content_persisted');
        throw new Error('injected path-mode persistence failure');
      },
    });

    expect(() => {
      injected.appendJsonl('events.jsonl', {value: 2});
    }).toThrow(/injected path-mode persistence failure/iu);

    const root = pluginRoot(storeRoot, sessionId, pluginId);

    expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).toBe(
      '{"value":1}\n{"value":2}\n',
    );
    expect(
      readFileSync(join(root, '.project02-plugin-store-revision'), 'utf8'),
    ).toBe('1\n');

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([
      {value: 1},
      {value: 2},
    ]);
    expect(recovered.revision()).toBe(2);
    expect(() =>
      readFileSync(
        join(root, '.project02-plugin-store-direct-mutation.json'),
        'utf8',
      ),
    ).toThrow();
  });

  it('names the version when a journal was written by another build', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-foreign-journal-version';
    const pluginId = 'plugin.foreign-journal-version';
    const options = {storeRoot, sessionId, pluginId};

    createRuntimePluginFileStore(options).appendJsonl('events.jsonl', {
      value: 1,
    });
    writeFileSync(
      join(
        pluginRoot(storeRoot, sessionId, pluginId),
        '.project02-plugin-store-direct-mutation.json',
      ),
      `${JSON.stringify({
        version: 'project02.plugin_transaction.v1',
        ownerHostname: 'host',
        ownerNonce: '2f1c4f0e-6a1b-4c6d-9e2a-7b3d5f8c1a90',
        ownerPid: 1234,
        sessionId,
        operations: [],
      })}\n`,
      'utf8',
    );

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /written by another version \(project02\.plugin_transaction\.v1\)/iu,
    );
  });

  it('recovers a direct JSON write when metadata persistence fails after content', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-direct-json-recovery';
    const pluginId = 'plugin.direct-json-recovery';
    const options = {storeRoot, sessionId, pluginId};
    const base = createRuntimePluginFileStore(options);

    base.writeJsonAtomic('state.json', {mood: 'steady'});

    const injected = createDurableRuntimePluginFileStore(options, {
      faultInjector() {
        throw new Error('injected path-mode persistence failure');
      },
    });

    expect(() => {
      injected.writeJsonAtomic('state.json', {mood: 'curious'});
    }).toThrow(/injected path-mode persistence failure/iu);

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJson('state.json')).toEqual({mood: 'curious'});
    expect(recovered.revision()).toBe(2);
  });

  it('refuses to recover a write whose target changed underneath the journal', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-direct-recovery-conflict';
    const pluginId = 'plugin.direct-recovery-conflict';
    const options = {storeRoot, sessionId, pluginId};
    const base = createRuntimePluginFileStore(options);

    base.appendJsonl('events.jsonl', {value: 1});

    const injected = createDurableRuntimePluginFileStore(options, {
      faultInjector() {
        throw new Error('injected path-mode persistence failure');
      },
    });

    expect(() => {
      injected.appendJsonl('events.jsonl', {value: 2});
    }).toThrow(/injected path-mode persistence failure/iu);

    // Rewritten while the journal was open, so neither recorded state
    // matches.
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    writeFileSync(
      join(root, 'events.jsonl'),
      '{"value":"edited by hand"}\n',
      'utf8',
    );

    expect(() => createRuntimePluginFileStore(options)).toThrow(
      /transaction conflict for plugin\.direct-recovery-conflict\/events\.jsonl/iu,
    );
  });

  it('finishes a torn append whose line was only partly written', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-direct-recovery-torn';
    const pluginId = 'plugin.direct-recovery-torn';
    const options = {storeRoot, sessionId, pluginId};
    const base = createRuntimePluginFileStore(options);

    base.appendJsonl('events.jsonl', {value: 1});

    const injected = createDurableRuntimePluginFileStore(options, {
      faultInjector() {
        throw new Error('injected path-mode persistence failure');
      },
    });

    expect(() => {
      injected.appendJsonl('events.jsonl', {value: 2});
    }).toThrow(/injected path-mode persistence failure/iu);

    // A crash mid-append leaves a fragment of the line on disk.
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    writeFileSync(join(root, 'events.jsonl'), '{"value":1}\n{"val', 'utf8');

    const recovered = createRuntimePluginFileStore(options);

    expect(recovered.readJsonl('events.jsonl')).toEqual([
      {value: 1},
      {value: 2},
    ]);
    expect(recovered.revision()).toBe(2);
  });

  it('reserves metadata and atomic-temp names in every plugin path segment', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-reserved-plugin-paths';
    const pluginId = 'plugin.reserved-paths';
    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });
    const uuid = '00000000-0000-4000-8000-000000000000';
    const reservedPaths = [
      '.project02-plugin-store-revision/child.json',
      'nested/.project02-plugin-store-modes.json/child.json',
      '.project02-plugin-store-direct-mutation.json/child.json',
      `.state.json.99999999.${uuid}.tmp`,
    ];

    for (const path of reservedPaths) {
      expect(() => {
        store.writeJsonAtomic(path, {unsafe: true});
      }).toThrow(/safe relative path/iu);
    }

    expect(store.revision()).toBe(0);
  });

  it('isolates in-memory stores by session object when supplied', () => {
    const firstSession = Object.freeze({id: 'local-session'});
    const secondSession = Object.freeze({id: 'local-session'});
    const first = createRuntimePluginFileStore({
      sessionId: 'local-session',
      sessionIdentity: firstSession,
      pluginId: 'plugin.memory',
    });
    const second = createRuntimePluginFileStore({
      sessionId: 'local-session',
      sessionIdentity: secondSession,
      pluginId: 'plugin.memory',
    });

    first.writeJsonAtomic('state.json', {value: 'first'});

    expect(second.readJson('state.json')).toBeUndefined();
    expect(second.revision()).toBe(0);

    const firstAgain = createRuntimePluginFileStore({
      sessionId: 'local-session',
      sessionIdentity: firstSession,
      pluginId: 'plugin.memory',
    });

    expect(firstAgain.readJson('state.json')).toEqual({value: 'first'});
    expect(firstAgain.revision()).toBe(1);
  });

  it('rejects in-memory stores without an owning session identity', () => {
    const unsafeOptions: unknown = {
      sessionId: 'session-without-owner',
      pluginId: 'plugin.memory-without-owner',
    };

    expect(() => {
      Reflect.apply(createRuntimePluginFileStore, undefined, [unsafeOptions]);
    }).toThrow(/sessionIdentity/iu);
  });

  it('preserves own __proto__ keys in plugin file values', () => {
    const memory = createRuntimePluginFileStore({
      sessionId: 'session-proto-key',
      sessionIdentity: {},
      pluginId: 'plugin.proto',
    });
    const durable = createRuntimePluginFileStore({
      storeRoot: createTempRoot(),
      sessionId: 'session-proto-key',
      pluginId: 'plugin.proto',
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
      pluginId: 'plugin.finite',
    });
    const nonFiniteMemoryValue: RuntimePluginJsonObject = {
      score: Number.POSITIVE_INFINITY,
    };

    expect(() => {
      memory.writeJsonAtomic('value.json', nonFiniteMemoryValue);
    }).toThrow(/finite JSON/iu);
    expect(memory.readJson('value.json')).toBeUndefined();
    expect(memory.revision()).toBe(0);

    const durable = createRuntimePluginFileStore({
      storeRoot: createTempRoot(),
      sessionId: 'session-finite-json',
      pluginId: 'plugin.finite',
    });
    const nonFiniteDurableValue: RuntimePluginJsonObject = {
      score: Number.NaN,
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
      pluginId: 'plugin.json-boundary',
    });
    const cyclic: RuntimePluginJsonObject = {};
    Object.defineProperty(cyclic, 'self', {
      value: cyclic,
      enumerable: true,
    });
    let deep: RuntimePluginJsonObject = {};

    for (let depth = 0; depth < 20; depth += 1) {
      deep = {value: deep};
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
    ['a record a crash cut short', '{"value":1}\n{"val'],
    ['a tail of blank bytes', '{"value":1}\n   '],
  ])('skips durable JSONL containing %s', (_description, content) => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-jsonl-framing';
    const pluginId = 'plugin.jsonl-framing';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, {recursive: true});
    writeFileSync(join(root, 'events.jsonl'), content, 'utf8');
    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    // The unfinished record never committed; earlier ones survive.
    expect(store.readJsonl('events.jsonl')).toEqual([{value: 1}]);
  });

  it('keeps a new record readable when appending after a crash-torn one', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-jsonl-torn-append';
    const pluginId = 'plugin.jsonl-torn-append';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, {recursive: true});
    // A prior crash left the file ending mid-record.
    writeFileSync(join(root, 'events.jsonl'), '{"value":1}\n{"val', 'utf8');
    writeFileSync(
      join(root, durablePathModesFileName),
      '{"events.jsonl":"jsonl"}\n',
      'utf8',
    );
    writeFileSync(join(root, durableRevisionFileName), '1\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    store.appendJsonl('events.jsonl', {value: 2});

    // A record of its own, not text spliced onto the fragment.
    expect(store.readJsonl('events.jsonl')).toEqual([{value: 1}, {value: 2}]);
  });

  it('keeps a non-ASCII record intact when dropping a torn tail after it', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-jsonl-utf8-torn';
    const pluginId = 'plugin.jsonl-utf8-torn';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, {recursive: true});
    // Longer in bytes than code units, so a string offset would cut the
    // committed record's newline off with the fragment.
    writeFileSync(
      join(root, 'events.jsonl'),
      '{"text":"caf\u00e9"}\n{"tor',
      'utf8',
    );
    writeFileSync(
      join(root, durablePathModesFileName),
      '{"events.jsonl":"jsonl"}\n',
      'utf8',
    );
    writeFileSync(join(root, durableRevisionFileName), '1\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    store.appendJsonl('events.jsonl', {value: 2});

    expect(store.readJsonl('events.jsonl')).toEqual([
      {text: 'caf\u00e9'},
      {value: 2},
    ]);
  });

  it('withholds a record whose terminating newline never landed', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-jsonl-unterminated';
    const pluginId = 'plugin.jsonl-unterminated';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, {recursive: true});
    // Complete JSON, no newline: the write did not finish, and the next
    // append discards it. Reading it as committed would show recovery a
    // record that then vanishes.
    writeFileSync(
      join(root, 'events.jsonl'),
      '{"value":1}\n{"value":2}',
      'utf8',
    );
    writeFileSync(
      join(root, durablePathModesFileName),
      '{"events.jsonl":"jsonl"}\n',
      'utf8',
    );
    writeFileSync(join(root, durableRevisionFileName), '1\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    expect(store.readJsonl('events.jsonl')).toEqual([{value: 1}]);
  });

  it('reports a damaged record instead of returning a short history', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-jsonl-damage';
    const pluginId = 'plugin.jsonl-damage';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(root, {recursive: true});
    // Committed records follow the bad line, so it was never an
    // unfinished append — the writer truncates those before appending.
    writeFileSync(
      join(root, 'events.jsonl'),
      '{"value":1}\n{"corrupt\n{"value":3}\n',
      'utf8',
    );
    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    expect(() => store.readJsonl('events.jsonl')).toThrow(
      /line 2 is not valid JSON/iu,
    );
  });

  it('rejects JSONL reads and appends on paths that already store JSON', () => {
    const stores = [
      createRuntimePluginFileStore({
        sessionId: 'session-mixed-json-jsonl-memory',
        sessionIdentity: {},
        pluginId: 'plugin.mixed-mode',
      }),
      createRuntimePluginFileStore({
        storeRoot: createTempRoot(),
        sessionId: 'session-mixed-json-jsonl-durable',
        pluginId: 'plugin.mixed-mode',
      }),
    ];

    for (const store of stores) {
      store.writeJsonAtomic('mixed.json', {value: 'json'});

      expect(() => {
        store.readJsonl('mixed.json');
      }).toThrow(/non-array JSON/iu);
      expect(() => {
        store.appendJsonl('mixed.json', {value: 'jsonl'});
      }).toThrow(/non-array JSON/iu);
      expect(store.readJson('mixed.json')).toEqual({value: 'json'});
      expect(store.revision()).toBe(1);
    }

    const storeRoot = createTempRoot();
    const firstDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-json-jsonl-reopened',
      pluginId: 'plugin.mixed-mode-reopened',
    });

    firstDurable.writeJsonAtomic('mixed.json', {value: 'json'});

    const secondDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-json-jsonl-reopened',
      pluginId: 'plugin.mixed-mode-reopened',
    });

    expect(() => {
      secondDurable.readJsonl('mixed.json');
    }).toThrow(/non-array JSON/iu);
    expect(() => {
      secondDurable.appendJsonl('mixed.json', {value: 'jsonl'});
    }).toThrow(/non-array JSON/iu);
    expect(secondDurable.readJson('mixed.json')).toEqual({value: 'json'});
    expect(secondDurable.revision()).toBe(1);

    const legacyStoreRoot = createTempRoot();
    const legacyRoot = pluginRoot(
      legacyStoreRoot,
      'session-mixed-json-jsonl-legacy',
      'plugin.mixed-mode-legacy',
    );
    mkdirSync(legacyRoot, {recursive: true});
    writeFileSync(
      join(legacyRoot, 'mixed.json'),
      '{"value":"legacy-json"}\n',
      'utf8',
    );

    const legacyDurable = createRuntimePluginFileStore({
      storeRoot: legacyStoreRoot,
      sessionId: 'session-mixed-json-jsonl-legacy',
      pluginId: 'plugin.mixed-mode-legacy',
    });

    expect(() => {
      legacyDurable.readJsonl('mixed.json');
    }).toThrow(/already stores JSON/iu);
    expect(() => {
      legacyDurable.appendJsonl('mixed.json', {value: 'jsonl'});
    }).toThrow(/already stores JSON/iu);
    expect(legacyDurable.readJson('mixed.json')).toEqual({
      value: 'legacy-json',
    });
    expect(legacyDurable.revision()).toBe(1);
  });

  it('rejects JSONL reads and appends on untracked durable paths that store JSON arrays', () => {
    const storeRoot = createTempRoot();
    const root = pluginRoot(
      storeRoot,
      'session-mixed-json-array-jsonl-legacy',
      'plugin.mixed-mode-array-legacy',
    );
    const mixedJsonPath = join(root, 'mixed.json');
    const mixedJsonContent = '[{"value":"legacy-array-json"}]\n';
    mkdirSync(root, {recursive: true});
    writeFileSync(mixedJsonPath, mixedJsonContent, 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-json-array-jsonl-legacy',
      pluginId: 'plugin.mixed-mode-array-legacy',
    });

    expect(() => {
      store.readJsonl('mixed.json');
    }).toThrow(/already stores JSON/iu);
    expect(() => {
      store.appendJsonl('mixed.json', {value: 'jsonl'});
    }).toThrow(/already stores JSON/iu);
    expect(readFileSync(mixedJsonPath, 'utf8')).toBe(mixedJsonContent);
    expect(store.readJson('mixed.json')).toEqual([
      {value: 'legacy-array-json'},
    ]);
    expect(store.revision()).toBe(1);
  });

  it('treats an untracked path holding JSON null as JSON', () => {
    const storeRoot = createTempRoot();
    const root = pluginRoot(
      storeRoot,
      'session-null-json-legacy',
      'plugin.null-json-legacy',
    );
    const nullJsonPath = join(root, 'mixed.json');
    mkdirSync(root, {recursive: true});
    writeFileSync(nullJsonPath, 'null\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-null-json-legacy',
      pluginId: 'plugin.null-json-legacy',
    });

    // Appending here would turn the document into a JSONL stream and make
    // every later JSON read fail.
    expect(() => {
      store.appendJsonl('mixed.json', {value: 'jsonl'});
    }).toThrow(/already stores JSON/iu);
    expect(readFileSync(nullJsonPath, 'utf8')).toBe('null\n');
  });

  it('preserves untracked .jsonl paths that contain one JSONL record', () => {
    const storeRoot = createTempRoot();
    const root = pluginRoot(
      storeRoot,
      'session-one-record-jsonl-legacy',
      'plugin.one-record-jsonl-legacy',
    );
    const eventsPath = join(root, 'events.jsonl');
    mkdirSync(root, {recursive: true});
    writeFileSync(eventsPath, '{"value":"legacy-jsonl"}\n', 'utf8');

    const firstStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-one-record-jsonl-legacy',
      pluginId: 'plugin.one-record-jsonl-legacy',
    });

    expect(firstStore.readJsonl('events.jsonl')).toEqual([
      {value: 'legacy-jsonl'},
    ]);
    expect(() => {
      firstStore.readJson('events.jsonl');
    }).toThrow(/stores JSONL/iu);

    firstStore.appendJsonl('events.jsonl', {value: 'new-jsonl'});

    expect(readFileSync(eventsPath, 'utf8')).toBe(
      '{"value":"legacy-jsonl"}\n{"value":"new-jsonl"}\n',
    );
    expect(firstStore.revision()).toBe(2);

    const secondStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-one-record-jsonl-legacy',
      pluginId: 'plugin.one-record-jsonl-legacy',
    });

    expect(secondStore.readJsonl('events.jsonl')).toEqual([
      {value: 'legacy-jsonl'},
      {value: 'new-jsonl'},
    ]);
    expect(secondStore.revision()).toBe(2);
  });

  it('rejects JSONL reads and appends on untracked .jsonl paths that store single JSON documents', () => {
    const cases = [
      {
        name: 'array',
        content: '[{"value":"legacy-array-json"}]\n',
      },
      {
        name: 'object',
        content: '{\n"value":"legacy-object-json"\n}\n',
      },
    ];

    for (const {name, content} of cases) {
      const storeRoot = createTempRoot();
      const root = pluginRoot(
        storeRoot,
        `session-mixed-jsonl-${name}-legacy`,
        'plugin.mixed-mode-jsonl-legacy',
      );
      const eventsPath = join(root, 'events.jsonl');
      mkdirSync(root, {recursive: true});
      writeFileSync(eventsPath, content, 'utf8');

      const store = createRuntimePluginFileStore({
        storeRoot,
        sessionId: `session-mixed-jsonl-${name}-legacy`,
        pluginId: 'plugin.mixed-mode-jsonl-legacy',
      });

      expect(() => {
        store.readJsonl('events.jsonl');
      }).toThrow(/already stores JSON/iu);
      expect(() => {
        store.appendJsonl('events.jsonl', {value: 'jsonl'});
      }).toThrow(/already stores JSON/iu);
      expect(readFileSync(eventsPath, 'utf8')).toBe(content);
      expect(store.revision()).toBe(
        content.split('\n').filter(line => line.trim().length > 0).length,
      );
    }
  });

  it('rejects JSON reads and writes on paths that already store JSONL', () => {
    const stores = [
      createRuntimePluginFileStore({
        sessionId: 'session-mixed-jsonl-json-memory',
        sessionIdentity: {},
        pluginId: 'plugin.mixed-mode',
      }),
      createRuntimePluginFileStore({
        storeRoot: createTempRoot(),
        sessionId: 'session-mixed-jsonl-json-durable',
        pluginId: 'plugin.mixed-mode',
      }),
    ];

    for (const store of stores) {
      store.appendJsonl('events.jsonl', {value: 'jsonl'});

      expect(() => {
        store.readJson('events.jsonl');
      }).toThrow(/stores JSONL/iu);
      expect(() => {
        store.writeJsonAtomic('events.jsonl', {value: 'json'});
      }).toThrow(/stores JSONL/iu);
      expect(store.readJsonl('events.jsonl')).toEqual([{value: 'jsonl'}]);
      expect(store.revision()).toBe(1);
    }

    const storeRoot = createTempRoot();
    const firstDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-jsonl-json-reopened',
      pluginId: 'plugin.mixed-mode-reopened',
    });

    firstDurable.appendJsonl('events.jsonl', {value: 'jsonl'});

    const secondDurable = createRuntimePluginFileStore({
      storeRoot,
      sessionId: 'session-mixed-jsonl-json-reopened',
      pluginId: 'plugin.mixed-mode-reopened',
    });

    expect(() => {
      secondDurable.readJson('events.jsonl');
    }).toThrow(/stores JSONL/iu);
    expect(() => {
      secondDurable.writeJsonAtomic('events.jsonl', {value: 'json'});
    }).toThrow(/stores JSONL/iu);
    expect(secondDurable.readJsonl('events.jsonl')).toEqual([{value: 'jsonl'}]);
    expect(secondDurable.revision()).toBe(1);

    const legacyStoreRoot = createTempRoot();
    const legacyRoot = pluginRoot(
      legacyStoreRoot,
      'session-mixed-jsonl-json-legacy',
      'plugin.mixed-mode-legacy',
    );
    const legacyEventsPath = join(legacyRoot, 'events.jsonl');
    const legacyEventsContent =
      '{"value":"legacy-jsonl-1"}\n{"value":"legacy-jsonl-2"}\n';
    mkdirSync(legacyRoot, {recursive: true});
    writeFileSync(legacyEventsPath, legacyEventsContent, 'utf8');

    const legacyDurable = createRuntimePluginFileStore({
      storeRoot: legacyStoreRoot,
      sessionId: 'session-mixed-jsonl-json-legacy',
      pluginId: 'plugin.mixed-mode-legacy',
    });

    expect(() => {
      legacyDurable.readJson('events.jsonl');
    }).toThrow(/stores JSONL/iu);
    expect(() => {
      legacyDurable.writeJsonAtomic('events.jsonl', {value: 'json'});
    }).toThrow(/stores JSONL/iu);
    expect(readFileSync(legacyEventsPath, 'utf8')).toBe(legacyEventsContent);
    expect(legacyDurable.readJsonl('events.jsonl')).toEqual([
      {value: 'legacy-jsonl-1'},
      {value: 'legacy-jsonl-2'},
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
      pluginId,
    });
    const second = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    first.appendJsonl('events.jsonl', {value: 1});

    expect(first.readJsonl('events.jsonl')).toEqual([{value: 1}]);
    expect(second.readJsonl('events.jsonl')).toEqual([{value: 1}]);

    second.appendJsonl('events.jsonl', {value: 2});

    expect(second.readJsonl('events.jsonl')).toEqual([{value: 1}, {value: 2}]);
  });

  it('re-reads durable revisions across existing store instances', () => {
    const options = {
      storeRoot: createTempRoot(),
      sessionId: 'session-revision-race',
      pluginId: 'plugin.revision-race',
    };
    const first = createRuntimePluginFileStore(options);
    const second = createRuntimePluginFileStore(options);

    first.writeJsonAtomic('first.json', {value: 1});
    second.writeJsonAtomic('second.json', {value: 2});

    expect(first.revision()).toBe(2);
    expect(second.revision()).toBe(2);
  });

  it('rejects an exact durable plugin-root symlink without following it', () => {
    const storeRoot = createTempRoot();
    const outsideRoot = createTempRoot();
    const sessionId = 'session-plugin-root-symlink';
    const pluginId = 'plugin.root-symlink';
    const root = pluginRoot(storeRoot, sessionId, pluginId);

    mkdirSync(join(root, '..'), {recursive: true});
    writeFileSync(
      join(outsideRoot, 'sentinel.json'),
      '{"safe":true}\n',
      'utf8',
    );
    symlinkSync(outsideRoot, root, 'dir');

    expect(() =>
      createRuntimePluginFileStore({storeRoot, sessionId, pluginId}),
    ).toThrow(/real directory/iu);
    expect(readFileSync(join(outsideRoot, 'sentinel.json'), 'utf8')).toBe(
      '{"safe":true}\n',
    );
  });

  it('rejects a symlinked plugins ancestor without writing outside the store', () => {
    const storeRoot = createTempRoot();
    const outsideRoot = createTempRoot();
    const sessionId = 'session-plugins-ancestor-symlink';
    const pluginId = 'plugin.plugins-ancestor-symlink';
    const sessionPaths = createLocalRuntimeSessionPaths({storeRoot, sessionId});
    const pluginsRoot = join(sessionPaths.sessionRoot, 'plugins');

    mkdirSync(sessionPaths.sessionRoot, {recursive: true});
    symlinkSync(outsideRoot, pluginsRoot, 'dir');

    expect(() => {
      createRuntimePluginFileStore({
        storeRoot,
        sessionId,
        pluginId,
      }).writeJsonAtomic('state.json', {value: 'escaped'});
    }).toThrow(/symlink/iu);
    expect(() =>
      readFileSync(join(outsideRoot, pluginId, 'state.json'), 'utf8'),
    ).toThrow();
  });

  it('preserves journal temp files whose host ownership is unknown', () => {
    const storeRoot = createTempRoot();
    const sessionId = 'session-foreign-journal-temp';
    const pluginId = 'plugin.foreign-journal-temp';
    const journalRoot = join(
      createLocalRuntimeSessionPaths({storeRoot, sessionId}).sessionRoot,
      '.plugin-transactions',
    );
    const tempPath = join(
      journalRoot,
      '.journal.json.99999999.00000000-0000-4000-8000-000000000000.tmp',
    );

    mkdirSync(journalRoot, {recursive: true});
    writeFileSync(tempPath, '{"foreignHostWrite":true}\n', 'utf8');

    const store = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId,
    });

    expect(store.revision()).toBe(0);
    expect(readFileSync(tempPath, 'utf8')).toBe('{"foreignHostWrite":true}\n');
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
  pluginId: string,
): string {
  return createLocalRuntimePluginPaths({
    storeRoot,
    sessionId,
    pluginId,
  }).pluginRoot;
}

function createProtoKeyValue(): RuntimePluginJsonObject {
  const nested: Record<string, RuntimePluginJsonObject[string]> = {};
  Object.defineProperty(nested, '__proto__', {
    value: 'nested-value',
    enumerable: true,
  });

  const value: Record<string, RuntimePluginJsonObject[string]> = {
    nested,
  };
  Object.defineProperty(value, '__proto__', {
    value: {
      preserved: true,
    },
    enumerable: true,
  });

  return value;
}

function expectProtoKeyValue(value: unknown): void {
  if (!isJsonRecord(value)) {
    throw new Error('Expected plugin file value to be a JSON object.');
  }

  expect(Object.hasOwn(value, '__proto__')).toBe(true);
  expect(value['__proto__']).toEqual({
    preserved: true,
  });
  expect(JSON.stringify(value)).toContain('"__proto__":{"preserved":true}');

  const nested = value['nested'];
  if (!isJsonRecord(nested)) {
    throw new Error('Expected nested plugin file value to be a JSON object.');
  }

  expect(Object.hasOwn(nested, '__proto__')).toBe(true);
  expect(nested['__proto__']).toBe('nested-value');
  expect(JSON.stringify(nested)).toContain('"__proto__":"nested-value"');
}
