import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, onTestFinished, vi} from 'vitest';

import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {runInspectCliFromArgs} from '../../src/cli/inspect/main.ts';
import {runServeCliFromArgs} from '../../src/cli/serve/main.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

// The gate is the subject here, so every test starts from a bare temp root
// rather than an arranged store.
const initializedStoreEntries = Object.freeze([
  '.locks',
  'character-data',
  'config.json',
  'schema.json',
]);

// The stream stays open after the scripted keystrokes because readline emits
// `close` on an ended input before the pending question resolves.
function interactiveStdin(...lines: readonly string[]): NodeJS.ReadableStream {
  const stdin: PassThrough & {isTTY?: boolean} = new PassThrough();

  stdin.isTTY = true;

  for (const line of lines) {
    stdin.write(line);
  }

  onTestFinished(() => {
    stdin.destroy();
  });
  return stdin;
}

function pipedStdin(): NodeJS.ReadableStream {
  return Readable.from([]);
}

// A terminal that is gone by the time the question is asked.
function closedInteractiveStdin(): NodeJS.ReadableStream {
  const stdin: Readable & {isTTY?: boolean} = Readable.from([]);

  stdin.isTTY = true;
  return stdin;
}

describe('store consent gate', () => {
  it('refuses to create a store for a run nobody can be asked about', async () => {
    const storeRoot = createTestTempRoot('project02-consent-non-interactive-');
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdin: pipedStdin(),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`No Project02 store at "${storeRoot}"`);
    expect(stderr).toContain('Re-run with --init');
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('creates the whole store and runs the command when --init says yes', async () => {
    const storeRoot = createTestTempRoot('project02-consent-init-flag-');
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, '--init', 'check'],
      {
        stdin: pipedStdin(),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('"runtimeConfig"');
    expect(readdirSync(storeRoot).sort()).toEqual(initializedStoreEntries);
    expect(
      JSON.parse(readFileSync(join(storeRoot, 'config.json'), 'utf8')),
    ).toMatchObject({project02: {storeRoot}});
  });

  it('creates the store and continues into the command the operator typed', async () => {
    const storeRoot = createTestTempRoot('project02-consent-accepted-');
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdin: interactiveStdin('y\n'),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    // Saying yes runs `check` rather than ending the run.
    expect(stdout).toContain(
      `No Project02 store at "${storeRoot}". Create one there? [y/N]`,
    );
    expect(stdout).toContain('"runtimeConfig"');
    expect(readdirSync(storeRoot).sort()).toEqual(initializedStoreEntries);
  });

  it('leaves the directory alone when the operator declines', async () => {
    const storeRoot = createTestTempRoot('project02-consent-declined-');
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdin: interactiveStdin('n\n'),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toContain('Create one there? [y/N]');
    expect(stderr).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('treats a prompt that never gets an answer as a refusal', async () => {
    const storeRoot = createTestTempRoot('project02-consent-unanswered-');
    let stderr = '';

    // A terminal that goes away mid-question is silence.
    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdin: closedInteractiveStdin(),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('leaves a read verb ungated', async () => {
    const storeRoot = createTestTempRoot('project02-consent-read-verb-');
    let stdout = '';
    let stderr = '';

    // `path` asks where a store would live, so it answers for an absent one.
    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'path'],
      {
        stdin: pipedStdin(),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`${join(storeRoot, 'config.json')}\n`);
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('asks before a global write that would stand the store up', async () => {
    const storeRoot = createTestTempRoot('project02-consent-global-set-');
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'set', 'project02.roleModelProvider', 'local'],
      {
        stdin: pipedStdin(),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('writes a standalone config without offering to create a store', async () => {
    const configRoot = createTestTempRoot('project02-consent-standalone-');
    const configPath = join(configRoot, 'runtime.json');
    let stdout = '';
    let stderr = '';

    // An explicit --config names a document, not a home.
    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--config', configPath, 'set', 'project02.roleModelProvider', 'local'],
      {
        stdin: pipedStdin(),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('Create one there?');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      project02: {roleModelProvider: 'local'},
    });
    // The write takes a lock beside the document, so a `.locks` root is
    // expected here and is not a store.
    expect(existsSync(join(configRoot, 'schema.json'))).toBe(false);
    expect(existsSync(join(configRoot, 'character-data'))).toBe(false);
    expect(existsSync(join(configRoot, 'config.json'))).toBe(false);
  });

  it('reports on a store that does not exist without creating one', async () => {
    const storeRoot = createTestTempRoot('project02-consent-inspect-');
    let stdout = '';
    let stderr = '';

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    // Inspect never creates the store it describes, so it has no consent to
    // ask for.
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({sessions: []});
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('rejects --init on inspect rather than accepting a flag it ignores', async () => {
    const storeRoot = createTestTempRoot('project02-consent-inspect-init-');
    let stderr = '';

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions', '--init'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--init does not apply');
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('refuses to serve before it materializes any character state', async () => {
    const storeRoot = createTestTempRoot('project02-consent-serve-');
    let stderr = '';

    const exitCode = await runServeCliFromArgs(['--store', storeRoot], {
      stdin: pipedStdin(),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {},
      pluginHost: createRuntimePluginHost({plugins: []}),
      signal: new AbortController().signal,
      port: 0,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
    expect(existsSync(join(storeRoot, 'character-data'))).toBe(false);
  });

  it('lets a stop reach serve at the consent question, and takes it as a no', async () => {
    const storeRoot = createTestTempRoot('project02-consent-serve-stop-');
    const abort = new AbortController();
    let stdout = '';
    let stderr = '';

    const run = runServeCliFromArgs(['--store', storeRoot], {
      stdin: interactiveStdin(),
      stdout: collect(chunk => {
        stdout += chunk;
      }),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {},
      pluginHost: createRuntimePluginHost({plugins: []}),
      signal: abort.signal,
      port: 0,
    });

    await vi.waitFor(() => {
      expect(stdout).toContain('Create one there? [y/N]');
    });
    abort.abort();
    await expect(run).resolves.toBe(1);
    expect(stderr).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
  });
});
