import {
  mkdirSync,
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
  characterBindingPath,
  characterDataDirPath,
  createDurableChatRuntime,
  createLocalRuntimeStorageSchemaMarker,
  encodeStorageSchemaMarker,
  ensureCharacterDataStamp,
  readCharacterBinding,
} from '../../src/runtime/storage/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';

const novaProfile = {id: 'nova', displayName: 'Nova'} as const;

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

describe('character data stamp', () => {
  it('creates the stamp on first use and verifies it afterwards', async () => {
    const dataRoot = createTestTempRoot();

    const first = await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    expect(first).toMatchObject({
      status: 'stamped',
      characterId: 'mira',
      created: true,
    });
    expect(readCharacterBinding({storeRoot: dataRoot})).toMatchObject({
      status: 'bound',
      binding: {
        format: 'project02.character-binding.v1',
        characterId: 'mira',
      },
    });

    const again = await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    expect(again).toMatchObject({status: 'stamped', created: false});
  });

  it('rejects a data directory stamped for another character, naming both ids and the recovery', async () => {
    const dataRoot = createTestTempRoot();

    await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'nova',
    });
    const stampBefore = readFileSync(
      characterBindingPath({storeRoot: dataRoot}),
      'utf8',
    );
    const rejected = await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') {
      throw new Error('Expected rejected stamp.');
    }

    expect(rejected.code).toBe('character_binding_mismatch');
    expect(rejected.message).toContain('"nova"');
    expect(rejected.message).toContain('"mira"');
    expect(rejected.message).toContain('Select character "nova"');
    expect(
      readFileSync(characterBindingPath({storeRoot: dataRoot}), 'utf8'),
    ).toBe(stampBefore);
  });

  it('rejects a malformed stamp with the path, format, and restore guidance', async () => {
    const dataRoot = createTestTempRoot();

    writeFileSync(
      characterBindingPath({storeRoot: dataRoot}),
      '{broken',
      'utf8',
    );

    const rejected = await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') {
      throw new Error('Expected rejected stamp.');
    }

    expect(rejected.code).toBe('character_binding_malformed');
    expect(rejected.message).toContain(
      characterBindingPath({storeRoot: dataRoot}),
    );
    expect(rejected.message).toContain('project02.character-binding.v1');
    expect(rejected.message).toContain('Restore it from backup');
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
      readCharacterBinding({
        storeRoot: characterDataDirPath(homeRoot, 'mira'),
      }),
    ).toMatchObject({status: 'bound', binding: {characterId: 'mira'}});
    expect(
      readCharacterBinding({
        storeRoot: characterDataDirPath(homeRoot, 'nova'),
      }),
    ).toMatchObject({status: 'bound', binding: {characterId: 'nova'}});

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
    // marker. Direct durable bootstrap must not stamp it.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'sessions.jsonl'), '');

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        newSessionId: 'adoption-attempt',
      }),
    ).rejects.toThrow('without a data marker');
    expect(readCharacterBinding({storeRoot: dataRoot})).toEqual({
      status: 'absent',
    });
  });

  it('refuses to bind through a symlinked character data directory', async () => {
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
    ).rejects.toThrow('is a symlink');
    expect(readCharacterBinding({storeRoot: outside})).toEqual({
      status: 'absent',
    });
  });

  it('refuses to bind a directory whose data marker names another scope', async () => {
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
    expect(readCharacterBinding({storeRoot: dataRoot})).toEqual({
      status: 'absent',
    });
  });

  it('recreates a missing stamp and rejects a tampered one', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      sessionSelection: {newSessionId: 'stamp-life'},
      message: 'hello',
      reply: 'hello back',
    });

    rmSync(characterBindingPath({storeRoot: dataRoot}));
    await runOneTurn({
      homeRoot,
      character: testCharacterProfile,
      sessionSelection: {sessionId: 'stamp-life'},
      message: 'again',
      reply: 'still here',
    });
    expect(readCharacterBinding({storeRoot: dataRoot})).toMatchObject({
      status: 'bound',
      binding: {characterId: 'mira'},
    });

    // Simulate a copied/renamed directory: mira's data dir claims nova.
    writeFileSync(
      characterBindingPath({storeRoot: dataRoot}),
      `${JSON.stringify(
        {
          format: 'project02.character-binding.v1',
          characterId: 'nova',
          boundAt: '2026-07-22T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await expect(
      createDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        sessionId: 'stamp-life',
      }),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'character_binding_rejected',
    });
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
