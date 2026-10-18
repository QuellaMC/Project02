/**
 * The Telegram connector: one process beside the daemon, a client of its
 * wire like the page. It finds the daemon by the home's record — waiting
 * for one not up yet — runs a bot for each token the home's settings
 * hold, and stops on a signal, every bot with it.
 */
import {resolve} from 'node:path';

import {httpBaseUrlRule, isHttpBaseUrl} from '../../shared/base-url.ts';
import {defaultProject02HomeRoot} from '../../shared/daemon-record.ts';
import {isMainModule, stopSignal} from '../../shared/main-module.ts';
import {readTestDurations} from '../../shared/test-durations.ts';
import {
  runTelegramConnector,
  type TelegramConnectorOptions,
} from './connector.ts';
import {createNodeFetch} from './node-fetch.ts';

/** A test harness's fake of the Bot API, reached in Telegram's place; never a setting. */
const testTelegramApiVariable = 'PROJECT02_TEST_TELEGRAM_API';

async function runTelegramConnectorFromArgs(
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

/** What a test harness sets for the connector: its draft edit pacing, and the Bot API it reaches. */
function testSwitches(
  env: NodeJS.ProcessEnv,
):
  | Pick<TelegramConnectorOptions, 'pacing' | 'telegramBaseUrl'>
  | {readonly refusal: string} {
  const testDurations = readTestDurations(env, ['edit']);
  const telegramApi = env[testTelegramApiVariable];

  if ('refusal' in testDurations) {
    return testDurations;
  }

  if (telegramApi !== undefined && !isHttpBaseUrl(telegramApi)) {
    return {refusal: `${testTelegramApiVariable} must be ${httpBaseUrlRule}.`};
  }

  const draftEditMs = testDurations.durations.get('edit');

  return {
    ...(draftEditMs === undefined ? {} : {pacing: {draftEditMs}}),
    ...(telegramApi === undefined ? {} : {telegramBaseUrl: telegramApi}),
  };
}

if (isMainModule(import.meta.url)) {
  const switches = testSwitches(process.env);

  if ('refusal' in switches) {
    process.stderr.write(`${switches.refusal}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = await runTelegramConnectorFromArgs(
      process.argv.slice(2),
      {
        stdout: process.stdout,
        stderr: process.stderr,
        signal: stopSignal(),
        ...switches,
      },
    );
  }
}
