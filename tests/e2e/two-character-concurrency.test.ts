import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {characterOverlayConfigPath} from '../../src/runtime/config/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

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

function spawnCharacterChat(
  homeRoot: string,
  characterId: string,
  newSessionId: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      'src/cli/chat/main.ts',
      '--store',
      homeRoot,
      '--character',
      characterId,
      '--new-session',
      newSessionId,
    ],
    {cwd: process.cwd(), stdio: 'pipe'},
  );
}

async function runOneMessageChat(
  child: ChildProcessWithoutNullStreams,
  message: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return await new Promise((resolveExit, rejectExit) => {
    let stdout = '';
    let stderr = '';
    let sent = false;
    // Generous on purpose: loaded CI runners take seconds just to cold-start
    // the child Node process.
    const timeout = setTimeout(() => {
      child.kill();
      rejectExit(new Error(`Timed out waiting for chat: ${stdout}${stderr}`));
    }, 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;

      if (!sent && stdout.includes('is ready.')) {
        sent = true;
        child.stdin.write(`${message}\n/exit\n`);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', error => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      resolveExit({code, stdout, stderr});
    });
  });
}

describe('two characters from one home', () => {
  it('chats concurrently with isolated data directories and locks', async () => {
    const homeRoot = createTestTempRoot('project02-two-characters-');

    seedNovaPackage(homeRoot);
    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const [mira, nova] = await Promise.all([
      runOneMessageChat(
        spawnCharacterChat(homeRoot, 'mira', 'shared-session-id'),
        'hello from the mira terminal',
      ),
      runOneMessageChat(
        spawnCharacterChat(homeRoot, 'nova', 'shared-session-id'),
        'hello from the nova terminal',
      ),
    ]);

    expect(mira.code, mira.stderr).toBe(0);
    expect(nova.code, nova.stderr).toBe(0);
    expect(mira.stdout).toContain('Mira:');
    expect(nova.stdout).toContain('Nova:');
    expect(`${mira.stderr}${nova.stderr}`).not.toContain('busy');

    // Leases are released on clean exit, and the home lock root never hosts
    // session locks.
    for (const characterId of ['mira', 'nova']) {
      const dataRoot = characterDataDirPath(homeRoot, characterId);

      expect(existsSync(join(dataRoot, 'sessions', 'shared-session-id'))).toBe(
        true,
      );
      expect(existsSync(join(dataRoot, '.locks'))).toBe(true);
    }
    expect(
      existsSync(join(homeRoot, '.locks')) &&
        readdirSync(join(homeRoot, '.locks')).some(name =>
          name.includes('session'),
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

  it('still lease-blocks a same-character double start', async () => {
    const homeRoot = createTestTempRoot('project02-same-character-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const first = spawnCharacterChat(homeRoot, 'mira', 'contended');
    const firstReady = new Promise<void>((resolveReady, rejectReady) => {
      let stdout = '';
      const timeout = setTimeout(() => {
        rejectReady(new Error(`Timed out waiting for readiness: ${stdout}`));
      }, 30_000);

      first.stdout.setEncoding('utf8');
      first.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('is ready.')) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
      first.once('exit', () => {
        clearTimeout(timeout);
        rejectReady(new Error(`Chat exited before readiness: ${stdout}`));
      });
    });

    try {
      await firstReady;

      const second = spawn(
        process.execPath,
        [
          'src/cli/chat/main.ts',
          '--store',
          homeRoot,
          '--character',
          'mira',
          '--session',
          'contended',
        ],
        {cwd: process.cwd(), stdio: 'pipe'},
      );
      const contended = await new Promise<{
        readonly code: number | null;
        readonly stderr: string;
      }>((resolveExit, rejectExit) => {
        let stderr = '';

        second.stderr.setEncoding('utf8');
        second.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        second.once('error', rejectExit);
        second.once('exit', code => {
          resolveExit({code, stderr});
        });
      });

      expect(contended.code).toBe(1);
      expect(contended.stderr).toContain('session');
    } finally {
      if (first.exitCode === null) {
        first.kill();
      }
    }
  }, 60_000);
});
