/**
 * The daemon: one process holding the gateway and its loopback socket for
 * every client — the web page, a messaging connector. It claims its home,
 * binds the home's port, says where it listens — on stdout and in the
 * home's record — and lets the roster come up on the stream; a stop
 * finishes what was accepted and lets the home go last.
 */
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  createGatewayClient,
  GatewayClientError,
  gatewayUrlEnvVarName,
} from '../../gateway/client/index.ts';
import {
  claimDaemonHome,
  createGateway,
  createGatewayServer,
  type DaemonClaim,
  type DaemonRecord,
  type Gateway,
  type GatewayHealth,
  type GatewayServer,
} from '../../gateway/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';
import type {RoleModelAdapter} from '../../role-model/index.ts';
import type {RuntimeLocationCliState} from '../../runtime/config/index.ts';
import {pathExistsSync} from '../../shared/file-system.ts';
import {isMainModule} from '../shared/main-module.ts';
import {
  matchesRuntimeStoreInitFlag,
  parseRuntimeStoreFlag,
} from '../shared/runtime-location-flags.ts';
import {assertProject02StoreConsent} from '../shared/store-consent.ts';
import {
  formatCliTerminalErrorMessage,
  isCliTerminalError,
} from '../shared/terminal-errors.ts';
import {CliUsageError} from '../shared/usage-error.ts';

export const defaultGatewayPort = 4310;

/** How long a second serve waits for the daemon that holds the home to answer. */
const probeMs = 5_000;
/** How long a second serve waits for a stopping daemon to let the home go. */
const takeOverWaitMs = 30_000;

/** Where `pnpm build:web` puts the page: beside the source, under dist. */
const uiRoot = fileURLToPath(new URL('../../../dist/web/', import.meta.url));

export type ServeCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Ends the run; the main module wires the stop signals to it. */
  readonly signal: AbortSignal;
  /** Test and dev injection, handed through to the gateway. */
  readonly pluginHost?: RuntimePluginHost;
  readonly roleModelAdapter?: RoleModelAdapter;
  /**
   * The port a first run on this home asks for; a later run binds the
   * home's own. Tests inject 0, a free port.
   */
  readonly port?: number;
};

type ServeCliFlags = {
  readonly location: RuntimeLocationCliState;
  readonly init: boolean;
};

export async function runServeCliFromArgs(
  args: readonly string[],
  options: ServeCliOptions,
): Promise<number> {
  try {
    const flags = parseServeCliFlags(args);

    await assertProject02StoreConsent({
      location: flags.location,
      init: flags.init,
      stdout: options.stdout,
      stdin: options.stdin,
      signal: options.signal,
    });

    const gateway = createGateway({
      location: flags.location,
      ...(options.roleModelAdapter === undefined
        ? {}
        : {roleModelAdapter: options.roleModelAdapter}),
      ...(options.pluginHost === undefined
        ? {}
        : {createPluginHost: () => options.pluginHost as RuntimePluginHost}),
    });
    const homeRoot = gateway.health().homeRoot;
    const claimed = await claimDaemonHome({homeRoot});

    if (claimed.status === 'held') {
      return await handOver(gateway, homeRoot, claimed.record, options);
    }

    return await serve(gateway, claimed.claim, options);
  } catch (error: unknown) {
    options.stderr.write(`Error: ${describe(error)}\n`);

    return 1;
  }
}

function parseServeCliFlags(args: readonly string[]): ServeCliFlags {
  let location: RuntimeLocationCliState = {};
  let init = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    // The daemon runs every enabled character; picking one is the client's.
    const store =
      arg === '--character'
        ? {status: 'unmatched' as const}
        : parseRuntimeStoreFlag({args, index, location});

    if (store.status === 'matched') {
      location = store.location;
      index = store.nextIndex;
      continue;
    }

    if (matchesRuntimeStoreInitFlag(arg, init)) {
      init = true;
      continue;
    }

    throw new CliUsageError(`Unknown serve option: ${arg}.`);
  }

  return {location, init};
}

/**
 * One order: bind the home's port, publish the address, let the roster
 * come up, run until the stop, close, and let the home go. Every failure
 * after the claim unwinds the same way.
 */
async function serve(
  gateway: Gateway,
  claim: DaemonClaim,
  options: ServeCliOptions,
): Promise<number> {
  let stopping = false;
  let stopProblems = 0;
  const stopListening = gateway.events(event => {
    if (event.kind === 'state_changed' && event.message !== undefined) {
      options.stderr.write(`${event.characterId}: ${event.message}\n`);

      if (stopping) {
        stopProblems += 1;
      }
    } else if (event.kind === 'maintenance_failed') {
      options.stderr.write(`${event.characterId}: ${event.message}\n`);
    }
  });
  let server: GatewayServer | undefined;

  try {
    if (claim.unreadableRecord !== undefined) {
      options.stderr.write(
        `${claim.unreadableRecord} It is replaced, with a new token: open the address below.\n`,
      );
    }

    server = await createGatewayServer({
      gateway,
      token: claim.token,
      port: claim.port ?? options.port ?? defaultGatewayPort,
      // Served only once built: the file handler warns about a root that is
      // not there, and a daemon run straight from `node` must not.
      ...(pathExistsSync(join(uiRoot, 'index.html')) ? {uiRoot} : {}),
    });

    const moved = claim.publish(server.port);

    // An open tab retries the old address and nothing can tell it; the
    // person can.
    if (moved !== undefined) {
      options.stdout.write(
        `Port ${String(moved)} was taken by another program; the address has changed. ` +
          'Open tabs and bookmarks need the new one.\n',
      );
    }

    options.stdout.write(
      `${gatewayUrlEnvVarName}=http://127.0.0.1:${String(server.port)}/#token=${claim.token}\n`,
    );
    reportStartupProblems(gateway.health(), options.stderr);
    // The roster comes up on the stream; the address does not wait for it.
    // A pass answers its problems as states and never rejects by design,
    // so a rejection is a bug worth seeing.
    void gateway.reconcile().catch((error: unknown) => {
      options.stderr.write(`Reconcile failed: ${describe(error)}\n`);
    });
    await aborted(options.signal);
    options.stdout.write('Stopping; finishing what is in flight.\n');
    stopping = true;
    await server.close();

    return await released(claim, options.stderr, stopProblems === 0 ? 0 : 1);
  } catch (error: unknown) {
    // The socket never opened, or a bug escaped: leave nothing running,
    // and let the home go.
    await (server === undefined ? gateway.stop() : server.close());
    await claim.release();

    throw error;
  } finally {
    stopListening();
  }
}

