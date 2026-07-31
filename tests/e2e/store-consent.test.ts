import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, onTestFinished} from 'vitest';

import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {runChatCliFromArgs} from '../../src/cli/chat/main.ts';
import {runInspectCliFromArgs} from '../../src/cli/inspect/main.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

/**
 * Every test here uses a bare temp root rather than an arranged store,
 * because the gate is the subject: an initialized store would answer the
 * one question these tests ask before the gate ever spoke.
 *
 * The whole layout a store is born with is asserted once, on the `--init`
 * run. Everywhere else the proof of a refusal is the same and simpler:
 * the directory is still empty.
 */
const initializedStoreEntries = Object.freeze([
  '.locks',
  'character-data',
  'config.json',
  'schema.json',
]);

/**
 * A stream the gate will treat as a person at a terminal.
 *
 * `isTTY` is what the gate reads: it separates an operator who can
 * answer from a pipe that cannot. The stream stays open after the
 * scripted keystrokes for the same reason a real terminal does —
 * readline emits `close` on an ended input *before* the pending
 * question resolves, so a finite `Readable.from` would answer every
 * prompt with silence no matter what was typed into it.
 */
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

/** A terminal that is gone by the time the question is asked. */
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
    // One initializer, one complete store: the marker, the locks it
    // needed to write it, the character-data root, and the global
    // config document all arrive together.
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
    // Both halves of the answer are on one stream, in order: the store
    // was offered, and saying yes ran `check` rather than ending the
    // run and making the operator type it again.
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

    // A terminal that goes away mid-question is silence, and nothing
    // durable may be built on silence.
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

    // `path` is how an operator asks where a store *would* live, so it
    // has to answer for one that is not there yet.
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

    // An explicit --config names a document, not a home. No store comes
    // into being here, so there is nothing to ask about — and the
    // directory holding it must not turn into one.
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
    // What the gate owes here is that no store was born, which is the
    // marker plus the layout around it — not that the directory is
    // pristine. The write takes a lock next to the document it writes,
    // so a `.locks` root is expected and is not a store.
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

    // Inspect has no consent to ask for, because it never creates the
    // store it describes. It reports what a run against this path would
    // find — an empty store with no sessions — and leaves the path as it
    // found it.
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

  it('refuses a chat run before it materializes any character state', async () => {
    const storeRoot = createTestTempRoot('project02-consent-chat-');
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'consent-refused'],
      {
        stdin: pipedStdin(),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
    expect(existsSync(join(storeRoot, 'character-data'))).toBe(false);
  });
});
