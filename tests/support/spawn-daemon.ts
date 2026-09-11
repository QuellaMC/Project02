/**
 * A real daemon process, for a suite that must cross the process boundary:
 * the concurrency suite proving one home's leases, the browser suite
 * driving the built page. `entry` is a script that runs serve and prints
 * what serve prints. Nothing here imports vitest, so Playwright's worker
 * can use it too.
 */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';

import {gatewayUrlEnvVarName} from '../../src/gateway/client/index.ts';

export type SpawnedDaemon = {
  readonly child: ChildProcessWithoutNullStreams;
  /** The address a client opens: the line the daemon printed, past its name. */
  readonly url: string;
  /** SIGINT, the way an operator stops it; resolves with the exit code. */
  readonly stop: () => Promise<{
    readonly code: number | null;
    readonly stderr: string;
  }>;
};

/** Ready once the daemon printed its address. */
export async function spawnDaemon(
  entry: string,
  args: readonly string[],
): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    let stdout = '';
    // An idle deadline, not a total one: a suite cold-starts several real
    // Node processes, so any fixed budget goes flaky under load.
    let timeout: NodeJS.Timeout | undefined;
    const failIfIdle = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        child.kill();
        rejectUrl(
          new Error(`Timed out waiting for the daemon: ${stdout}${stderr}`),
        );
      }, 20_000);
    };

    failIfIdle();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;

      const line = stdout
        .split('\n')
        .find(candidate => candidate.startsWith(`${gatewayUrlEnvVarName}=`));

      if (line !== undefined) {
        clearTimeout(timeout);
        resolveUrl(line.slice(gatewayUrlEnvVarName.length + 1));

        return;
      }

      failIfIdle();
    });
    child.once('error', error => {
      clearTimeout(timeout);
      rejectUrl(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      rejectUrl(
        new Error(
          `The daemon exited before its address (${String(code)}): ${stderr}`,
        ),
      );
    });
  });

  return {
    child,
    url,
    stop: () =>
      new Promise(resolveExit => {
        child.once('exit', code => {
          resolveExit({code, stderr});
        });
        child.kill('SIGINT');
      }),
  };
}
