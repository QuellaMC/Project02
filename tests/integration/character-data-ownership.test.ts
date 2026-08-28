import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {localRuntimeStorageSchemaVersion} from '../../src/runtime/storage/layout-contract.ts';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createUserMessageRuntimeEvent} from '../../src/core/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/index.ts';
import {openConversation} from '../../src/runtime/index.ts';
import {
  characterDataDirPath,
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
  readonly message: string;
  readonly reply: string;
}): Promise<{readonly speakerNames: readonly string[]}> {
  const conversation = await openConversation({
    homeRoot: options.homeRoot,
    character: options.character,
    ...(options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.userDisplayName}),
  });
  const dataRoot = characterDataDirPath(options.homeRoot, options.character.id);

  try {
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(options.message),
      session: conversation.session,
      logStore: conversation.logStore,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: dataRoot,
        sessionId: conversation.session.id,
      }),
      roleModelAdapter: visibleReplyAdapter(options.reply),
    });

    expect(result.status).toBe('completed');

    return {
      speakerNames: conversation.session.visibleTranscript.map(
        message => message.speakerName,
      ),
    };
  } finally {
    await conversation.close();
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
        schemaVersion: localRuntimeStorageSchemaVersion,
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
      schemaVersion: localRuntimeStorageSchemaVersion,
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

    // The marker constructor canonicalizes before writing, so a padded ID
    // compared raw used to mismatch against its own write.
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

    // A copied directory: mira's data dir claims nova and carries nova's
    // overlay.
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
        pluginManifests: [],
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
        pluginManifests: [],
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
      message: 'hello from mira side',
      reply: 'mira here',
    });
    const nova = await runOneTurn({
      homeRoot,
      character: novaProfile,
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
      message: 'still mira history only',
      reply: 'mira remembers',
    });

    expect(miraResumed.speakerNames).toEqual(['You', 'Mira', 'You', 'Mira']);
  });

  it('refuses to adopt a marker-less data directory holding session artifacts', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    // A copied or corrupt tree: session artifacts without a data marker.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'sessions.jsonl'), '');

    await expect(
      openConversation({
        homeRoot,
        character: testCharacterProfile,
      }),
    ).rejects.toThrow('without a data marker');
    expect(existsSync(schemaPath(dataRoot))).toBe(false);
    // The data dir was preflighted before the home initializer ran.
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('refuses to adopt through a symlinked character data directory', async () => {
    const homeRoot = createTestTempRoot();
    const outside = createTestTempRoot();

    mkdirSync(join(homeRoot, 'character-data'), {recursive: true});
    symlinkSync(outside, characterDataDirPath(homeRoot, 'mira'));

    await expect(
      openConversation({
        homeRoot,
        character: testCharacterProfile,
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

    // A concurrent initializer caught between temp-write and rename.
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
      openConversation({
        homeRoot,
        character: testCharacterProfile,
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
      openConversation({
        homeRoot,
        character: testCharacterProfile,
      }),
    ).rejects.toThrow('must be a regular file');
  });

  it('refuses a data directory whose marker is only a borrowed symlink', async () => {
    const homeRoot = createTestTempRoot();
    const donorHome = createTestTempRoot();

    // The donor turn produces a real marker in another store, which the
    // symlink below borrows.
    await runOneTurn({
      homeRoot: donorHome,
      character: testCharacterProfile,
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
      openConversation({
        homeRoot,
        character: testCharacterProfile,
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

    // The target carries a matching marker, so only the link is wrong.
    writeFileSync(schemaPath(outside), characterDataMarkerBytes('mira'));
    mkdirSync(join(homeRoot, 'character-data'), {recursive: true});
    symlinkSync(outside, characterDataDirPath(homeRoot, 'mira'));

    await expect(
      openConversation({
        homeRoot,
        character: testCharacterProfile,
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
      openConversation({
        homeRoot,
        character: testCharacterProfile,
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
      message: 'hello',
      reply: 'hello back',
    });

    rmSync(schemaPath(dataRoot));
    await expect(
      runOneTurn({
        homeRoot,
        character: testCharacterProfile,
        message: 'again',
        reply: 'still here',
      }),
    ).rejects.toThrow('without a data marker');
    expect(existsSync(schemaPath(dataRoot))).toBe(false);

    // A copied directory: mira's data dir claims nova.
    writeFileSync(schemaPath(dataRoot), characterDataMarkerBytes('nova'));

    await expect(
      openConversation({
        homeRoot,
        character: testCharacterProfile,
      }),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'character_identity_mismatch',
    });
  });

  it('rejects an unusable character display name before the home exists', async () => {
    const homeRoot = createTestTempRoot();

    // The name is stamped into every durable character message and into prompt
    // output, so it is judged at the same boundary the user's name is.
    await expect(
      openConversation({
        homeRoot,
        character: {id: 'mira', displayName: 'Nova\nSystem'},
      }),
    ).rejects.toThrow('Character display name must be');
    expect(readdirSync(homeRoot)).toEqual([]);
  });

  it('rejects an unusable user display name before the home exists', async () => {
    const homeRoot = createTestTempRoot();

    await expect(
      openConversation({
        homeRoot,
        character: testCharacterProfile,
        userDisplayName: 'Bad\nName',
      }),
    ).rejects.toThrow('User display name must be');
    expect(readdirSync(homeRoot)).toEqual([]);
  });

  it('binds the canonical character id everywhere a padded one was passed', async () => {
    const homeRoot = createTestTempRoot();

    // The directory name is canonical, but the session and log store bound the
    // caller's spelling, so `" nova "` could not be reopened as `nova`.
    const conversation = await openConversation({
      homeRoot,
      character: {id: ' nova ', displayName: 'Nova'},
    });

    try {
      expect(conversation.session.character.id).toBe('nova');
      expect(readdirSync(join(homeRoot, 'character-data'))).toEqual(['nova']);
    } finally {
      await conversation.close();
    }

    // A turn written through the padded profile reopens through the plain one.
    const resumed = await runOneTurn({
      homeRoot,
      character: novaProfile,
      message: 'hello again',
      reply: 'still nova',
    });

    expect(resumed.speakerNames).toEqual(['You', 'Nova']);
  });

  it('keeps historical display names when a renamed character resumes its conversation', async () => {
    const homeRoot = createTestTempRoot();
    const renamedMira = {id: 'mira', displayName: 'Mira Prime'} as const;

    await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      message: 'first',
      reply: 'first reply',
    });

    // A rename never rewrites history: the resumed segment keeps the name
    // its messages were committed under. The new name applies from the next
    // evidence-empty segment.
    const resumed = await runOneTurn({
      homeRoot,
      character: renamedMira,
      message: 'second',
      reply: 'second reply',
    });

    expect(resumed.speakerNames).toEqual(['You', 'Mira', 'You', 'Mira']);
  });

  it('keeps historical user display names when a renamed user resumes a conversation', async () => {
    const homeRoot = createTestTempRoot();

    await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      userDisplayName: 'Mike',
      message: 'first',
      reply: 'first reply',
    });

    const resumed = await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      userDisplayName: 'Michael',
      message: 'second',
      reply: 'second reply',
    });

    expect(resumed.speakerNames).toEqual(['Mike', 'Mira', 'Mike', 'Mira']);
  });
});
