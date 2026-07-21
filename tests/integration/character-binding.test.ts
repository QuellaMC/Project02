import {readFileSync, rmSync, writeFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createUserMessageRuntimeEvent} from '../../src/core/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/index.ts';
import {
  characterBindingPath,
  createDurableChatRuntime,
  readCharacterBinding,
  reconcileCharacterBinding,
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
  readonly storeRoot: string;
  readonly character: {readonly id: string; readonly displayName: string};
  readonly sessionSelection:
    {readonly newSessionId: string} | {readonly sessionId: string};
  readonly message: string;
  readonly reply: string;
}): Promise<{readonly speakerNames: readonly string[]}> {
  const runtime = await createDurableChatRuntime({
    storeRoot: options.storeRoot,
    character: options.character,
    ...options.sessionSelection,
  });

  try {
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(options.message),
      session: runtime.session,
      logStore: runtime.logStore,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: options.storeRoot,
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

describe('character binding decision table', () => {
  it('binds a fresh store to the configured character and never rebinds', async () => {
    const storeRoot = createTestTempRoot();

    const first = await reconcileCharacterBinding({
      storageOptions: {storeRoot},
      configuredCharacterId: 'mira',
      deriveStoreCharacterIds: () => Promise.resolve([]),
    });

    expect(first).toMatchObject({
      status: 'bound',
      characterId: 'mira',
      adopted: 'fresh_store',
    });
    expect(readCharacterBinding({storeRoot})).toMatchObject({
      status: 'bound',
      binding: {
        format: 'project02.character-binding.v1',
        characterId: 'mira',
      },
    });

    const again = await reconcileCharacterBinding({
      storageOptions: {storeRoot},
      configuredCharacterId: 'mira',
      deriveStoreCharacterIds: () => Promise.resolve([]),
    });

    expect(again).toMatchObject({status: 'bound', adopted: 'already_bound'});
  });

  it('rejects a configured character that differs from the permanent binding, naming both ids and the recovery paths', async () => {
    const storeRoot = createTestTempRoot();

    await reconcileCharacterBinding({
      storageOptions: {storeRoot},
      configuredCharacterId: 'nova',
      deriveStoreCharacterIds: () => Promise.resolve([]),
    });
    const bindingBefore = readFileSync(
      characterBindingPath({storeRoot}),
      'utf8',
    );
    const rejected = await reconcileCharacterBinding({
      storageOptions: {storeRoot},
      configuredCharacterId: 'mira',
      deriveStoreCharacterIds: () => Promise.resolve([]),
    });

    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') {
      throw new Error('Expected rejected reconcile.');
    }

    expect(rejected.code).toBe('character_binding_mismatch');
    expect(rejected.message).toContain('"nova"');
    expect(rejected.message).toContain('"mira"');
    expect(rejected.message).toContain('Set project02.character back to');
    expect(rejected.message).toContain('project02.storeRoot');
    expect(readFileSync(characterBindingPath({storeRoot}), 'utf8')).toBe(
      bindingBefore,
    );
  });

  it('rejects adopting a legacy store whose history belongs to another character', async () => {
    const storeRoot = createTestTempRoot();

    const rejected = await reconcileCharacterBinding({
      storageOptions: {storeRoot},
      configuredCharacterId: 'mira',
      deriveStoreCharacterIds: () => Promise.resolve(['nova']),
    });

    expect(rejected).toMatchObject({
      status: 'rejected',
      code: 'store_character_mismatch',
    });
    if (rejected.status !== 'rejected') {
      throw new Error('Expected rejected reconcile.');
    }

    expect(rejected.message).toContain('"nova"');
    expect(rejected.message).toContain('"mira"');
    expect(readCharacterBinding({storeRoot})).toMatchObject({
      status: 'absent',
    });
  });

  it('adopts a legacy store whose history matches the configured character', async () => {
    const storeRoot = createTestTempRoot();

    const adopted = await reconcileCharacterBinding({
      storageOptions: {storeRoot},
      configuredCharacterId: 'mira',
      deriveStoreCharacterIds: () => Promise.resolve(['mira']),
    });

    expect(adopted).toMatchObject({
      status: 'bound',
      adopted: 'existing_history',
    });
  });

  it('rejects a malformed binding file with the path, format, and restore guidance', async () => {
    const storeRoot = createTestTempRoot();

    writeFileSync(characterBindingPath({storeRoot}), '{broken', 'utf8');

    const rejected = await reconcileCharacterBinding({
      storageOptions: {storeRoot},
      configuredCharacterId: 'mira',
      deriveStoreCharacterIds: () => Promise.resolve([]),
    });

    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') {
      throw new Error('Expected rejected reconcile.');
    }

    expect(rejected.code).toBe('character_binding_malformed');
    expect(rejected.message).toContain(characterBindingPath({storeRoot}));
    expect(rejected.message).toContain('project02.character-binding.v1');
    expect(rejected.message).toContain('Restore it from backup');
  });
});

describe('character binding through the durable runtime', () => {
  it('binds on first activation, adopts legacy mira history, and blocks a different character', async () => {
    const storeRoot = createTestTempRoot();

    await runOneTurn({
      storeRoot,
      character: testCharacterProfile,
      sessionSelection: {newSessionId: 'binding-e2e'},
      message: 'hello',
      reply: 'hello back',
    });
    expect(readCharacterBinding({storeRoot})).toMatchObject({
      status: 'bound',
      binding: {characterId: 'mira'},
    });

    // Legacy adoption: remove the binding; the store's own history rebinds it.
    rmSync(characterBindingPath({storeRoot}));
    await runOneTurn({
      storeRoot,
      character: testCharacterProfile,
      sessionSelection: {sessionId: 'binding-e2e'},
      message: 'again',
      reply: 'still here',
    });
    expect(readCharacterBinding({storeRoot})).toMatchObject({
      status: 'bound',
      binding: {characterId: 'mira'},
    });

    await expect(
      createDurableChatRuntime({
        storeRoot,
        character: novaProfile,
        newSessionId: 'nova-session',
      }),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'character_binding_rejected',
    });
  });

  it('keeps historical display names for existing sessions after a rename and applies the new name to new sessions', async () => {
    const storeRoot = createTestTempRoot();
    const renamedMira = {id: 'mira', displayName: 'Mira Prime'} as const;

    await runOneTurn({
      storeRoot,
      character: testCharacterProfile,
      sessionSelection: {newSessionId: 'rename-old'},
      message: 'first',
      reply: 'first reply',
    });

    const resumed = await runOneTurn({
      storeRoot,
      character: renamedMira,
      sessionSelection: {sessionId: 'rename-old'},
      message: 'second',
      reply: 'second reply',
    });

    expect(resumed.speakerNames).toEqual(['You', 'Mira', 'You', 'Mira']);

    const fresh = await runOneTurn({
      storeRoot,
      character: renamedMira,
      sessionSelection: {newSessionId: 'rename-new'},
      message: 'third',
      reply: 'third reply',
    });

    expect(fresh.speakerNames).toEqual(['You', 'Mira Prime']);
  });
});
