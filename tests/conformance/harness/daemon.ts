import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

import {onTestFinished} from 'vitest';

import {attachEvidence, ceilingMs, waitFailure, within} from './wait.ts';

const serveCommand = (
  process.env['PROJECT02_SERVE_CMD'] ?? 'node src/cli/serve/main.ts'
)
  .trim()
  .split(/\s+/u);
const addressPrefix = 'PROJECT02_GATEWAY=';

/** Where a client reaches the daemon: the printed address, and its parts. */
export type Address = {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
};

export type Serve = {
  readonly pid: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** The address it printed, once it has. */
  readonly address: () => Promise<Address>;
  /** Settles once stdout holds this whole line. */
  readonly printed: (line: string) => Promise<void>;
  /** To its whole process group, as a terminal or a service manager sends one. */
  readonly signal: (name: NodeJS.Signals) => void;
  /** Its exit code; null when a signal ended it. */
  readonly exit: () => Promise<number | null>;
};

export type Daemon = Serve & Address;

/** This process's environment without the daemon's test switches: none leaks in from the shell running the suite. */
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith('PROJECT02_TEST_'),
  ),
);

/**
 * `serve` with these arguments, in a process group of its own so a signal
 * reaches whatever it started. The group is killed when the test ends,
 * and a process that outlasts that fails the test.
 */
export function serve(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Serve {
  const commandLine = [...serveCommand, ...args];
  const [command = '', ...commandArgs] = commandLine;
  const child = spawn(command, commandArgs, {
    env: {...inherited, ...env},
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const {pid} = child;

  // A command that cannot start has no pid, below; its error event only
  // repeats that.
  child.once('error', () => undefined);

  if (pid === undefined) {
    throw new Error(`Could not start ${commandLine.join(' ')}.`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode: number | null | undefined;
  const checks = new Set<() => void>();
  const changed = (): void => {
    for (const check of [...checks]) {
      check();
    }
  };
  // `close`, not `exit`: only then has everything it printed been read.
  const closed = new Promise<number | null>(resolve => {
    child.once('close', code => {
      exitCode = code;
      resolve(code);
      changed();
    });
  });

  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    changed();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    changed();
  });
  attachEvidence(
    () =>
      `${commandLine.join(' ')} (pid ${String(pid)}${
        exitCode === undefined ? '' : `, exited ${String(exitCode)}`
      })\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  onTestFinished(async () => {
    signalGroup(pid, 'SIGKILL');
    await within(`pid ${String(pid)} to go after SIGKILL`, closed);
    await groupGone(pid);
  });

  /** An idle deadline: a daemon starting under load is slow, not silent. */
  const line = (what: string, match: (line: string) => boolean) => {
    const failed = waitFailure(what);

    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const check = (): void => {
        const found = stdout.split('\n').slice(0, -1).find(match);

        clearTimeout(timer);

        if (found !== undefined) {
          checks.delete(check);
          resolve(found);
        } else if (exitCode !== undefined) {
          checks.delete(check);
          reject(failed.because('serve exited first'));
        } else {
          timer = setTimeout(() => {
            checks.delete(check);
            reject(failed.ceiling());
          }, ceilingMs);
        }
      };

      checks.add(check);
      check();
    });
  };

  return {
    pid,
    stdout: () => stdout,
    stderr: () => stderr,
    address: async () =>
      addressOf(
        await line('serve to print its address', printed =>
          printed.startsWith(addressPrefix),
        ),
      ),
    printed: async text => {
      await line(`serve to print "${text}"`, printed => printed === text);
    },
    signal: name => {
      process.kill(-pid, name);
    },
    exit: () => within('serve to exit', closed),
  };
}

/** `serve --init` on the home, once it printed its address. */
export async function startDaemon(
  home: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Daemon> {
  const run = serve(['--store', home, '--init'], env);

  return {...run, ...(await run.address())};
}

function addressOf(line: string): Address {
  const url = line.slice(addressPrefix.length);

  return {
    url,
    origin: new URL(url).origin,
    // From the line itself: a parsed fragment comes back percent-encoded.
    token: /#token=(.*)$/u.exec(url)?.[1] ?? '',
  };
}

/** Settles once no process of the group is left to signal, or fails at the ceiling. */
async function groupGone(pid: number): Promise<void> {
  const failed = waitFailure(
    `the group of pid ${String(pid)} to go after SIGKILL`,
  );
  const deadline = Date.now() + ceilingMs;

  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }

    await sleep(20);
  }

  throw failed.ceiling();
}

function signalGroup(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch (error: unknown) {
    // Its last process is gone already.
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    )) {
      throw error;
    }
  }
}
