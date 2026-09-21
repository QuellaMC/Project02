import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  createGatewayClient,
  type GatewayClient,
} from '../../src/gateway/client/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {characterOverlayConfigPath} from '../../src/runtime/config/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {spawnDaemon} from '../support/spawn-daemon.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {readCharacterConversation} from '../support/conversation-fixtures.ts';

function seedNovaPackage(homeRoot: string): void {
  const packageRoot = join(homeRoot, 'characters', 'nova');

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    `${JSON.stringify(
      {
        format: 'project02.character.v1',
        identity: {id: 'nova', displayName: 'Nova'},
        persona: {system: ['You are Nova, a fixture character.']},
        meta: {version: '1.0.0'},
      },
      null,
      2,
    )}\n`,
  );
}

/** A real serve process on this home, with a client on its address. */
async function spawnServe(homeRoot: string) {
  const daemon = await spawnDaemon('src/cli/serve/main.ts', [
    '--store',
    homeRoot,
    '--init',
  ]);

  return {client: createGatewayClient({url: daemon.url}), stop: daemon.stop};
}

async function chat(
  client: GatewayClient,
  characterId: string,
  text: string,
): Promise<string> {
  const opened = await client.openDirectConversation(characterId);

  if (opened.status !== 'opened') {
    throw new Error(opened.message);
  }

  const outcome = await client.deliver({
    conversationId: opened.conversationId,
    senderId: opened.userParticipantId,
    text,
    source: 'test',
    clientMessageId: `${characterId}-1`,
  });

  if (outcome.status !== 'completed') {
    throw new Error(outcome.message);
  }

  return outcome.messages.at(-1)?.speakerName ?? '';
}

async function snapshotDurableFiles(
  root: string,
  relativeRoot = '',
): Promise<Readonly<Record<string, string>>> {
  const directoryPath =
    relativeRoot.length === 0 ? root : join(root, relativeRoot);
  const entries = await readdir(directoryPath, {withFileTypes: true});
  const snapshot: Record<string, string> = {};

  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relativePath =
      relativeRoot.length === 0 ? entry.name : join(relativeRoot, entry.name);

    if (relativePath === '.locks' || relativePath.startsWith('.locks/')) {
      continue;
    }

    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotDurableFiles(root, relativePath));
      continue;
    }

    if (entry.isFile()) {
      snapshot[relativePath] = await readFile(join(root, relativePath), 'utf8');
    }
  }

  return snapshot;
}

describe('two characters from one home', () => {
  it('chats concurrently with isolated data directories and locks', async () => {
    const homeRoot = createTestTempRoot('project02-two-characters-');

    seedNovaPackage(homeRoot);
    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const daemon = await spawnServe(homeRoot);

    try {
      const [mira, nova] = await Promise.all([
        chat(daemon.client, 'mira', 'hello from the mira terminal'),
        chat(daemon.client, 'nova', 'hello from the nova terminal'),
      ]);

      expect(mira).toBe('Mira');
      expect(nova).toBe('Nova');
    } finally {
      const stopped = await daemon.stop();

      expect(stopped.code, stopped.stderr).toBe(0);
      expect(stopped.stderr).not.toContain('busy');
    }

    // Leases are released on clean exit; per-segment locks stay in each
    // character's own lock root, while the home holds the conversation locks.
    for (const characterId of ['mira', 'nova']) {
      const dataRoot = characterDataDirPath(homeRoot, characterId);
      const dm = await readCharacterConversation(homeRoot, characterId);

      expect(dm.latestSessionId.endsWith('.1')).toBe(true);
      expect(existsSync(dm.latestSessionPaths.sessionRoot)).toBe(true);
      expect(existsSync(join(dataRoot, '.locks'))).toBe(true);
    }
    expect(
      existsSync(join(homeRoot, '.locks')) &&
        readdirSync(join(homeRoot, '.locks')).some(name =>
          name.includes('session-writer'),
        ),
    ).toBe(false);
    expect(
      JSON.parse(
        readFileSync(
          characterOverlayConfigPath(characterDataDirPath(homeRoot, 'mira')),
          'utf8',
        ),
      ),
    ).toEqual({
      version: 'project02.config.v2',
      plugins: {'character-state': {enabled: true}},
    });
    expect(
      JSON.parse(
        readFileSync(
          characterOverlayConfigPath(characterDataDirPath(homeRoot, 'nova')),
          'utf8',
        ),
      ),
    ).toEqual({version: 'project02.config.v2'});
    expect(
      JSON.parse(readFileSync(join(homeRoot, 'config.json'), 'utf8')),
    ).toEqual({version: 'project02.config.v2'});
  }, 60_000);

  it('refuses a second daemon the conversation the first holds, without a durable write', async () => {
    const homeRoot = createTestTempRoot('project02-same-character-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const first = await spawnServe(homeRoot);

    try {
      await chat(first.client, 'mira', 'hello from the first daemon');

      const before = await snapshotDurableFiles(homeRoot);
      const second = await spawnServe(homeRoot);

      try {
        await expect(
          second.client.openDirectConversation('mira'),
        ).resolves.toMatchObject({
          status: 'refused',
          reason: 'conversation_busy',
        });
        expect(await snapshotDurableFiles(homeRoot)).toEqual(before);
      } finally {
        expect((await second.stop()).code).toBe(0);
      }
    } finally {
      expect((await first.stop()).code).toBe(0);
    }
  }, 60_000);
});
