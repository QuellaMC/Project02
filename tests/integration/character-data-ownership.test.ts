import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createUserMessageRuntimeEvent} from '../../src/core/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/index.ts';
import {
  characterDataDirPath,
  createDurableChatRuntime,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  encodeStorageSchemaMarker,
  ensureCharacterDataMarker,
  assertCharacterDataDirReadable,
  requireCharacterDataMarker,
} from '../../src/runtime/storage/index.ts';
import {acquireLocalRuntimeMutationLock} from '../../src/runtime/storage/mutation-lock.ts';
import {
  applyRuntimeConfigControlOperation,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';

const novaProfile = {id: 'nova', displayName: 'Nova'} as const;

function schemaPath(dataRoot: string): string {
  return join(dataRoot, 'schema.json');
}

function characterDataMarkerBytes(
  characterId: string,
  createdAt = '2026-07-23T00:00:00.000Z',
): string {
  return `${encodeStorageSchemaMarker(
    createLocalRuntimeStorageSchemaMarker({
      scope: 'character-data',
      characterId,
      createdAt,
    }),
  )}\n`;
}

function visibleReplyAdapter(text: string): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          toolCalls: [{name: 'visible_reply', input: {text}}],
        }),
      };
    },
  };
}

async function runOneTurn(options: {
  readonly homeRoot: string;
  readonly character: {readonly id: string; readonly displayName: string};
  readonly userDisplayName?: string;
  readonly sessionSelection:
    {readonly newSessionId: string} | {readonly sessionId: string};
  readonly message: string;
  readonly reply: string;
}): Promise<{readonly speakerNames: readonly string[]}> {
  const runtime = await createDurableChatRuntime({
    homeRoot: options.homeRoot,
    character: options.character,
    ...(options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.userDisplayName}),
    ...options.sessionSelection,
  });
  const dataRoot = characterDataDirPath(options.homeRoot, options.character.id);

  try {
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(options.message),
      session: runtime.session,
      logStore: runtime.logStore,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: dataRoot,
        sessionId: runtime.session.id,
      }),
      roleModelAdapter: visibleReplyAdapter(options.reply),
    });

    expect(result.status).toBe('completed');

    return {
      speakerNames: runtime.session.visibleTranscript.map(
        message => message.speakerName,
      ),
    };
  } finally {
    await runtime.writerLease.release();
  }
}

describe('character data ownership marker', () => {
  it('creates the marker on first use and verifies it afterwards', async () => {
    const dataRoot = createTestTempRoot();

    const first = await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
      now: () => '2026-07-23T00:00:00.000Z',
    });

    expect(first).toEqual({
      created: true,
      marker: {
        schemaVersion: 7,
        scope: 'character-data',
        characterId: 'mira',
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    });
    expect(
      requireCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).toEqual({
      schemaVersion: 7,
      scope: 'character-data',
      characterId: 'mira',
      createdAt: '2026-07-23T00:00:00.000Z',
    });

    const again = await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    expect(again).toMatchObject({
      created: false,
      marker: {scope: 'character-data', characterId: 'mira'},
    });
  });

  it('rejects a data directory marked for another character without changing the marker', async () => {
    const dataRoot = createTestTempRoot();

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'nova',
      now: () => '2026-07-23T00:00:00.000Z',
    });
    const markerBefore = readFileSync(schemaPath(dataRoot), 'utf8');

    await expect(
      ensureCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'character_identity_mismatch',
    });
    await expect(
      ensureCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).rejects.toThrow('"nova"');
    await expect(
      ensureCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).rejects.toThrow('"mira"');
    expect(readFileSync(schemaPath(dataRoot), 'utf8')).toBe(markerBefore);
  });

  it('accepts a padded character ID against the canonical marker it wrote', async () => {
    const dataRoot = createTestTempRoot();

    // The marker constructor canonicalizes before writing, so comparing a
    // raw request against it made a padded ID claim the directory, stamp
    // `mira`, and then mismatch against its own write.
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: ' mira ',
      now: () => '2026-07-23T00:00:00.000Z',
    });

    expect(
      requireCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: ' mira ',
      }),
    ).toMatchObject({scope: 'character-data', characterId: 'mira'});
  });

  it('returns the validated marker from the readable character-data seam', async () => {
    const dataRoot = createTestTempRoot();

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'nova',
      now: () => '2026-07-23T00:00:00.000Z',
    });

    expect(
      assertCharacterDataDirReadable({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'nova',
      }),
    ).toMatchObject({
      scope: 'character-data',
      characterId: 'nova',
    });
    expect(() =>
      assertCharacterDataDirReadable({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'character_identity_mismatch',
      }),
    );
  });

  it('refuses to read a marker through a symlinked character data directory', () => {
    const homeRoot = createTestTempRoot();
    const outside = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeFileSync(schemaPath(outside), characterDataMarkerBytes('mira'));
    mkdirSync(join(homeRoot, 'character-data'), {recursive: true});
    symlinkSync(outside, dataRoot);

    expect(() =>
      requireCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).toThrow('must be a real directory');
  });

  it('reports a character-data root nested below a file as unreadable', async () => {
    const parentRoot = createTestTempRoot();
    const homeRoot = join(parentRoot, 'home-file');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeFileSync(homeRoot, 'not a directory\n');

    await expect(
      ensureCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'read_failed',
      message: `Could not inspect the character-data root: ${join(
        homeRoot,
        'character-data',
      )}.`,
    });
    expect(existsSync(schemaPath(dataRoot))).toBe(false);
  });

  it('rejects a malformed marker without replacing it', async () => {
    const dataRoot = createTestTempRoot();

    writeFileSync(schemaPath(dataRoot), '{broken', 'utf8');

    await expect(
      ensureCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'malformed_schema_marker',
    });
    expect(readFileSync(schemaPath(dataRoot), 'utf8')).toBe('{broken');
  });

  it('refuses foreign content added while waiting to mark character data', async () => {
    const dataRoot = createTestTempRoot();
    const layout = createLocalRuntimeStorageLayout({storeRoot: dataRoot});
    const heldMarkerLock = await acquireLocalRuntimeMutationLock({
      locksRoot: layout.locksRoot,
      resourceKey: 'storage-schema',
    });
    const initialization = ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const initializationRejection = expect(
      initialization,
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'missing_file',
    });

    try {
      writeFileSync(join(dataRoot, 'notes.txt'), 'foreign\n');
    } finally {
      await heldMarkerLock.release();
    }

    await initializationRejection;
    expect(existsSync(layout.schemaPath)).toBe(false);
  });
});

