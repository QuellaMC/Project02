/**
 * A real process, for a suite that must cross the process boundary: the
 * daemon — for the concurrency suite proving one home's leases, the
 * browser suite driving the built page — or a connector beside it.
 * `entry` is a script that runs one and prints what it prints. Nothing
 * here imports vitest, so Playwright's worker can use it too.
 */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';

import {gatewayUrlEnvVarName} from '../../src/gateway/client/index.ts';

export type SpawnedProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  /** The line it printed that made it ready. */
  readonly line: string;
  /** Everything it had printed on stdout once ready. */
  readonly stdout: string;
  /**
   * The exit code once the process ends on its own or on a signal the
   * test sent itself; null when a signal ended it. A process that is
   * ending must not be sent SIGINT on top: inside Node's own teardown the
   * signal takes its default action.
   */
  readonly exited: Promise<number | null>;
  /** SIGINT, the way an operator stops it; resolves with the exit code. */
  readonly stop: () => Promise<{
    readonly code: number | null;
    readonly stderr: string;
  }>;
};

export type SpawnedDaemon = SpawnedProcess & {
  /** The address a client opens: the line the daemon printed, past its name. */
  readonly url: string;
};

const addressPrefix = `${gatewayUrlEnvVarName}=`;

/**
 * Ready once the daemon printed its address. Started with the test switch
 * on, so a real `serve` runs its characters on the test provider.
 */
export async function spawnDaemon(
  entry: string,
  args: readonly string[],
): Promise<SpawnedDaemon> {
  const daemon = await spawnProcess(
    entry,
    args,
    line => line.startsWith(addressPrefix),
    {PROJECT02_TEST_PROVIDER: 'deterministic'},
  );

  return {...daemon, url: daemon.line.slice(addressPrefix.length)};
}

/** Ready once it printed a line on stdout that `ready` accepts. */
export async function spawnProcess(
  entry: string,
  args: readonly string[],
  ready: (line: string) => boolean,
  env: Readonly<Record<string, string>> = {},
): Promise<SpawnedProcess> {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: {...process.env, ...env},
  });
  // Taken now, not at stop: a process that died on its own has already
  // fired its exit, and a listener added afterwards would wait forever.
  const exited = new Promise<number | null>(resolve => {
    child.once('exit', resolve);
  });
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const {line, stdout} = await new Promise<{
    readonly line: string;
    readonly stdout: string;
  }>((resolveReady, rejectReady) => {
    let stdout = '';
    // An idle deadline, not a total one: a suite cold-starts several real
    // Node processes, so any fixed budget goes flaky under load.
    let timeout: NodeJS.Timeout | undefined;
    const failIfIdle = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        child.kill();
        rejectReady(
          new Error(`Timed out waiting for ${entry}: ${stdout}${stderr}`),
        );
      }, 20_000);
    };

    failIfIdle();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;

      // The last piece is a line still being written.
      const line = stdout.split('\n').slice(0, -1).find(ready);

      if (line !== undefined) {
        clearTimeout(timeout);
        resolveReady({line, stdout});

        return;
      }

      failIfIdle();
    });
    child.once('error', error => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `${entry} exited before it was ready (${String(code)}): ${stderr}`,
        ),
      );
    });
  });

  return {
    child,
    line,
    stdout,
    exited,
    stop: async () => {
      child.kill('SIGINT');

      return {code: await exited, stderr};
    },
  };
}
