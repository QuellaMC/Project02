import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {reply, startModelServer} from './harness/model-server.ts';
import {startRelay} from './harness/relay.ts';
import {
  messageFrom,
  startTelegramServer,
  textsIn,
  type Account,
  type TelegramBot,
} from './harness/telegram-server.ts';
import {
  conversationOf,
  converse,
  saveConfig,
  wireOf,
  type Wire,
} from './harness/wire.ts';

const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const novaBot = {token: '555555:nova', id: 555555, username: 'nova_bot'};
const replacedBot = {
  token: '987655:replaced',
  id: 987655,
  username: 'mira_new_bot',
};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const carol = {id: 6161, first_name: 'Carol'};
const mira = {scope: 'character', characterId: 'mira'} as const;
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';

/** The home's settings: the model server's provider, and these accounts paired. */
function homeSettings(
  model: {readonly settings: object},
  paired: readonly Account[],
): string {
  return configJson({
    project02: model.settings,
    connectors: {
      telegram: {
        config: {
          pairedUsers: Object.fromEntries(
            paired.map(account => [String(account.id), account.first_name]),
          ),
        },
      },
    },
  });
}

/** A character's own settings: her bot's token. */
function botSettings(bot: TelegramBot): string {
  return configJson({
    connectors: {telegram: {config: {botToken: bot.token}}},
  });
}

/** The user lines of Mira's conversation, as history reads them back. */
async function userLines(wire: Wire): Promise<readonly unknown[]> {
  const {conversationId} = await conversationOf(wire, 'mira');
  const {messages} = (await wire.history(conversationId)) as {
    readonly messages: readonly {readonly role: string}[];
  };

  return messages.filter(message => message.role === 'user');
}

function dataOf(frame: Frame): Record<string, unknown> {
  return JSON.parse(frame.data ?? '') as Record<string, unknown>;
}

it('connectors.telegram-pairing-gate: an account the home does not know gets a pairing code good for what its request has left and nothing it says is carried, is told what the code has left when it asks again, and once approved is told it is paired and its lines are carried; one declined is told the owner declined', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, []),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  // A request good for a minute and two seconds: what it has left is two
  // minutes when it is made, and one minute two seconds later.
  const daemon = await startDaemon(home, {
    PROJECT02_TEST_DURATIONS: 'pairing=62000,heartbeat=2100',
  });
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  telegram.push(miraBot.token, messageFrom(bob, 1, 'Let me in.'));

  const asked = dataOf(await events.next(frameOf('pairing_requested')));
  const code = String(asked['code']);
  const told = (left: string) =>
    `This bot is private. Your pairing code is ${code}, good for ${left}. Approve it on the web page, or send it to the management bot.`;

  expect(asked['subject']).toEqual({id: String(bob.id), label: 'Bob (@bob)'});
  await telegram.shows(miraBot.token, bob.id, told('2 minutes'));

  // A stream opened now pings two seconds and more on.
  const clock = await openEvents(daemon);

  await clock.next(frame => frame.comment === 'ping');
  telegram.push(miraBot.token, messageFrom(bob, 2, 'Still waiting.'));
  await telegram.shows(miraBot.token, bob.id, told('1 minute'));
  expect(await wire.pairingAnswer(code, 'approved')).toMatchObject({
    status: 'settled',
  });
  await telegram.shows(miraBot.token, bob.id, 'Paired. Mira is listening.');
  model.answer(reply('Hello, Bob.'));
  telegram.push(miraBot.token, messageFrom(bob, 3, 'Hello, Mira.'));
  await telegram.shows(miraBot.token, bob.id, 'Hello, Bob.');
  expect(await userLines(wire)).toMatchObject([{text: 'Hello, Mira.'}]);

  telegram.push(miraBot.token, messageFrom(carol, 1, 'Me too.'));

  const declined = dataOf(
    await events.next(
      frameOf('pairing_requested', {subject: {id: String(carol.id)}}),
    ),
  );

  expect(
    await wire.pairingAnswer(String(declined['code']), 'denied'),
  ).toMatchObject({status: 'settled'});
  await telegram.shows(miraBot.token, carol.id, 'The owner declined.');
});

