/**
 * A real daemon, for a suite that must cross the process boundary: the
 * concurrency suite proving one home's leases. `entry` is a script that
 * runs one and prints what it prints.
 */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';

import {gatewayUrlEnvVarName} from '../../src/gateway/client/index.ts';

export type SpawnedDaemon = {
  readonly child: ChildProcessWithoutNullStreams;
  /** The address a client opens: the line the daemon printed, past its name. */
  readonly url: string;
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

const addressPrefix = `${gatewayUrlEnvVarName}=`;

/**
 * Ready once the daemon printed its address. Started with the test switch
 * on, so a real `serve` runs its characters on the test provider; `env`
 * is laid over this process's.
 */
export async function spawnDaemon(
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env: {...process.env, PROJECT02_TEST_PROVIDER: 'deterministic', ...env},
    stdio: 'pipe',
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

  const line = await new Promise<string>((resolveReady, rejectReady) => {
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
      const address = stdout
        .split('\n')
        .slice(0, -1)
        .find(printed => printed.startsWith(addressPrefix));

      if (address !== undefined) {
        clearTimeout(timeout);
        resolveReady(address);

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
    url: line.slice(addressPrefix.length),
    exited,
    stop: async () => {
      child.kill('SIGINT');

      return {code: await exited, stderr};
    },
  };
}
