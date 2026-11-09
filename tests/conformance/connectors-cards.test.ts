import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Events} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {calling, reply, startModelServer} from './harness/model-server.ts';
import {
  messageFrom,
  pressOn,
  startTelegramServer,
  type Account,
  type TelegramBot,
  type TelegramCall,
  type TelegramServer,
} from './harness/telegram-server.ts';
import {converse, wireOf, type Wire} from './harness/wire.ts';

const homeBot = {token: '123456:home', id: 123456, username: 'home_bot'};
const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
/** The stamp of a bot this connector does not run, which a pairing request may name. */
const otherBot = 'telegram:other_bot';
const mira = {scope: 'character', characterId: 'mira'} as const;

type Parked = {
  readonly id: string;
  readonly request: {readonly summary: string; readonly preview: object};
};

type Asked = {
  readonly code: string;
  readonly subject: {readonly id: string; readonly label: string};
  readonly source: string;
};

/** A home where Mira's bot answers, the bundled plugin whose fields the model may ask to change is on, and these accounts are paired. */
function cardsHome(
  model: {readonly settings: object},
  paired: readonly Account[],
  managementBot?: TelegramBot,
): string {
  return createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
      connectors: {
        telegram: {
          config: {
            pairedUsers: Object.fromEntries(
              paired.map(account => [String(account.id), account.first_name]),
            ),
            ...(managementBot === undefined
              ? {}
              : {managementBotToken: managementBot.token}),
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

/** The model asking to set one of the demo plugin's fields on Mira, against the fingerprint her settings hand out now. */
async function asksToSet(wire: Wire, fieldName: string, value: string) {
  const view = (await wire.configView(mira)) as {readonly fingerprint: string};

  return calling([
    'runtime_plugin_config_update',
    {
      pluginId: 'demo-config',
      fieldName,
      operation: 'set',
      value,
      expectedFingerprint: view.fingerprint,
    },
  ]);
}

async function nextParked(events: Events): Promise<Parked> {
  return JSON.parse(
    (await events.next(frameOf('confirmation_requested'))).data ?? '',
  ) as Parked;
}

/** A card's words with what its deadline has left, which the wall clock decides as the card is written, shown as `…`. */
function timeless(words: unknown): unknown {
  return typeof words === 'string'
    ? words.replace(/(?<=xpires in )\d+ minutes?/u, '…')
    : words;
}

/** A confirmation as its card says it: who wants what, where it was raised when that is said, the preview, and until it ends that its deadline has time left. */
function confirmationCard(
  pending: Parked,
  options: {readonly raisedOn?: string; readonly ended?: boolean} = {},
): string {
  return [
    `Mira wants to: ${pending.request.summary}` +
      (options.raisedOn === undefined
        ? ''
        : ` · raised on ${options.raisedOn}`),
    JSON.stringify(pending.request.preview, null, 2),
    ...(options.ended === true ? [] : ['Expires in …']),
  ].join('\n');
}

/** A pairing request as its card says it: who wants to pair, via the source they wrote to, the code, and until it ends that its deadline has time left. */
function pairingCard(asked: Asked, ended = false): string {
  return (
    `${asked.subject.label} wants to pair via ${asked.source} · code ${asked.code}` +
    (ended ? '' : ' · expires in …')
  );
}

/** Approve and Deny for what a card asks about. */
function buttons(letter: 'c' | 'p', key: string): object {
  return {
    inline_keyboard: [
      [
        {text: 'Approve', callback_data: `${letter}:${key}:a`},
        {text: 'Deny', callback_data: `${letter}:${key}:d`},
      ],
    ],
  };
}

/** A card's body as these tests compare it: its words with the time left taken out. */
function cardBody(card: TelegramCall | undefined): object {
  return {...card?.body, text: timeless(card?.body['text'])};
}

/** The cards a bot sent to one chat: its messages with buttons. */
function cardsIn(
  calls: readonly TelegramCall[],
  account: Account,
): readonly TelegramCall[] {
  return calls.filter(
    call =>
      call.method === 'sendMessage' &&
      call.body['chat_id'] === account.id &&
      call.body['reply_markup'] !== undefined,
  );
}

/** Settles once the bot has sent the account this many cards. */
async function cardsSent(
  telegram: TelegramServer,
  bot: TelegramBot,
  account: Account,
  count: number,
) {
  return telegram.called(bot.token, calls => {
    const cards = cardsIn(calls, account);

    return cards.length >= count ? cards : undefined;
  });
}

/** Settles on the bot's edit of one message in the account's chat to these words. */
function edited(
  telegram: TelegramServer,
  bot: TelegramBot,
  account: Account,
  messageId: number,
  text: string,
): Promise<TelegramCall> {
  return telegram.called(bot.token, calls =>
    calls.find(
      call =>
        call.method === 'editMessageText' &&
        call.body['chat_id'] === account.id &&
        call.body['message_id'] === messageId &&
        call.body['text'] === text,
    ),
  );
}

/** Settles on the bot's answer to a press, once it has given one. */
function toast(
  telegram: TelegramServer,
  bot: TelegramBot,
  press: {readonly update_id: number},
): Promise<TelegramCall> {
  return telegram.called(bot.token, calls =>
    calls.find(
      call =>
        call.method === 'answerCallbackQuery' &&
        call.body['callback_query_id'] === String(press.update_id),
    ),
  );
}

it("connectors.telegram-cards: a confirmation a bot's line raised is a card with Approve and Deny in that line's chat; a press answers the daemon, behind a line written while the card waits too, and is answered with the outcome; the turn goes on to its reply, the line after it is answered next, and the card is edited to how it ended, its buttons gone", async () => {
  const model = await startModelServer();
  const home = cardsHome(model, [alice]);
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed('Telegram: @mira_bot answers for Mira.');
  model.answer(
    await asksToSet(wire, 'tone', 'pirate'),
    reply('Arr.'),
    reply('Yo ho ho.'),
  );
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Talk like a pirate.'));

  const pirate = await nextParked(events);
  const [card] = await cardsSent(telegram, miraBot, alice, 1);

  expect(cardBody(card)).toEqual({
    chat_id: alice.id,
    text: confirmationCard(pirate),
    reply_markup: buttons('c', pirate.id),
  });

  const sing = messageFrom(alice, 2, 'And sing.');
  const approve = pressOn(alice, card?.messageId ?? 0, `c:${pirate.id}:a`);

  telegram.push(miraBot.token, sing, approve);
  expect((await toast(telegram, miraBot, approve)).body).toEqual({
    callback_query_id: String(approve.update_id),
    text: 'Approved.',
  });
  await telegram.shows(miraBot.token, alice.id, 'Arr.');
  expect(
    (
      await edited(
        telegram,
        miraBot,
        alice,
        card?.messageId ?? 0,
        `${confirmationCard(pirate, {ended: true})} · approved`,
      )
    ).body,
  ).not.toHaveProperty('reply_markup');
  await telegram.shows(miraBot.token, alice.id, 'Yo ho ho.');
});

it('connectors.telegram-management-bot: the management bot posts what waits when it starts, every confirmation of the home as a card naming the surface it was raised on and every pairing request as a card naming the source its account wrote to, whose Approve pairs the account', async () => {
  const model = await startModelServer();
  const home = cardsHome(model, [alice], homeBot);
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const sayOnWeb = await converse(wire, 'mira');

  model.answer(await asksToSet(wire, 'tone', 'pirate'), reply('Arr.'));

  const webTurn = sayOnWeb('Talk like a pirate.', 'web');
  const pending = await nextParked(events);
  const fromBob = (
    (await wire.pairingRequest('telegram', {
      subject: {id: String(bob.id), label: 'Bob (@bob)'},
      source: otherBot,
    })) as {readonly request: Asked}
  ).request;
  const telegram = await startTelegramServer([homeBot, miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed('Telegram: management bot @home_bot is on.');

  const waiting = await cardsSent(telegram, homeBot, alice, 2);

  expect(waiting.map(cardBody)).toEqual([
    {
      chat_id: alice.id,
      text: confirmationCard(pending, {raisedOn: 'web'}),
      reply_markup: buttons('c', pending.id),
    },
    {
      chat_id: alice.id,
      text: pairingCard(fromBob),
      reply_markup: buttons('p', fromBob.code),
    },
  ]);

  const bobsCard = waiting[1]?.messageId ?? 0;
  const approve = pressOn(alice, bobsCard, `p:${fromBob.code}:a`);

  telegram.push(homeBot.token, approve);
  expect((await toast(telegram, homeBot, approve)).body['text']).toBe(
    'Approved.',
  );
  await edited(
    telegram,
    homeBot,
    alice,
    bobsCard,
    `${pairingCard(fromBob, true)} · approved`,
  );
  expect(
    JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')),
  ).toMatchObject({
    connectors: {
      telegram: {config: {pairedUsers: {[String(bob.id)]: 'Bob (@bob)'}}},
    },
  });

  await wire.answer(pending.id, 'denied');
  await webTurn;
});
