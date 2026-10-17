/**
 * The Telegram connector as `pnpm telegram` runs it, with the Bot API at
 * the address `--telegram-api` names — the fake the test serves — so the
 * flag never enters the real entry. The rest of the command line is the
 * connector's own. Spawned as a process (tests/support/spawn-daemon.ts).
 */
import {runTelegramConnectorFromArgs} from '../../src/frontends/telegram/main.ts';
import {stopSignal} from '../../src/shared/main-module.ts';

const args = process.argv.slice(2);
const flag = args.indexOf('--telegram-api');
const telegramBaseUrl = args[flag + 1];

if (flag === -1 || telegramBaseUrl === undefined) {
  throw new TypeError('Name the fake Bot API with --telegram-api <url>.');
}

process.exitCode = await runTelegramConnectorFromArgs(args.toSpliced(flag, 2), {
  stdout: process.stdout,
  stderr: process.stderr,
  signal: stopSignal(),
  telegramBaseUrl,
});
