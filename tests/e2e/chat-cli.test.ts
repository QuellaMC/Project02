import {join} from 'node:path';
import {Readable} from 'node:stream';

import {describe, expect, it} from 'vitest';

import {runChatCliFromArgs} from '../../src/cli/chat/main.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {writeTestCharacterPackage} from '../support/character-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function replyAdapter(rawOutputText?: string): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText:
          rawOutputText ??
          JSON.stringify({
            toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
          }),
      };
    },
  };
}

async function runChat(
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly rawOutputText?: string;
  } = {},
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = '';
  let stderr = '';

  const exitCode = await runChatCliFromArgs(args, {
    stdin: Readable.from([options.input ?? 'hello there\n/exit\n']),
    stdout: collect(chunk => {
      stdout += chunk;
    }),
    stderr: collect(chunk => {
      stderr += chunk;
    }),
    env: {},
    pluginHost: createRuntimePluginHost({plugins: []}),
    roleModelAdapter: replyAdapter(options.rawOutputText),
  });

  return {exitCode, stdout, stderr};
}

describe('chat shim', () => {
  it('chats end to end over the gateway and exits cleanly', async () => {
    const storeRoot = createTestTempRoot('project02-chat-shim-');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const {exitCode, stdout, stderr} = await runChat(['--store', storeRoot]);

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('mira is ready.');
    expect(stdout).toContain('Mira: noted');
  });

  it('demands an explicit pick when several characters are enabled, then honors it', async () => {
    const storeRoot = createTestTempRoot('project02-chat-shim-pick-');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    writeTestCharacterPackage(storeRoot, {id: 'zeta', displayName: 'Zeta'});

    const ambiguous = await runChat(['--store', storeRoot]);

    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain(
      'Several characters are enabled: mira, zeta.',
    );
    expect(ambiguous.stderr).toContain('--character');

    const picked = await runChat(['--store', storeRoot, '--character', 'zeta']);

    expect(picked.exitCode).toBe(0);
    expect(picked.stdout).toContain('Zeta: noted');
  });

  it('rejects an unknown explicit character naming the discovered ids', async () => {
    const storeRoot = createTestTempRoot('project02-chat-shim-unknown-');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const {exitCode, stderr} = await runChat([
      '--store',
      storeRoot,
      '--character',
      'ghost',
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Character "ghost" was not found');
    expect(stderr).toContain('mira');
  });

  it('reports a rejected turn and keeps the session alive', async () => {
    const storeRoot = createTestTempRoot('project02-chat-shim-rejected-');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const {exitCode, stdout, stderr} = await runChat(['--store', storeRoot], {
      rawOutputText: 'not json at all',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('mira is ready.');
    expect(stderr).toContain('Error:');
  });
});
