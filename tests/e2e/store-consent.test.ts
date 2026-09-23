import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, onTestFinished, vi} from 'vitest';

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

/** Serve on the given root; `stop` ends a run that got past the gate. */
function serve(
  storeRoot: string,
  args: readonly string[],
  stdin: NodeJS.ReadableStream,
) {
  const abort = new AbortController();
  let stdout = '';
  let stderr = '';
  const exit = runServeCliFromArgs(['--store', storeRoot, ...args], {
    stdin,
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

  return {
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => {
      abort.abort();

      return exit;
    },
  };
}

describe('store consent gate', () => {
  it('refuses to create a store for a run nobody can be asked about', async () => {
    const storeRoot = createTestTempRoot('project02-consent-non-interactive-');
    const run = serve(storeRoot, [], pipedStdin());

    await expect(run.exit).resolves.toBe(1);
    expect(run.stderr()).toContain(`No Project02 store at "${storeRoot}"`);
    expect(run.stderr()).toContain('Re-run with --init');
    expect(readdirSync(storeRoot)).toEqual([]);
    expect(existsSync(join(storeRoot, 'character-data'))).toBe(false);
  });

  it('creates the whole store and serves it when --init says yes', async () => {
    const storeRoot = createTestTempRoot('project02-consent-init-flag-');
    const run = serve(storeRoot, ['--init'], pipedStdin());

    await vi.waitFor(() => {
      expect(run.stdout()).toContain('Gateway listening on port');
    });
    expect(run.stdout()).not.toContain('Create one there?');
    expect(readdirSync(storeRoot)).toEqual(
      expect.arrayContaining([...initializedStoreEntries]),
    );
    await expect(run.stop()).resolves.toBe(0);
  });

  it('creates the store and continues into the run when the operator says yes', async () => {
    const storeRoot = createTestTempRoot('project02-consent-accepted-');
    const run = serve(storeRoot, [], interactiveStdin('y\n'));

    await vi.waitFor(() => {
      expect(run.stdout()).toContain('Gateway listening on port');
    });
    expect(run.stdout()).toContain(
      `No Project02 store at "${storeRoot}". Create one there? [y/N]`,
    );
    expect(readdirSync(storeRoot)).toEqual(
      expect.arrayContaining([...initializedStoreEntries]),
    );
    await expect(run.stop()).resolves.toBe(0);
  });

  it('leaves the directory alone when the operator declines', async () => {
    const storeRoot = createTestTempRoot('project02-consent-declined-');
    const run = serve(storeRoot, [], interactiveStdin('n\n'));

    await expect(run.exit).resolves.toBe(1);
    expect(run.stdout()).toContain('Create one there? [y/N]');
    expect(run.stderr()).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('treats a prompt that never gets an answer as a refusal', async () => {
    const storeRoot = createTestTempRoot('project02-consent-unanswered-');
    // A terminal that goes away mid-question is silence.
    const run = serve(storeRoot, [], closedInteractiveStdin());

    await expect(run.exit).resolves.toBe(1);
    expect(run.stderr()).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
  });

  it('lets a stop reach the consent question, and takes it as a no', async () => {
    const storeRoot = createTestTempRoot('project02-consent-serve-stop-');
    const run = serve(storeRoot, [], interactiveStdin());

    await vi.waitFor(() => {
      expect(run.stdout()).toContain('Create one there? [y/N]');
    });
    await expect(run.stop()).resolves.toBe(1);
    expect(run.stderr()).toContain(`No Project02 store at "${storeRoot}"`);
    expect(readdirSync(storeRoot)).toEqual([]);
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
});