it("connectors.telegram-pairing-refused: an account a bot cannot ask the daemon to pair, the home's settings unreadable, is told the bot cannot take a pairing request right now, and stderr says why in the daemon's words", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, []),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  writeFileSync(join(home, 'config.json'), '{"version":');

  const {message} = (await wire.pairingRequest('telegram', {
    id: '1',
    label: 'Someone',
  })) as {readonly message: string};

  telegram.push(miraBot.token, messageFrom(bob, 1, 'Let me in.'));
  await telegram.shows(
    miraBot.token,
    bob.id,
    'This bot is private, and cannot take a pairing request right now; try again later.',
  );
  await run.printedOnStderr(
    `Mira's bot could not ask to pair Bob (@bob): ${message}`,
  );
});

it("connectors.telegram-carry-line: a paired account's line reaches the character as the local user's, stamped with the bot's source and an id naming the bot, the chat and the message, and two lines that came together reach her in order though her conversation had to be opened first", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice]),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  const wire = wireOf(await startDaemon(home));
  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot]);
  // Every open of her conversation is held, so the lines come while it is
  // not known yet.
  const opens = Array.from({length: 5}, () =>
    relay.hold('/api/conversations/open'),
  );
  const run = connector(['--store', relay.home], telegram.env);

  await run.printed(miraAnswers);
  await opens[0]?.arrived();
  model.answer(reply('First, noted.'), reply('Second, noted.'));
  telegram.push(
    miraBot.token,
    messageFrom(alice, 7, 'First line.'),
    messageFrom(alice, 8, 'Second line.'),
    messageFrom(alice, 9, '/start'),
  );
  // Greeted without her conversation, after both lines were taken: by
  // then each open they asked for is held, and the later ones go first.
  await telegram.shows(
    miraBot.token,
    alice.id,
    "Hi, I'm Mira. Write to me here.",
  );

  for (const held of opens.toReversed()) {
    held.release();
  }

  await telegram.shows(miraBot.token, alice.id, 'Second, noted.');

  const {conversationId} = await conversationOf(wire, 'mira');

  expect(await wire.history(conversationId)).toMatchObject({
    messages: [
      {
        role: 'user',
        speakerId: 'local-user',
        text: 'First line.',
        source: 'telegram:mira_bot',
        clientMessageId: '987654.4242.7',
      },
      {role: 'character', text: 'First, noted.'},
      {
        role: 'user',
        speakerId: 'local-user',
        text: 'Second line.',
        source: 'telegram:mira_bot',
        clientMessageId: '987654.4242.8',
      },
      {role: 'character', text: 'Second, noted.'},
    ],
  });
});

it('connectors.telegram-redelivery-idempotent: a message Telegram hands on again that the daemon took already brings nothing new to the chat or the model and is in the log once, and a line to a bot that replaced hers is carried though Telegram numbers its messages from one again', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice]),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([miraBot, replacedBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  model.answer(reply('Hello, Alice.'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Hello.'));
  await telegram.shows(miraBot.token, alice.id, 'Hello, Alice.');

  const before = textsIn(telegram.calls(miraBot.token), alice.id);

  telegram.push(miraBot.token, messageFrom(alice, 1, 'Hello.'));
  // A line after it, carried after it: once its reply is in, all the
  // repeat brought is in too.
  model.answer(reply('Still here.'));
  telegram.push(miraBot.token, messageFrom(alice, 2, 'Still there?'));
  await telegram.shows(miraBot.token, alice.id, 'Still here.');
  expect(textsIn(telegram.calls(miraBot.token), alice.id)).toEqual([
    ...before,
    'Still here.',
  ]);
  expect(model.requests).toHaveLength(2);

  await saveConfig(wire, mira, {
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
    field: 'botToken',
    value: replacedBot.token,
  });
  await run.printed('Telegram: @mira_new_bot answers for Mira.');
  model.answer(reply('Same Mira, new bot.'));
  telegram.push(replacedBot.token, messageFrom(alice, 1, 'New bot?'));
  await telegram.shows(replacedBot.token, alice.id, 'Same Mira, new bot.');
  expect(await userLines(wire)).toMatchObject([
    {text: 'Hello.', clientMessageId: '987654.4242.1'},
    {text: 'Still there?', clientMessageId: '987654.4242.2'},
    {text: 'New bot?', clientMessageId: '987655.4242.1'},
  ]);
});

it('connectors.telegram-private-text-only: nothing is carried from a group chat or from a message without text, and a sticker in a private chat is told the bot reads only text', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice]),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);
  const group = {id: -1_002_003, type: 'group'};

  await run.printed(miraAnswers);
  telegram.push(
    miraBot.token,
    messageFrom(alice, 1, 'Hello, everyone.', group),
    messageFrom(alice, 2, undefined),
  );
  await telegram.shows(
    miraBot.token,
    alice.id,
    'I can only read text here for now.',
  );
  // A line carried after both: once its reply is in, either of them
  // carried would be in the log before it.
  model.answer(reply('Hello, Alice.'));
  telegram.push(miraBot.token, messageFrom(alice, 3, 'Hello.'));
  await telegram.shows(miraBot.token, alice.id, 'Hello, Alice.');
  expect(textsIn(telegram.calls(miraBot.token), group.id)).toEqual([]);
  expect(await userLines(wire)).toMatchObject([{text: 'Hello.'}]);
  expect(model.requests).toHaveLength(1);
});

