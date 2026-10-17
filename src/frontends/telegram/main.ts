/**
 * The Telegram connector: one process beside the daemon, a client of its
 * wire like the page. It finds the daemon by the home's record — waiting
 * for one not up yet — runs a bot for each token the home's settings
 * hold, and stops on a signal, every bot with it.
 */
import {resolve} from 'node:path';

import {defaultProject02HomeRoot} from '../../shared/daemon-record.ts';
import {isMainModule, stopSignal} from '../../shared/main-module.ts';
import {
  runTelegramConnector,
  type TelegramConnectorOptions,
} from './connector.ts';
import {createNodeFetch} from './node-fetch.ts';

export async function runTelegramConnectorFromArgs(
  args: readonly string[],
  options: Omit<TelegramConnectorOptions, 'homeRoot' | 'fetch'>,
): Promise<number> {
  const home = homeRootOf(args);

  if ('refusal' in home) {
    options.stderr.write(`${home.refusal}\n`);

    return 1;
  }

  return runTelegramConnector({
    ...options,
    homeRoot: home.homeRoot,
    fetch: createNodeFetch(),
  });
}

/** The home `--store` names, or the working directory's default home. */
function homeRootOf(
  args: readonly string[],
): {readonly homeRoot: string} | {readonly refusal: string} {
  let store: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? '';
    const value = args[index + 1];

    if (flag !== '--store') {
      return {refusal: `Unknown telegram option: ${flag}.`};
    }

    if (store !== undefined) {
      return {refusal: '--store can only be provided once.'};
    }

    if (value === undefined || value.startsWith('--')) {
      return {refusal: '--store requires a value.'};
    }

    store = value;
  }

  return {homeRoot: resolve(store ?? defaultProject02HomeRoot)};
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runTelegramConnectorFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    signal: stopSignal(),
  });
}