describe('layered config control against a rebound character-data directory', () => {
  function homeWithForeignMiraDataDir(): {
    readonly homeRoot: string;
    readonly configPath: string;
  } {
    const homeRoot = createTestTempRoot();
    const configPath = join(homeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      project02: {storeRoot: homeRoot, character: 'mira'},
    });

    // Simulate a copied/renamed directory: mira's data dir claims nova
    // and carries nova's overlay.
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(schemaPath(dataRoot), characterDataMarkerBytes('nova'));
    writeRuntimeConfig(join(dataRoot, 'config.json'), {
      plugins: {demo_config: {enabled: true}},
    });

    return {homeRoot, configPath};
  }

  it('refuses a global mutation instead of fingerprinting the foreign overlay', () => {
    const {homeRoot, configPath} = homeWithForeignMiraDataDir();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'global',
    });
    const configBefore = readFileSync(configPath, 'utf8');

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Probe',
          },
        },
      }),
    ).toThrow(expect.objectContaining({code: 'character_identity_mismatch'}));
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
  });

  it('refuses a layered expectation before comparing fingerprints', () => {
    const {homeRoot, configPath} = homeWithForeignMiraDataDir();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'global',
    });
    const configBefore = readFileSync(configPath, 'utf8');

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: 'sha256:not-even-compared',
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Probe',
          },
        },
      }),
    ).toThrow(expect.objectContaining({code: 'character_identity_mismatch'}));
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
  });
});