it("connectors.telegram-turn-ended-told: the chat a line came from is told once why it got no answer, in the daemon's words: its character not running, a turn that ended without a reply, or a line the daemon would not take, asked for again", async () => {
  const model = await startModelServer();
  // A provider chosen for Mira alone: Nova's bot runs, and she does not.
  const home = createHome({
    'config.json': configJson({
      connectors: {
        telegram: {config: {pairedUsers: {[String(alice.id)]: 'Alice'}}},
      },
    }),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {
        'config.json': configJson({
          project02: model.settings,
          connectors: {telegram: {config: {botToken: miraBot.token}}},
        }),
      },
      nova: {'config.json': botSettings(novaBot)},
    },
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot, novaBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  await run.printed('Telegram: @nova_bot answers for Nova.');

  const unavailable = (await wire.open('nova')) as {readonly message: string};
  const notRunning = `Nova is not available right now: ${unavailable.message}`;

  telegram.push(novaBot.token, messageFrom(alice, 1, 'Hello, Nova.'));
  await telegram.shows(novaBot.token, alice.id, notRunning);

  model.answer({status: 401, body: {error: {message: 'Who are you?'}}});
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Hello, Mira.'));

  const unanswered = dataOf(
    await events.next(
      frameOf('turn_completed', {clientMessageId: '987654.4242.1'}),
    ),
  );

  await telegram.shows(
    miraBot.token,
    alice.id,
    `Mira could not answer: ${String(unanswered['message'])}`,
  );
  telegram.push(miraBot.token, messageFrom(alice, 2, 'Two\nlines.'));
  await telegram.shows(
    miraBot.token,
    alice.id,
    'Mira could not answer: Provide exactly one non-empty single-line message.\nYour message was not taken; send it again.',
  );

  // A line answered after each: once its reply is in, a second telling
  // would be in before it.
  model.answer(reply('Hello, Alice.'));
  telegram.push(miraBot.token, messageFrom(alice, 3, 'Hello?'));
  await telegram.shows(miraBot.token, alice.id, 'Hello, Alice.');
  telegram.push(novaBot.token, messageFrom(alice, 2, 'Nova?'));
  await telegram.called(novaBot.token, calls =>
    textsIn(calls, alice.id).length === 2 ? true : undefined,
  );
  expect(textsIn(telegram.calls(novaBot.token), alice.id)).toEqual([
    notRunning,
    notRunning,
  ]);
  expect(textsIn(telegram.calls(miraBot.token), alice.id)).toEqual([
    `Mira could not answer: ${String(unanswered['message'])}`,
    'Mira could not answer: Provide exactly one non-empty single-line message.\nYour message was not taken; send it again.',
    'Hello, Alice.',
  ]);
});

it('connectors.telegram-held-while-daemon-down: a line written while the daemon is down waits, and is carried once the daemon is back', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice]),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  const first = await startDaemon(home);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);
  model.answer(reply('Hello, Alice.'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Hello.'));
  await telegram.shows(miraBot.token, alice.id, 'Hello, Alice.');
  first.signal('SIGINT');
  await first.exit();
  await run.printed(
    `Telegram connector: waiting for the daemon on ${home}; run pnpm serve.`,
  );
  telegram.push(miraBot.token, messageFrom(alice, 2, 'Anyone there?'));

  const back = await startDaemon(home);

  model.answer(reply('Here again.'));
  await telegram.shows(miraBot.token, alice.id, 'Here again.');
  expect(await userLines(wireOf(back))).toMatchObject([
    {text: 'Hello.'},
    {text: 'Anyone there?'},
  ]);
});

