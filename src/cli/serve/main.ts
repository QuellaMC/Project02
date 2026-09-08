/**
 * The daemon: one process holding the gateway and its loopback socket for
 * every client — the terminal chat, the web UI, a messaging connector.
 * It prints where it listens, brings the roster up, and only then prints
 * the line a client reads, so nothing connects to a half-started daemon.
 */
import {randomBytes} from 'node:crypto';

import {gatewayUrlEnvVarName} from '../../gateway/client/index.ts';
import {
  createGateway,
  createGatewayServer,
  type Gateway,
  type GatewayHealth,
  type GatewayServer,
} from '../../gateway/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';
import type {RoleModelAdapter} from '../../role-model/index.ts';
import type {RuntimeLocationCliState} from '../../runtime/config/index.ts';
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

export type ServeCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  /** Ends the run; the main module wires SIGINT and SIGTERM to it. */
  readonly signal: AbortSignal;
  /** Test and dev injection, handed through to the gateway. */
  readonly pluginHost?: RuntimePluginHost;
  readonly roleModelAdapter?: RoleModelAdapter;
  /** Test injection: 0 asks for an ephemeral port. */
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
      ...(options.env === undefined ? {} : {env: options.env}),
    });

    const gateway = createGateway({
      location: flags.location,
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(options.roleModelAdapter === undefined
        ? {}
        : {roleModelAdapter: options.roleModelAdapter}),
      ...(options.pluginHost === undefined
        ? {}
        : {createPluginHost: () => options.pluginHost as RuntimePluginHost}),
    });

    return await serve(gateway, options);
  } catch (error: unknown) {
    options.stderr.write(
      `Error: ${
        isCliTerminalError(error)
          ? formatCliTerminalErrorMessage(error)
          : error instanceof Error
            ? error.message
            : String(error)
      }\n`,
    );

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

async function serve(
  gateway: Gateway,
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
    const token = randomBytes(32).toString('base64url');

    server = await createGatewayServer({
      gateway,
      token,
      port: options.port ?? defaultGatewayPort,
    });

    const origin = `http://127.0.0.1:${String(server.port)}/`;

    options.stdout.write(`Gateway listening on ${origin}\n`);
    reportStartupProblems(gateway.health(), options.stderr);
    await gateway.reconcile();

    // Stopped while the roster came up: nothing is advertised that a
    // launcher would take for a daemon it can use.
    if (!options.signal.aborted) {
      options.stdout.write(
        `${gatewayUrlEnvVarName}=${origin}#token=${token}\n`,
      );
      await aborted(options.signal);
    }

    stopping = true;
    await server.close();

    return stopProblems === 0 ? 0 : 1;
  } catch (error: unknown) {
    // The socket never opened, or a bug escaped: leave nothing running.
    await (server === undefined ? gateway.stop() : server.close());

    throw error;
  } finally {
    stopListening();
  }
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
  const signals = ['SIGINT', 'SIGTERM'] as const;
  // The first signal of either kind starts the stop; a second of either
  // kind ends the process the default way — the escape hatch when shutdown
  // itself hangs.
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
