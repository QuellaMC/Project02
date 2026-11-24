import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Events} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  calling,
  finish,
  reply,
  startModelServer,
  visibleReply,
  type ModelRequest,
} from './harness/model-server.ts';
import {
  messageFrom,
  startTelegramServer,
  textsIn,
  type Account,
  type TelegramServer,
} from './harness/telegram-server.ts';
import {conversationOf, converse, saveConfig, wireOf} from './harness/wire.ts';

const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';

/** `send_message` as she is offered it while she has one app, byte for byte as she always was. */
const sendMessage = {
  type: 'function',
  function: {
    name: 'send_message',
    description: 'Send a message to the one you write with.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message, exactly as you write it.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  },
};

/** The home's settings: the model server's provider, and these accounts paired. */
function homeSettings(
  model: {readonly settings: object},
  paired: readonly Account[],
): string {
  return configJson({
    project02: model.settings,
    connectors: {telegram: {config: {pairedUsers: pairedUsers(paired)}}},
  });
}

function pairedUsers(
  accounts: readonly Account[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    accounts.map(account => [String(account.id), account.first_name]),
  );
}

/** The home's allowlist, saved as its settings screen saves it. */
function pairing(...accounts: readonly Account[]): object {
  return {
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
    field: 'pairedUsers',
    value: pairedUsers(accounts),
  };
}

/** A home where Mira answers through the model server, her bot's token is set, and these accounts are paired. */
function miraHome(
  model: {readonly settings: object},
  paired: readonly Account[],
): string {
  return createHome({
    'config.json': homeSettings(model, paired),
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: miraBot.token}}},
        }),
      },
    },
  });
}

/** Settles once health says her bot is on: Telegram is an app of hers from then on. */
async function botOn(events: Events): Promise<void> {
  await events.next(
    frameOf('health_changed', {
      health: {
        connectors: [
          {
            id: 'telegram',
            bots: [
              {
                target: {scope: 'character', characterId: 'mira'},
                state: 'on',
              },
            ],
          },
        ],
      },
    }),
  );
}

/** The app the stream says her message `text` went in, once it says so. */
async function sentIn(events: Events, text: string): Promise<unknown> {
  const frame = await events.next(
    frameOf('turn_progress', {progress: {kind: 'visible_reply', text}}),
  );

  return (JSON.parse(frame.data ?? '{}') as {progress: {app: unknown}}).progress
    .app;
}

/** The tool a request offered the model first. */
function offeredFirst(request: ModelRequest | undefined): unknown {
  return (request?.body as {readonly tools: readonly unknown[]}).tools[0];
}

/** Settles once the bot has told the account a pairing code. */
async function toldACode(
  telegram: TelegramServer,
  account: Account,
): Promise<void> {
  await telegram.called(miraBot.token, calls =>
    textsIn(calls, account.id).some(
      text =>
        typeof text === 'string' &&
        text.startsWith('This bot is private. Your pairing code is '),
    )
      ? true
      : undefined,
  );
}

it('connectors.telegram-app-offered: with her bot on, send_message offers the app to send in, Messages and Telegram each by its name and its id; with no bot of hers, it is offered exactly as before', async () => {
  const model = await startModelServer();
  const home = miraHome(model, [alice]);
  const daemon = await startDaemon(home);
  const events = await openEvents(daemon);
  const say = await converse(wireOf(daemon), 'mira');

  model.answer(reply('Hello.'), reply('Hello again.'));
  await say('Before her bot.', 'before');

  const telegram = await startTelegramServer([miraBot]);

  connector(['--store', home], telegram.env);
  await botOn(events);
  await say('With her bot.', 'with');

  const {parameters} = sendMessage.function;

  expect(model.requests[0]?.text).toContain(JSON.stringify(sendMessage));
  expect(offeredFirst(model.requests[1])).toEqual({
    ...sendMessage,
    function: {
      ...sendMessage.function,
      parameters: {
        ...parameters,
        properties: {
          ...parameters.properties,
          app: {
            type: 'string',
            enum: ['messages', 'telegram'],
            description:
              'The app to send it in: Messages ("messages") or Telegram ("telegram"). Left out, it goes in the app the last message to you came in.',
          },
        },
      },
    },
  });
});

it('connectors.telegram-page-line: a line from the page that she answers naming no app is answered in Messages: Telegram is sent nothing of it, and the stream and the scrollback say Messages', async () => {
  const model = await startModelServer();
  const home = miraHome(model, [alice]);
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);

  connector(['--store', home], telegram.env);
  await botOn(events);

  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  model.answer(reply('Hello, page.'), reply('Hello, Alice.'));
  await say('From the page.', 'page');

  // A line from Telegram after it: once its answer is in, anything of the
  // page's line would be in before it.
  const pushed = performance.now();

  telegram.push(miraBot.token, messageFrom(alice, 1, 'From Telegram.'));
  await telegram.shows(miraBot.token, alice.id, 'Hello, Alice.');
  expect(
    telegram
      .calls(miraBot.token)
      .filter(call => call.body['chat_id'] !== undefined && call.at < pushed),
  ).toEqual([]);
  expect(textsIn(telegram.calls(miraBot.token), alice.id)).toEqual([
    'Hello, Alice.',
  ]);
  expect(await sentIn(events, 'Hello, page.')).toBe('messages');
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      {role: 'user', text: 'From the page.', app: 'messages'},
      {role: 'character', text: 'Hello, page.', app: 'messages'},
      {role: 'user', text: 'From Telegram.', app: 'telegram'},
      {role: 'character', text: 'Hello, Alice.', app: 'telegram'},
    ],
  });
});

