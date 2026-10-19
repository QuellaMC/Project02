import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {reply, startModelServer} from './harness/model-server.ts';
import {startRelay} from './harness/relay.ts';
import {
  messageFrom,
  startTelegramServer,
  type Account,
  type TelegramBot,
  type TelegramCall,
  type TelegramServer,
} from './harness/telegram-server.ts';
import {within} from './harness/wait.ts';
import {converse, wireOf} from './harness/wire.ts';

const homeBot = {token: '123456:home', id: 123456, username: 'home_bot'};
const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const novaBot = {token: '555555:nova', id: 555555, username: 'nova_bot'};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const carol = {id: 6161, first_name: 'Carol'};
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';
const pairingRequest = '/api/connectors/telegram/pairing';
const polled = {timeout: 50, allowed_updates: ['message', 'callback_query']};

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

it('connectors.telegram-long-poll: a bot polls for messages and button presses fifty seconds at a time, hands a batch on one update after another in order, asks past an update it cannot read, and asks past the batch only once all of it was handed on', async () => {
  const home = miraHome();

  await startDaemon(home);

  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot]);
  const bobAsked = relay.hold(pairingRequest);
  const carolAsked = relay.hold(pairingRequest);
  const run = connector(['--store', relay.home], telegram.env);

  await run.printed(miraAnswers);
  expect((await nthCall(telegram, miraBot, 'getUpdates', 0)).body).toEqual({
    offset: 0,
    ...polled,
  });

  const batch = [
    messageFrom(bob, 1, 'Hello?'),
    messageFrom(carol, 1, 'Hello?'),
    {
      ...messageFrom(carol, 2, 'Hello?'),
      message: {message_id: 'two', chat: {id: carol.id, type: 'private'}},
    },
  ];

  telegram.push(miraBot.token, ...batch);
  await bobAsked.answered();

  const bobReleased = performance.now();

  bobAsked.release();
  // Carol's message is handed on once Bob's was: her request comes after
  // his answer, though both came in one batch.
  expect((await carolAsked.arrived()).at).toBeGreaterThanOrEqual(bobReleased);
  await carolAsked.answered();

  const carolReleased = performance.now();

  carolAsked.release();

  const next = await nthCall(telegram, miraBot, 'getUpdates', 1);

  expect(next.at).toBeGreaterThanOrEqual(carolReleased);
  expect(next.body).toEqual({
    offset: (batch.at(-1)?.update_id ?? 0) + 1,
    ...polled,
  });
  expect(
    relay.requests
      .filter(request => request.path === pairingRequest)
      .map(
        request =>
          (JSON.parse(request.body) as {readonly subject: {id: string}}).subject
            .id,
      ),
  ).toEqual([String(bob.id), String(carol.id)]);
});

it('connectors.telegram-409: a bot whose waiting poll another program ends by polling the same token says so on stderr, naming the bot that waits', async () => {
  const home = miraHome();

  await startDaemon(home);

  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  await nthCall(telegram, miraBot, 'getUpdates', 0);

  // The test is the other program: a newer poll on the token ends the
  // bot's, as Telegram's server does.
  const other = await within(
    'the other program to poll the token',
    fetch(
      `${telegram.env.PROJECT02_TEST_TELEGRAM_API}/bot${miraBot.token}/getUpdates`,
      {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({offset: 0, timeout: 1}),
      },
    ),
  );

  await run.printedOnStderr(
    "Another program is polling Mira's bot (409); this one waits.",
  );
  expect(await other.json()).toEqual({ok: true, result: []});
});

it("connectors.telegram-webhook-removal: a webhook left on a bot's token is removed and said once on stderr, and the bot polls and answers", async () => {
  const home = miraHome();

  await startDaemon(home);

  const telegram = await startTelegramServer([miraBot]);

  telegram.setWebhook(miraBot.token);

  const run = connector(['--store', home], telegram.env);
  const removed =
    "Telegram was sending the messages for Mira's bot to a webhook, another program's; this connector removed it to poll. If that program should have them, give this connector a token of its own.";
  const back = "Telegram: Mira's bot gets its messages again.";

  await run.printed(miraAnswers);
  await run.printedOnStderr(removed);
  telegram.push(miraBot.token, messageFrom(bob, 1, 'Hello?'));
  await run.printedOnStderr(back);
  await telegram.called(miraBot.token, calls =>
    calls.find(call => call.body['chat_id'] === bob.id),
  );
  expect(
    telegram
      .calls(miraBot.token)
      .slice(0, 4)
      .map(call => call.method),
  ).toEqual(['getMe', 'getUpdates', 'deleteWebhook', 'getUpdates']);
  expect(run.stderr()).toBe(`${removed}\n${back}\n`);
});