/**
 * A second serve on a held home is a client of the daemon that holds it.
 * It asks the address the record names and hands it back when the daemon
 * answers — the person wanted the app, and has it; waits for a daemon
 * that is stopping, and takes the home over; and says so when nothing
 * answers: the holder has not published yet, a crash left a record naming
 * a port nobody listens on, or the holder is on another machine.
 */
async function handOver(
  gateway: Gateway,
  homeRoot: string,
  record: DaemonRecord | undefined,
  options: ServeCliOptions,
): Promise<number> {
  if (record === undefined) {
    options.stderr.write(
      'Another daemon holds this home but has not published its address yet; ' +
        'if it is starting, run this again in a moment.\n',
    );

    return 1;
  }

  const origin = `http://127.0.0.1:${String(record.port)}/`;
  const probe = AbortSignal.timeout(probeMs);
  let health: GatewayHealth | undefined;

  try {
    health = await createGatewayClient({
      baseUrl: origin,
      token: record.token,
    }).health({signal: probe});
  } catch (error: unknown) {
    if (error instanceof GatewayClientError && error.status === 503) {
      return await takeOver(gateway, homeRoot, options);
    }

    options.stderr.write(
      `Another daemon holds this home but did not answer at ${origin}${
        probe.aborted
          ? ` within ${String(probeMs / 1000)} seconds`
          : `: ${describe(error)}`
      }; if it is starting, run this again in a moment.\n`,
    );

    return 1;
  }

  if (health.homeRoot !== homeRoot) {
    options.stderr.write(
      `Another daemon holds this home, but the one at ${origin} serves ${health.homeRoot}; ' +
        'if it is starting, run this again in a moment.\n`,
    );

    return 1;
  }

  options.stdout.write(
    `Already running on this home${
      record.running === undefined ? '' : ` (pid ${String(record.running.pid)})`
    }.\n`,
  );
  options.stdout.write(
    `${gatewayUrlEnvVarName}=${origin}#token=${record.token}\n`,
  );

  return 0;
}

/** The holder is on its way out: its turn drains, then this run is the daemon. */
async function takeOver(
  gateway: Gateway,
  homeRoot: string,
  options: ServeCliOptions,
): Promise<number> {
  options.stderr.write(
    'The daemon on this home is stopping; waiting to take over.\n',
  );

  const claimed = await claimDaemonHome({
    homeRoot,
    waitTimeoutMs: takeOverWaitMs,
    signal: options.signal,
  });

  if (claimed.status === 'held') {
    if (!options.signal.aborted) {
      options.stderr.write(
        'The daemon on this home is still stopping; run this again once it has stopped.\n',
      );
    }

    return 1;
  }

  return await serve(gateway, claimed.claim, options);
}

/** The home is let go last; a lease that would not go is the exit code. */
async function released(
  claim: DaemonClaim,
  stderr: NodeJS.WritableStream,
  exitCode: number,
): Promise<number> {
  const problem = await claim.release();

  if (problem === undefined) {
    return exitCode;
  }

  stderr.write(`${problem}\n`);

  return 1;
}

/**
 * What the roster cannot carry: a config that failed to load, and a
 * character package that failed discovery — which has no runtime to report
 * itself, and would otherwise vanish without a word.
 */
function reportStartupProblems(
  health: GatewayHealth,
  stderr: NodeJS.WritableStream,
): void {
  for (const diagnostic of health.config.diagnostics) {
    if (diagnostic.severity === 'error') {
      stderr.write(`Config: ${diagnostic.message}\n`);
    }
  }

  for (const diagnostic of health.packages.diagnostics) {
    stderr.write(
      `Character package ${diagnostic.path} (${diagnostic.code}): ${diagnostic.message}\n`,
    );
  }
}

function describe(error: unknown): string {
  return isCliTerminalError(error)
    ? formatCliTerminalErrorMessage(error)
    : error instanceof Error
      ? error.message
      : String(error);
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();

      return;
    }

    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      {once: true},
    );
  });
}

if (isMainModule(import.meta.url)) {
  const abort = new AbortController();
  // A closed terminal sends SIGHUP: an ordinary way to stop, not the one
  // that skips the release.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  // The first signal of any kind starts the stop; a second of any kind
  // ends the process the default way — the escape hatch when shutdown
  // itself hangs. The lease left behind is the next start's to reclaim.
  const onSignal = (): void => {
    for (const signal of signals) {
      process.off(signal, onSignal);
    }

    abort.abort();
  };

  for (const signal of signals) {
    process.on(signal, onSignal);
  }

  process.exitCode = await runServeCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: abort.signal,
  });
}