it('connectors.telegram-line: a line from Telegram that she answers naming no app is answered there: its chat shows her typing, kept up while she writes, then gets her message whole, once, and the stream and the scrollback say Telegram', async () => {
  const model = await startModelServer();
  const home = miraHome(model, [alice]);
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);

  connector(['--store', home], telegram.env);
  await botOn(events);

  const held = model.hold();

  telegram.push(miraBot.token, messageFrom(alice, 1, 'Are you there?'));
  await held.arrived();
  // Telegram lets a typing mark go after about five seconds: while she
  // writes, the chat is shown it again.
  await telegram.called(miraBot.token, calls =>
    calls.filter(
      call =>
        call.method === 'sendChatAction' && call.body['chat_id'] === alice.id,
    ).length >= 3
      ? true
      : undefined,
  );
  // Her message streamed in two pieces, which the chat never sees apart.
  held.release({
    chunks: [...visibleReply('Here, Alice.', 13), finish('tool_calls')],
  });
  await telegram.shows(miraBot.token, alice.id, 'Here, Alice.');

  const inChat = telegram
    .calls(miraBot.token)
    .filter(call => call.body['chat_id'] === alice.id);

  expect(inChat[0]?.method).toBe('sendChatAction');
  expect(
    inChat
      .filter(call => call.method !== 'sendChatAction')
      .map(call => [call.method, call.body['text']]),
  ).toEqual([['sendMessage', 'Here, Alice.']]);
  expect(await sentIn(events, 'Here, Alice.')).toBe('telegram');

  const {conversationId} = await conversationOf(wire, 'mira');

  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      {role: 'user', text: 'Are you there?', app: 'telegram'},
      {role: 'character', text: 'Here, Alice.', app: 'telegram'},
    ],
  });
});

it('connectors.telegram-app-named: a message she sends naming Telegram goes to every paired chat though it answers a line from the page, and one naming Messages goes to none though it answers a line from Telegram; each is kept in the app named', async () => {
  const model = await startModelServer();
  const home = miraHome(model, [alice, bob]);
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);

  connector(['--store', home], telegram.env);
  await botOn(events);

  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  model.answer(
    calling(['send_message', {text: 'Hello, both of you.', app: 'telegram'}]),
    calling(['send_message', {text: 'Only in the app.', app: 'messages'}]),
    reply('Yes.'),
  );
  await say('Tell them both.', 'page');

  for (const account of [alice, bob]) {
    await telegram.shows(miraBot.token, account.id, 'Hello, both of you.');
  }

  // A line answered in Telegram after the one answered in Messages: once
  // its answer is in, the other would be in before it.
  telegram.push(
    miraBot.token,
    messageFrom(alice, 1, 'Just here?'),
    messageFrom(alice, 2, 'Still there?'),
  );
  await telegram.shows(miraBot.token, alice.id, 'Yes.');

  for (const account of [alice, bob]) {
    await telegram.shows(miraBot.token, account.id, 'Yes.');
    expect(textsIn(telegram.calls(miraBot.token), account.id)).toEqual([
      'Hello, both of you.',
      'Yes.',
    ]);
  }

  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      {role: 'user', text: 'Tell them both.', app: 'messages'},
      {role: 'character', text: 'Hello, both of you.', app: 'telegram'},
      {role: 'user', text: 'Just here?', app: 'telegram'},
      {role: 'character', text: 'Only in the app.', app: 'messages'},
      {role: 'user', text: 'Still there?', app: 'telegram'},
      {role: 'character', text: 'Yes.', app: 'telegram'},
    ],
  });
});

it('connectors.telegram-unpaired-mid-reply: a chat unpaired while her reply is written does not get it, and a line from it after is told a pairing code instead of being carried', async () => {
  const model = await startModelServer();
  const home = miraHome(model, [alice, bob]);
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(miraAnswers);

  const held = model.hold();

  telegram.push(miraBot.token, messageFrom(alice, 1, 'Tell me a story.'));
  await held.arrived();
  await saveConfig(wire, {scope: 'global'}, pairing(alice));
  held.release(reply('Once upon a time.'));
  await telegram.shows(miraBot.token, alice.id, 'Once upon a time.');
  // A later reply to Alice: whatever Bob was to get of the first is in.
  model.answer(reply('The end.'));
  telegram.push(miraBot.token, messageFrom(alice, 2, 'And then?'));
  await telegram.shows(miraBot.token, alice.id, 'The end.');
  expect(textsIn(telegram.calls(miraBot.token), bob.id)).toEqual([]);

  telegram.push(miraBot.token, messageFrom(bob, 1, 'Still there?'));
  await toldACode(telegram, bob);
});
