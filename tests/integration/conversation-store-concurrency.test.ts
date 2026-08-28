import {spawn} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createProject02HomeLayout} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('local runtime conversation catalog concurrency', () => {
  it('yields one conversation when child processes race the same set', async () => {
    const homeRoot = join(
      createTestTempRoot('project02-conversation-race-'),
      'home',
    );
    const results = await Promise.all(
      Array.from(
        {length: 12},
        async () => await ensureConversationInChildProcess(homeRoot),
      ),
    );
    const ids = new Set(results.map(result => result.id));

    expect(ids.size).toBe(1);

    const layout = createProject02HomeLayout({homeRoot});
    const directories = readdirSync(layout.conversationsRoot).filter(
      name => name !== '.DS_Store',
    );

    expect(directories).toEqual([...ids]);
  }, 30_000);
});

type ChildEnsureResult = {readonly id: string};

async function ensureConversationInChildProcess(
  homeRoot: string,
): Promise<ChildEnsureResult> {
  const script = [
    "import { createLocalRuntimeConversationStore } from './src/runtime/storage/conversation-store.ts';",
    'const conversation = await createLocalRuntimeConversationStore({ homeRoot: process.argv[1] }).ensureConversationWith([',
    "  { kind: 'user', id: 'local-user', displayName: 'You' },",
    "  { kind: 'character', id: 'mira', displayName: 'Mira' },",
    ']);',
    'process.stdout.write(JSON.stringify({ id: conversation.id }));',
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', script, homeRoot],
    {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']},
  );

  return await new Promise<ChildEnsureResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) {
        reject(
          new Error(`Conversation child exited ${String(code)}: ${stderr}`),
        );
        return;
      }

      resolve(JSON.parse(stdout) as ChildEnsureResult);
    });
  });
}
