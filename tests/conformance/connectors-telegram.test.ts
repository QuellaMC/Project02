import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  messageFrom,
  startTelegramServer,
  type Account,
  type TelegramBot,
  type TelegramCall,
  type TelegramServer,
} from './harness/telegram-server.ts';
import {wireOf} from './harness/wire.ts';

const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const novaBot = {token: '555555:nova', id: 555555, username: 'nova_bot'};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';

/** A home where Mira's bot answers, and these accounts are paired. */
function miraHome(paired: readonly Account[] = []): string {
  return createHome({
    'config.json': configJson({
      connectors: {
        telegram: {
          config: {
            pairedUsers: Object.fromEntries(
              paired.map(account => [String(account.id), account.first_name]),
            ),
          },
        },
      },
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: miraBot.token}}},
        }),
      },
    },
  });
}

/** Mira's bot as health shows it once Telegram said who it is. */
const miraOn = {
  target: {scope: 'character', characterId: 'mira'},
  username: 'mira_bot',
  state: 'on',
};

/** Health's connectors: whether the Telegram connector is on the stream, and its bots. */
function presence(
  connected: boolean,
  bots: readonly object[],
): readonly object[] {
  return [{id: 'telegram', connected, bots}];
}

/** Settles on the bot's call of this method at this place among those calls, once it was made. */
function nthCall(
  telegram: TelegramServer,
  bot: TelegramBot,
  method: string,
  place: number,
): Promise<TelegramCall> {
  return telegram.called(
    bot.token,
    calls => calls.filter(call => call.method === method)[place],
  );
}

it('connectors.telegram-retry-after: a message Telegram answers 429 with a retry_after is sent again once that pause is over, and nothing is reported unwritten', async () => {
  const home = miraHome([alice]);

  await startDaemon(home);

  const telegram = await startTelegramServer([miraBot]);
  const hello = "Hi, I'm Mira. Write to me here.";
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  telegram.throttle(miraBot.token, 1, 'sendMessage');
  telegram.push(miraBot.token, messageFrom(alice, 1, '/start'));

  const sent = await telegram.called(miraBot.token, calls => {
    const hellos = calls.filter(call => call.method === 'sendMessage');

    return hellos.length === 2 ? hellos : undefined;
  });

  expect(sent.map(call => call.body['text'])).toEqual([hello, hello]);
  expect((sent[1]?.at ?? 0) - (sent[0]?.at ?? 0)).toBeGreaterThanOrEqual(990);
  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  expect(run.stderr()).not.toContain('could not write');
});

it('connectors.telegram-unreachable: a bot that cannot reach Telegram says so without its token, and gets its messages again once Telegram is back', async () => {
  const home = miraHome();

  await startDaemon(home);

  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  await nthCall(telegram, miraBot, 'getUpdates', 0);
  telegram.away();
  await nthCall(telegram, miraBot, 'getUpdates', 1);
  telegram.back();
  telegram.push(miraBot.token, messageFrom(bob, 1, 'Hello?'));
  await run.printedOnStderr("Telegram: Mira's bot gets its messages again.");
  expect(run.stderr()).toContain("Telegram cannot be reached for Mira's bot: ");

  // The app logs both streams; neither carries the token that rides in the
  // address of every call the bot makes.
  for (const output of [run.stdout(), run.stderr()]) {
    expect(output).not.toContain(miraBot.token);
  }
});

it('connectors.telegram-token-refused: a bot token Telegram refuses is named on stderr with the settings page to replace it on, and the other bots still start', async () => {
  const home = createHome({
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: '111111:unknown'}}},
        }),
      },
      nova: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: novaBot.token}}},
        }),
      },
    },
  });

  await startDaemon(home);

  const telegram = await startTelegramServer([novaBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printedOnStderr(
    "Telegram refused Mira's bot token. Replace it on Mira's settings page.",
  );
  await run.printed('Telegram: @nova_bot answers for Nova.');
});

it("connectors.telegram-bots-in-health: health says how each of the connector's bots stands, one Telegram named as on under its username and one whose token Telegram refuses as refused, and every surface hears of it; none is left once the connector stops, and a table sent while it is off the stream is refused", async () => {
  const home = createHome({
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: miraBot.token}}},
        }),
      },
      nova: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: '111111:unknown'}}},
        }),
      },
    },
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const watching = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);
  const bots = [
    miraOn,
    {target: {scope: 'character', characterId: 'nova'}, state: 'refused'},
  ];
  const heard = (connected: boolean, table: readonly object[]) =>
    watching.next(
      frameOf('health_changed', {
        health: {connectors: presence(connected, table)},
      }),
    );

  await heard(true, bots);
  // Nothing but these fields: no token is among them.
  expect(await wire.health()).toHaveProperty(
    'connectors',
    presence(true, bots),
  );
  run.signal('SIGINT');
  await run.exit();
  await heard(false, []);
  expect(await wire.connectorBots('telegram', {bots})).toMatchObject({
    status: 'refused',
    reason: 'not_connected',
  });
  expect(await wire.health()).toHaveProperty('connectors', presence(false, []));
});

it('connectors.telegram-bots-told-again: the connector tells a daemon started again how its bots stand, once it is back on the stream', async () => {
  const home = miraHome();
  const first = await startDaemon(home);
  const before = await openEvents(first);
  const telegram = await startTelegramServer([miraBot]);
  const told = {health: {connectors: presence(true, [miraOn])}};

  connector(['--store', home], telegram.env);
  await before.next(frameOf('health_changed', told));
  first.signal('SIGINT');
  await first.exit();

  const again = await openEvents(await startDaemon(home));

  // In the snapshot when the connector was back first, in a frame after
  // it otherwise.
  await again.holding('the bots to be told again', frames =>
    frames.find(
      frame =>
        frameOf('ready', told)(frame) || frameOf('health_changed', told)(frame),
    ),
  );
});
