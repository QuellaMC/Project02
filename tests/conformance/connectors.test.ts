import {createServer as createTcpServer} from 'node:net';

import {expect, it, onTestFinished} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {messageFrom, startTelegramServer} from './harness/telegram-server.ts';
import {within} from './harness/wait.ts';
import {saveConfig, wireOf} from './harness/wire.ts';

const homeBot = {token: '123456:home', id: 123456, username: 'home_bot'};
const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';

/** A settings document's Telegram stanza holding these fields. */
function telegramSettings(config: object): object {
  return {connectors: {telegram: {config}}};
}

function unsetTelegram(field: string): object {
  return {
    kind: 'section_field_unset',
    namespace: 'connectors',
    id: 'telegram',
    field,
  };
}

/** Another program on the port until the test ends, one that drops every connection it takes. */
async function holdPort(port: number): Promise<void> {
  const holder = createTcpServer(socket => {
    socket.destroy();
  });

  onTestFinished(
    () =>
      new Promise<void>(resolve => {
        holder.close(() => {
          resolve();
        });
      }),
  );
  await within(
    `another program to take port ${String(port)}`,
    new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(port, '127.0.0.1', resolve);
    }),
  );
}

it("connectors.telegram-discovery: the connector finds the daemon by its home's daemon.json: it says it waits for a record not written yet and connects once it is, and follows the daemon to the port it moved to", async () => {
  const home = createHome({
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const telegram = await startTelegramServer([miraBot]);
  const waiting = `Telegram connector: waiting for the daemon on ${home}.`;
  const run = connector(['--store', home], telegram.env);

  await run.printed(waiting);

  const first = await startDaemon(home);
  const connected = `Telegram connector: connected to ${first.origin}.`;

  await run.printed(connected);
  await run.printed(miraAnswers);
  expect(run.stdout().split('\n').slice(0, 2)).toEqual([waiting, connected]);

  first.signal('SIGINT');
  await first.exit();
  await holdPort(Number(new URL(first.origin).port));

  const moved = await startDaemon(home);

  await run.printed(`Telegram connector: connected to ${moved.origin}.`);
  // Her bot answers through the daemon where it is now.
  telegram.push(miraBot.token, messageFrom(bob, 1, 'Hello?'));
  await telegram.called(miraBot.token, calls =>
    calls.find(call => call.body['chat_id'] === bob.id),
  );
});

it("connectors.telegram-bot-table: the connector runs one bot per token, the home's management bot and each character's, polls a token two characters share once while saying whose bot is not started, stops a bot whose token is cleared, and on SIGINT exits 0", async () => {
  const home = createHome({
    'config.json': configJson(
      telegramSettings({managementBotToken: homeBot.token}),
    ),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
      nova: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([homeBot, miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed('Telegram: management bot @home_bot is on.');
  await run.printed(miraAnswers);
  await run.printedOnStderr(
    "Nova's bot token is also Mira's; Nova's bot is not started.",
  );
  await saveConfig(
    wire,
    {scope: 'global'},
    unsetTelegram('managementBotToken'),
  );
  await run.printed('Telegram: stopped @home_bot (the management bot).');

  const asked = telegram.calls(homeBot.token).length;

  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  // Nothing more was asked on its token once its bot stopped.
  expect(telegram.calls(homeBot.token)).toHaveLength(asked);
});

it("connectors.telegram-switches: switching the home's Telegram section off stops the bots that follow it", async () => {
  const home = createHome({
    'config.json': configJson(
      telegramSettings({managementBotToken: homeBot.token}),
    ),
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([homeBot, miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed('Telegram: management bot @home_bot is on.');
  await run.printed(miraAnswers);
  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'section_enabled',
      namespace: 'connectors',
      id: 'telegram',
      enabled: false,
    },
  );
  await run.printed('Telegram: stopped @home_bot (the management bot).');
  await run.printed('Telegram: stopped @mira_bot (Mira).');
});
