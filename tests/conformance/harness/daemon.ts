import {spawn, type ChildProcess} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {onTestFinished} from './runner.ts';
import {attachEvidence, ceilingMs, waitFailure, within} from './wait.ts';

const serveCommand = commandOf(
  'PROJECT02_SERVE_CMD',
  'node src/cli/serve/main.ts',
);
const inspectCommand = commandOf(
  'PROJECT02_INSPECT_CMD',
  'node src/cli/inspect/main.ts',
);
/** serve on a pseudo-terminal, through python3's pty module. */
const terminalCommand = [
  'python3',
  fileURLToPath(new URL('terminal.py', import.meta.url)),
];
const addressPrefix = 'PROJECT02_GATEWAY=';

/** Where a client reaches the daemon: the printed address, and its parts. */
export type Address = {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
};

/** A command the test started, met by its output, signals and exit. */
export type Run = {
  readonly pid: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Settles once stdout holds this whole line. */
  readonly printed: (line: string) => Promise<void>;
  /** Settles once stderr holds this whole line. */
  readonly printedOnStderr: (line: string) => Promise<void>;
  /** To its whole process group, as a terminal or a service manager sends one. */
  readonly signal: (name: NodeJS.Signals) => void;
  /** Its exit code; null when a signal ended it. */
  readonly exit: () => Promise<number | null>;
};

export type Serve = Run & {
  /** The address it printed, once it has. */
  readonly address: () => Promise<Address>;
};

export type Daemon = Serve & Address;

/** serve on a terminal of its own: what it shows, stdout and stderr as one, and what is typed to it. */
export type Terminal = Serve & {
  /** Settles once the terminal shows this text, a whole line or not. */
  readonly shows: (text: string) => Promise<void>;
  readonly type: (text: string) => void;
  /** The terminal goes away, as a closed window takes it. */
  readonly hangUp: () => void;
};

/** This process's environment without the daemon's test switches: none leaks in from the shell running the suite. */
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith('PROJECT02_TEST_'),
  ),
);

/** `serve` with these arguments. */
export function serve(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Serve {
  return served(start('serve', [...serveCommand, ...args], env));
}

/** `serve` with these arguments on a pseudo-terminal, as a person runs it. */
export function terminal(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Terminal {
  const started = start(
    'serve',
    [...terminalCommand, ...serveCommand, ...args],
    env,
    'pipe',
  );

  return {
    ...served(started),
    shows: async text => {
      await started.awaiting(
        `serve to show "${text}"`,
        started.run.stdout,
        shown => (shown.includes(text) ? text : undefined),
      );
    },
    type: text => {
      started.child.stdin?.write(text);
    },
    hangUp: () => {
      started.child.stdin?.end();
    },
  };
}

function served({run, awaiting}: Started): Serve {
  return {
    ...run,
    address: async () =>
      addressOf(
        await awaiting(
          'serve to print its address',
          run.stdout,
          lineMatching(printed => printed.startsWith(addressPrefix)),
        ),
      ),
  };
}

/** The first whole line of the output that matches. */
function lineMatching(
  match: (line: string) => boolean,
): (output: string) => string | undefined {
  return output => output.split('\n').slice(0, -1).find(match);
}

type Started = {
  readonly run: Run;
  readonly child: ChildProcess;
  /** Settles on what `found` finds in the output, under an idle deadline. */
  readonly awaiting: (
    what: string,
    output: () => string,
    found: (output: string) => string | undefined,
  ) => Promise<string>;
};

/** `inspect` with these arguments: a report on a home, then its exit. */
export function inspect(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Run {
  return start('inspect', [...inspectCommand, ...args], env).run;
}

/** `serve --init` on the home, once it printed its address. */
export async function startDaemon(
  home: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Daemon> {
  const run = serve(['--store', home, '--init'], env);

  return {...run, ...(await run.address())};
}

/**
 * The command, in a process group of its own so a signal reaches whatever
 * it started. The group is killed when the test ends, and a process that
 * outlasts that fails the test. A terminal's lines end in CRLF, read as LF.
 */
function start(
  name: string,
  commandLine: readonly string[],
  env: Readonly<Record<string, string>>,
  stdin: 'ignore' | 'pipe' = 'ignore',
): Started {
  const [command = '', ...commandArgs] = commandLine;
  const child = spawn(command, commandArgs, {
    env: {...inherited, ...env},
    detached: true,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const {pid, stdout: out, stderr: err} = child;

  // A command that cannot start has no pid, below; its error event only
  // repeats that.
  child.once('error', () => undefined);

  if (pid === undefined || out === null || err === null) {
    throw new Error(`Could not start ${commandLine.join(' ')}.`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode: number | null | undefined;
  const shown = (): string => stdout.replaceAll('\r\n', '\n');
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

  out.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    changed();
  });
  err.setEncoding('utf8').on('data', (chunk: string) => {
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
  const awaiting: Started['awaiting'] = (what, output, find) => {
    const failed = waitFailure(what);

    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const check = (): void => {
        const found = find(output());

        clearTimeout(timer);

        if (found !== undefined) {
          checks.delete(check);
          resolve(found);
        } else if (exitCode !== undefined) {
          checks.delete(check);
          reject(failed.because(`${name} exited first`));
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
    run: {
      pid,
      stdout: shown,
      stderr: () => stderr,
      printed: async text => {
        await awaiting(
          `${name} to print "${text}"`,
          shown,
          lineMatching(printed => printed === text),
        );
      },
      printedOnStderr: async text => {
        await awaiting(
          `${name} to print "${text}" on stderr`,
          () => stderr,
          lineMatching(printed => printed === text),
        );
      },
      signal: signalName => {
        process.kill(-pid, signalName);
      },
      exit: () => within(`${name} to exit`, closed),
    },
    child,
    awaiting,
  };
}

/** A command line from the environment, split on whitespace, or its default. */
function commandOf(variable: string, fallback: string): readonly string[] {
  return (process.env[variable] ?? fallback).trim().split(/\s+/u);
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