it("connectors.telegram-mirror: another surface's turn is shown in each paired chat, its line as the person's and then the reply, those committed while her conversation was refused 503 or not yet opened shown once it is; a line the bot carried is not repeated; and with Mirror off another surface's turn is not shown", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice, bob]),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot]);

  relay.refuse('/api/conversations/open', 503);

  const opened = relay.hold('/api/conversations/open');
  const run = connector(['--store', relay.home], telegram.env);

  await run.printed(miraAnswers);

  const sayOnWeb = await converse(wire, 'mira');

  await relay.reached(requests =>
    requests.some(request => request.path === '/api/conversations/open')
      ? true
      : undefined,
  );
  model.answer(reply('Hello, web.'));
  await sayOnWeb('From the web.', 'web-1');
  await opened.arrived();
  model.answer(reply('Hello again, web.'));
  await sayOnWeb('Back on the web.', 'web-2');
  opened.release();

  const mirrored = [
    'You (web): From the web.',
    'Hello, web.',
    'You (web): Back on the web.',
    'Hello again, web.',
  ];

  for (const account of [alice, bob]) {
    await telegram.shows(miraBot.token, account.id, 'Hello again, web.');
    expect(textsIn(telegram.calls(miraBot.token), account.id)).toEqual(
      mirrored,
    );
  }

  model.answer(reply('Hello, Alice.'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Hello, Mira.'));
  await telegram.shows(miraBot.token, bob.id, 'Hello, Alice.');
  await saveConfig(wire, mira, {
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
    field: 'mirror',
    value: false,
  });
  model.answer(reply('Quietly, web.'));
  await sayOnWeb('Quiet now.', 'web-3');
  model.answer(reply('Hello again, Alice.'));
  telegram.push(miraBot.token, messageFrom(alice, 2, 'Still there?'));

  for (const account of [alice, bob]) {
    await telegram.shows(miraBot.token, account.id, 'Hello again, Alice.');
    expect(textsIn(telegram.calls(miraBot.token), account.id)).toEqual([
      ...mirrored,
      'Hello, Alice.',
      'Hello again, Alice.',
    ]);
  }
});

it('connectors.telegram-split-4096: a reply or a mirrored line longer than one Telegram message arrives whole in as many messages as it takes, in order', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice]),
    'character-data': {mira: {'config.json': botSettings(miraBot)}},
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);
  const long = (word: string) =>
    Array.from({length: 1_000}, (_, at) => `${word}${String(at)}`).join(' ');
  const answer = long('a');
  const line = long('q');

  await run.printed(miraAnswers);
  model.answer(reply(answer));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Tell me everything.'));
  await telegram.shows(miraBot.token, alice.id, answer.slice(4096));
  expect(textsIn(telegram.calls(miraBot.token), alice.id)).toEqual([
    answer.slice(0, 4096),
    answer.slice(4096),
  ]);

  const sayOnWeb = await converse(wire, 'mira');
  const mirrored = `You (web): ${line}`;

  model.answer(reply('All of it.'));
  await sayOnWeb(line, 'web-long');
  await telegram.shows(miraBot.token, alice.id, 'All of it.');
  expect(textsIn(telegram.calls(miraBot.token), alice.id).slice(2)).toEqual([
    mirrored.slice(0, 4096),
    mirrored.slice(4096),
    'All of it.',
  ]);
});