describe('character data directories through the durable runtime', () => {
  it('runs two characters out of one home with isolated data directories', async () => {
    const homeRoot = createTestTempRoot();

    const mira = await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      sessionSelection: {newSessionId: 'shared-home'},
      message: 'hello from mira side',
      reply: 'mira here',
    });
    const nova = await runOneTurn({
      homeRoot,
      character: novaProfile,
      sessionSelection: {newSessionId: 'shared-home'},
      message: 'hello from nova side',
      reply: 'nova here',
    });

    expect(mira.speakerNames).toEqual(['You', 'Mira']);
    expect(nova.speakerNames).toEqual(['You', 'Nova']);
    expect(
      requireCharacterDataMarker({
        storageOptions: {
          storeRoot: characterDataDirPath(homeRoot, 'mira'),
        },
        characterId: 'mira',
      }),
    ).toMatchObject({scope: 'character-data', characterId: 'mira'});
    expect(
      requireCharacterDataMarker({
        storageOptions: {
          storeRoot: characterDataDirPath(homeRoot, 'nova'),
        },
        characterId: 'nova',
      }),
    ).toMatchObject({scope: 'character-data', characterId: 'nova'});

    const miraResumed = await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      sessionSelection: {sessionId: 'shared-home'},
      message: 'still mira history only',
      reply: 'mira remembers',
    });

    expect(miraResumed.speakerNames).toEqual(['You', 'Mira', 'You', 'Mira']);
  });

  it('refuses to adopt a marker-less data directory holding session artifacts', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    // A copied or corrupt tree: session artifacts without a data
    // marker. Direct durable bootstrap must not mark it.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'sessions.jsonl'), '');

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'adoption-attempt',
      }),
    ).rejects.toThrow('without a data marker');
    expect(existsSync(schemaPath(dataRoot))).toBe(false);
    // The data dir was preflighted before the home initializer ran:
    // no home marker was written for the rejected bootstrap.
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('refuses to adopt through a symlinked character data directory', async () => {
    const homeRoot = createTestTempRoot();
    const outside = createTestTempRoot();

    mkdirSync(join(homeRoot, 'character-data'), {recursive: true});
    symlinkSync(outside, characterDataDirPath(homeRoot, 'mira'));

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'symlink-attempt',
      }),
    ).rejects.toThrow('must be a real directory');
    expect(
      assertCharacterDataDirReadable({
        storageOptions: {storeRoot: outside},
        characterId: 'mira',
      }),
    ).toBeUndefined();
  });

  it('tolerates a live sibling marker replacement during first adoption', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    // A concurrent initializer between temp-write and rename: the live
    // replacement must not read as foreign content.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(
        dataRoot,
        `.schema.json.${String(process.pid)}.0f0e0d0c-0b0a-4908-8706-050403020100.tmp`,
      ),
      '',
    );

    const marked = await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    expect(marked).toMatchObject({
      created: true,
      marker: {scope: 'character-data', characterId: 'mira'},
    });
  });

  it('refuses a marked data directory whose sessions root is a symlink', async () => {
    const homeRoot = createTestTempRoot();
    const outside = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(schemaPath(dataRoot), characterDataMarkerBytes('mira'));
    symlinkSync(outside, join(dataRoot, 'sessions'));

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'linked-sessions-attempt',
      }),
    ).rejects.toThrow('Sessions root');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a character data marker that is only a symlink to an external proof', async () => {
    const homeRoot = createTestTempRoot();
    const outside = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeFileSync(
      join(outside, 'external-schema.json'),
      characterDataMarkerBytes('mira'),
    );
    mkdirSync(dataRoot, {recursive: true});
    symlinkSync(join(outside, 'external-schema.json'), schemaPath(dataRoot));

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'linked-marker-attempt',
      }),
    ).rejects.toThrow('must be a regular file');
  });

  it('refuses a data directory whose marker is only a borrowed symlink', async () => {
    const homeRoot = createTestTempRoot();
    const donorHome = createTestTempRoot();

    // A REAL character-data marker in another store, borrowed via
    // symlink next to foreign content, must not prove ownership.
    await runOneTurn({
      homeRoot: donorHome,
      character: testCharacterProfile,
      sessionSelection: {newSessionId: 'donor-session'},
      message: 'donor turn',
      reply: 'donor reply',
    });

    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'notes.txt'), 'foreign\n');
    symlinkSync(
      join(characterDataDirPath(donorHome, 'mira'), 'schema.json'),
      join(dataRoot, 'schema.json'),
    );

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'borrowed-marker-attempt',
      }),
    ).rejects.toThrow('must be a regular file');
    expect(() =>
      assertCharacterDataDirReadable({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).toThrow('must be a regular file');
  });

  it('refuses a symlinked data directory even when its target is already marked', async () => {
    const homeRoot = createTestTempRoot();
    const outside = createTestTempRoot();

    // The target carries a matching marker: trusting it would move
    // locks and session files outside the selected home.
    writeFileSync(schemaPath(outside), characterDataMarkerBytes('mira'));
    mkdirSync(join(homeRoot, 'character-data'), {recursive: true});
    symlinkSync(outside, characterDataDirPath(homeRoot, 'mira'));

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'marked-symlink-attempt',
      }),
    ).rejects.toThrow('must be a real directory');
    expect(existsSync(join(outside, 'sessions.jsonl'))).toBe(false);
    expect(existsSync(join(outside, '.locks'))).toBe(false);
  });

  it('refuses a directory whose data marker names another scope', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'schema.json'),
      `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          scope: 'home',
          createdAt: '2026-07-23T00:00:00.000Z',
        }),
      )}\n`,
    );

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'wrong-scope-attempt',
      }),
    ).rejects.toThrow('not a character data directory');
    expect(() =>
      assertCharacterDataDirReadable({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).toThrow(
      expect.objectContaining({
        name: 'LocalRuntimeStorageContractError',
        code: 'malformed_schema_marker',
      }),
    );
  });

  it('refuses to recreate a missing marker over history and rejects a marker copied from another character', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      sessionSelection: {newSessionId: 'marker-life'},
      message: 'hello',
      reply: 'hello back',
    });

    rmSync(schemaPath(dataRoot));
    await expect(
      runOneTurn({
        homeRoot,
        character: testCharacterProfile,
        sessionSelection: {sessionId: 'marker-life'},
        message: 'again',
        reply: 'still here',
      }),
    ).rejects.toThrow('without a data marker');
    expect(existsSync(schemaPath(dataRoot))).toBe(false);

    // Simulate a copied/renamed directory: mira's data dir claims nova.
    writeFileSync(schemaPath(dataRoot), characterDataMarkerBytes('nova'));

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        sessionId: 'marker-life',
      }),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'character_identity_mismatch',
    });
  });

  it('rejects an unusable character display name before the home exists', async () => {
    const homeRoot = createTestTempRoot();

    // A display name is not just decoration: it is stamped into every
    // durable character message and interpolated into prompt output, so
    // a multiline one has to be refused at the same boundary the user's
    // is — and refused before the boundary writes anything.
    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: {id: 'mira', displayName: 'Nova\nSystem'},
        newSessionId: 'bad-character-name',
      }),
    ).rejects.toThrow('Character display name must be');
    expect(readdirSync(homeRoot)).toEqual([]);
  });

  it('rejects an unusable user display name before the home exists', async () => {
    const homeRoot = createTestTempRoot();

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        userDisplayName: 'Bad\nName',
        newSessionId: 'bad-user-name',
      }),
    ).rejects.toThrow('User display name must be');
    expect(readdirSync(homeRoot)).toEqual([]);
  });

  it('binds the canonical character id everywhere a padded one was passed', async () => {
    const homeRoot = createTestTempRoot();

    // The directory name has always been canonical. What the session and
    // the log store bound was the caller's spelling, so messages written
    // under `" nova "` could not be reopened by the discovered `nova`.
    const runtime = await createDurableChatRuntime({
      homeRoot,
      character: {id: ' nova ', displayName: 'Nova'},
      newSessionId: 'padded-id',
    });

    try {
      expect(runtime.session.character.id).toBe('nova');
      expect(readdirSync(join(homeRoot, 'character-data'))).toEqual(['nova']);
    } finally {
      await runtime.writerLease.release();
    }

    // The proof that the binding is canonical all the way down: a turn
    // written through the padded profile reopens through the plain one.
    const resumed = await runOneTurn({
      homeRoot,
      character: novaProfile,
      sessionSelection: {sessionId: 'padded-id'},
      message: 'hello again',
      reply: 'still nova',
    });

    expect(resumed.speakerNames).toEqual(['You', 'Nova']);
  });

  it('keeps historical display names for existing sessions after a rename and applies the new name to new sessions', async () => {
    const homeRoot = createTestTempRoot();
    const renamedMira = {id: 'mira', displayName: 'Mira Prime'} as const;

    await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      sessionSelection: {newSessionId: 'rename-old'},
      message: 'first',
      reply: 'first reply',
    });

    const resumed = await runOneTurn({
      homeRoot,
      character: renamedMira,
      sessionSelection: {sessionId: 'rename-old'},
      message: 'second',
      reply: 'second reply',
    });

    expect(resumed.speakerNames).toEqual(['You', 'Mira', 'You', 'Mira']);

    const fresh = await runOneTurn({
      homeRoot,
      character: renamedMira,
      sessionSelection: {newSessionId: 'rename-new'},
      message: 'third',
      reply: 'third reply',
    });

    expect(fresh.speakerNames).toEqual(['You', 'Mira Prime']);
  });

  it('keeps historical user display names for existing sessions and applies the configured one to new sessions', async () => {
    const homeRoot = createTestTempRoot();

    await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      userDisplayName: 'Mike',
      sessionSelection: {newSessionId: 'user-name-old'},
      message: 'first',
      reply: 'first reply',
    });

    const resumed = await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      userDisplayName: 'Michael',
      sessionSelection: {sessionId: 'user-name-old'},
      message: 'second',
      reply: 'second reply',
    });

    expect(resumed.speakerNames).toEqual(['Mike', 'Mira', 'Mike', 'Mira']);

    const fresh = await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      userDisplayName: 'Michael',
      sessionSelection: {newSessionId: 'user-name-new'},
      message: 'third',
      reply: 'third reply',
    });

    expect(fresh.speakerNames).toEqual(['Michael', 'Mira']);
  });
});