it('connectors.telegram-retry-after: a call Telegram answers 429 with a retry_after, asking who the bot is, polling or sending, is made again once that pause is over, and nothing is reported unwritten', async () => {
  const home = miraHome([alice]);

  await startDaemon(home);

  const telegram = await startTelegramServer([miraBot]);
  const hello = "Hi, I'm Mira. Write to me here.";

  telegram.throttle(miraBot.token, 1, 'getMe');

  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);

  const [throttledMe, me] = telegram.calls(miraBot.token, 'getMe');

  expect((me?.at ?? 0) - (throttledMe?.at ?? 0)).toBeGreaterThanOrEqual(990);

  telegram.throttle(miraBot.token, 1, 'sendMessage');
  telegram.push(miraBot.token, messageFrom(alice, 1, '/start'));

  const sent = await telegram.called(miraBot.token, calls => {
    const hellos = calls.filter(call => call.method === 'sendMessage');

    return hellos.length === 2 ? hellos : undefined;
  });

  expect(sent.map(call => call.body['text'])).toEqual([hello, hello]);
  expect((sent[1]?.at ?? 0) - (sent[0]?.at ?? 0)).toBeGreaterThanOrEqual(990);

  const polls = telegram.calls(miraBot.token, 'getUpdates').length;

  telegram.throttle(miraBot.token, 1, 'getUpdates');
  telegram.push(miraBot.token, messageFrom(alice, 2, '/start'));

  const throttledPoll = await nthCall(telegram, miraBot, 'getUpdates', polls);
  const nextPoll = await nthCall(telegram, miraBot, 'getUpdates', polls + 1);

  expect(nextPoll.at - throttledPoll.at).toBeGreaterThanOrEqual(990);
  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  expect(run.stderr()).not.toContain('could not write');
});

it('connectors.telegram-unreachable: a bot that cannot reach Telegram says so once on stderr, polls again a second later, then two seconds after that, and says it gets its messages again once Telegram is back', async () => {
  const home = miraHome();

  await startDaemon(home);

  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);
  const back = "Telegram: Mira's bot gets its messages again.";

  await run.printed(miraAnswers);
  await nthCall(telegram, miraBot, 'getUpdates', 0);

  const cut = performance.now();

  telegram.away();

  const failed = await nthCall(telegram, miraBot, 'getUpdates', 1);

  telegram.back();

  const answered = await nthCall(telegram, miraBot, 'getUpdates', 2);

  telegram.push(miraBot.token, messageFrom(bob, 1, 'Hello?'));
  await run.printedOnStderr(back);
  expect(failed.at - cut).toBeGreaterThanOrEqual(990);
  expect(answered.at - failed.at).toBeGreaterThanOrEqual(1_990);
  expect(run.stderr()).toMatch(
    new RegExp(
      `^Telegram cannot be reached for Mira's bot: Telegram could not be reached: [^\\n]+\\n${back.replaceAll('.', '\\.')}\\n$`,
      'u',
    ),
  );
});

it('connectors.telegram-token-refused: a bot token Telegram refuses at the start or revokes later is named once on stderr with the settings page to replace it on, and that bot goes quiet: a later turn it would show writes nothing and reports nothing unwritten', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      connectors: {
        telegram: {
          config: {
            managementBotToken: homeBot.token,
            pairedUsers: {[String(alice.id)]: 'Alice'},
          },
        },
      },
    }),
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
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([homeBot, novaBot]);
  const run = connector(['--store', home], telegram.env);
  const refused = (name: string) =>
    `Telegram refused ${name}'s bot token. Replace it on ${name}'s settings page.`;

  await run.printedOnStderr(refused('Mira'));
  await run.printed('Telegram: @nova_bot answers for Nova.');
  telegram.revokeBot(novaBot.token);
  await run.printedOnStderr(refused('Nova'));

  const asked = telegram.calls(novaBot.token).length;
  const sayToNova = await converse(wire, 'nova');

  // Her bot would show this turn, Mirror being on: it shows nothing now.
  model.answer(reply('Hello from Nova.'));
  await sayToNova('Hello, Nova.', 'web');
  // The same connector's next answer, on another bot, comes after
  // anything that turn could have had it write.
  telegram.push(homeBot.token, messageFrom(alice, 1, '/status'));
  await telegram.called(homeBot.token, calls =>
    calls.find(call => call.body['chat_id'] === alice.id),
  );
  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  expect(telegram.calls(novaBot.token)).toHaveLength(asked);
  expect(run.stderr()).toBe(`${refused('Mira')}\n${refused('Nova')}\n`);
});
