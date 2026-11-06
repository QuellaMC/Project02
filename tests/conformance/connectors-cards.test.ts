import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Events} from './harness/events.ts';
import {chmod, configJson, createHome} from './harness/home.ts';
import {calling, reply, startModelServer} from './harness/model-server.ts';
import {startRelay} from './harness/relay.ts';
import {
  messageFrom,
  pressOn,
  startTelegramServer,
  type Account,
  type TelegramBot,
  type TelegramCall,
  type TelegramServer,
} from './harness/telegram-server.ts';
import {converse, saveConfig, wireOf, type Wire} from './harness/wire.ts';

const homeBot = {token: '123456:home', id: 123456, username: 'home_bot'};
const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const carol = {id: 6161, first_name: 'Carol'};
const dave = {id: 7171, first_name: 'Dave'};
const erin = {id: 8181, first_name: 'Erin'};
/** The stamp of a bot this connector does not run, which a pairing request may name. */
const otherBot = 'telegram:other_bot';
const mira = {scope: 'character', characterId: 'mira'} as const;

type Parked = {
  readonly id: string;
  readonly deadlineAt: number;
  readonly request: {readonly summary: string; readonly preview: object};
};

type Asked = {
  readonly code: string;
  readonly subject: {readonly id: string; readonly label: string};
  readonly source: string;
  readonly expiresAt: number;
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

async function nextAsked(events: Events, account: Account): Promise<Asked> {
  return JSON.parse(
    (
      await events.next(
        frameOf('pairing_requested', {subject: {id: String(account.id)}}),
      )
    ).data ?? '',
  ) as Asked;
}

/** What a deadline has left, in whole minutes rounded up, as a card says it. */
function left(deadlineAt: number): string {
  const minutes = Math.max(1, Math.ceil((deadlineAt - Date.now()) / 60_000));

  return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** A confirmation as its card says it: who wants what, where it was raised when that is said, the preview, and what its deadline has left until it ends. */
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
    ...(options.ended === true
      ? []
      : [`Expires in ${left(pending.deadlineAt)}`]),
  ].join('\n');
}

/** A pairing request as its card says it: who wants to pair, via the source they wrote to, the code, and what its deadline has left until it ends. */
function pairingCard(asked: Asked, ended = false): string {
  return (
    `${asked.subject.label} wants to pair via ${asked.source} · code ${asked.code}` +
    (ended ? '' : ` · expires in ${left(asked.expiresAt)}`)
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

it("connectors.telegram-cards: a confirmation a bot's line raised is a card with Approve and Deny in that line's chat, cut with an ellipsis to one message when it runs past one; a press answers the daemon and is answered with the outcome, the turn goes on to its reply, and the card is edited to how it ended, its buttons gone, as is a card whose confirmation was settled while the bot was away", async () => {
  const model = await startModelServer();
  const home = cardsHome(model, [alice]);
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', relay.home], telegram.env);

  await run.printed('Telegram: @mira_bot answers for Mira.');
  model.answer(await asksToSet(wire, 'tone', 'pirate'), reply('Arr.'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Talk like a pirate.'));

  const pirate = await nextParked(events);
  const [first] = await cardsSent(telegram, miraBot, alice, 1);

  expect(first?.body).toEqual({
    chat_id: alice.id,
    text: confirmationCard(pirate),
    reply_markup: buttons('c', pirate.id),
  });

  const approve = pressOn(alice, first?.messageId ?? 0, `c:${pirate.id}:a`);

  telegram.push(miraBot.token, approve);
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
        first?.messageId ?? 0,
        `${confirmationCard(pirate, {ended: true})} · approved`,
      )
    ).body,
  ).not.toHaveProperty('reply_markup');

  model.answer(
    await asksToSet(wire, 'signoff', 'x'.repeat(5_000)),
    reply('Signed.'),
  );
  telegram.push(miraBot.token, messageFrom(alice, 2, 'Sign off at length.'));

  const long = await nextParked(events);
  const [, second] = await cardsSent(telegram, miraBot, alice, 2);
  const deny = pressOn(alice, second?.messageId ?? 0, `c:${long.id}:d`);
  const denied = ' · denied';

  expect(second?.body['text']).toBe(
    `${confirmationCard(long).slice(0, 4_095)}…`,
  );
  telegram.push(miraBot.token, deny);
  expect((await toast(telegram, miraBot, deny)).body['text']).toBe('Denied.');
  await edited(
    telegram,
    miraBot,
    alice,
    second?.messageId ?? 0,
    `${confirmationCard(long, {ended: true}).slice(0, 4_095 - denied.length)}…${denied}`,
  );
  await telegram.shows(miraBot.token, alice.id, 'Signed.');

  model.answer(await asksToSet(wire, 'tone', 'formal'), reply('Never mind.'));
  telegram.push(miraBot.token, messageFrom(alice, 3, 'Be formal.'));

  const formal = await nextParked(events);
  const [, , third] = await cardsSent(telegram, miraBot, alice, 3);

  // Away while the daemon stops, which settles it: the ready that comes
  // back no longer carries it.
  relay.away();
  daemon.signal('SIGINT');
  await daemon.exit();
  await startDaemon(home);
  relay.back();
  await edited(
    telegram,
    miraBot,
    alice,
    third?.messageId ?? 0,
    `${confirmationCard(formal, {ended: true})} · settled while the bot was away`,
  );
});

it("connectors.telegram-management-bot: the management bot shows every confirmation of the home as a card naming the surface it was raised on and every pairing request as a card naming the source its account wrote to, whose Approve pairs the account, posts those already waiting when it starts, answers a paired account's /status, /approve, /deny and /pending, and keeps what arrives while nobody is paired for the first account paired", async () => {
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

  expect(waiting.map(card => card.body)).toEqual([
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

  telegram.push(homeBot.token, messageFrom(alice, 1, '/status'));
  await telegram.shows(homeBot.token, alice.id, 'Mira: ready');

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

  telegram.push(homeBot.token, messageFrom(alice, 2, '/approve 000000'));
  await telegram.shows(homeBot.token, alice.id, 'That code is not waiting.');
  telegram.push(miraBot.token, messageFrom(carol, 1, 'Me too.'));

  const fromCarol = await nextAsked(events, carol);

  telegram.push(
    homeBot.token,
    messageFrom(alice, 3, `/deny ${fromCarol.code}`),
  );
  await telegram.shows(homeBot.token, alice.id, 'Denied.');
  await telegram.shows(miraBot.token, carol.id, 'The owner declined.');

  // Nobody paired: what arrives now waits for the first account paired.
  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'section_field_set',
      namespace: 'connectors',
      id: 'telegram',
      field: 'pairedUsers',
      value: {},
    },
  );
  telegram.push(miraBot.token, messageFrom(dave, 1, 'Hello?'));

  const fromDave = await nextAsked(events, dave);

  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'section_field_set',
      namespace: 'connectors',
      id: 'telegram',
      field: 'pairedUsers',
      value: {[String(erin.id)]: 'Erin'},
    },
  );
  telegram.push(homeBot.token, messageFrom(erin, 1, '/pending'));
  expect(
    (await cardsSent(telegram, homeBot, erin, 2)).map(card => card.body),
  ).toEqual([
    {
      chat_id: erin.id,
      text: confirmationCard(pending, {raisedOn: 'web'}),
      reply_markup: buttons('c', pending.id),
    },
    {
      chat_id: erin.id,
      text: pairingCard(fromDave),
      reply_markup: buttons('p', fromDave.code),
    },
  ]);

  const [confirmationShown, daveShown] = cardsIn(
    telegram.calls(homeBot.token),
    erin,
  );

  await wire.answer(pending.id, 'denied');
  await webTurn;
  await wire.pairingAnswer(fromDave.code, 'denied');
  await edited(
    telegram,
    homeBot,
    erin,
    confirmationShown?.messageId ?? 0,
    `${confirmationCard(pending, {raisedOn: 'web', ended: true})} · denied`,
  );
  await edited(
    telegram,
    homeBot,
    erin,
    daveShown?.messageId ?? 0,
    `${pairingCard(fromDave, true)} · denied`,
  );
  telegram.push(homeBot.token, messageFrom(erin, 2, '/pending'));
  await telegram.shows(homeBot.token, erin.id, 'Nothing waits for you.');
});

it("connectors.telegram-toast-cut: a press whose answer would run past the 200 characters Telegram takes is answered with it cut within them, an ellipsis marking the cut, as the daemon's sentence for a pairing approval the home could not write runs past them when it names a long path", async () => {
  // Two folders deep enough that the sentence naming the home's settings
  // document runs past what a toast holds.
  const [outer, inner] = ['o'.repeat(100), 'i'.repeat(100)];
  const home = join(
    createHome({
      [outer]: {
        [inner]: {
          'config.json': configJson({
            connectors: {
              telegram: {
                config: {
                  pairedUsers: {[String(alice.id)]: alice.first_name},
                  managementBotToken: homeBot.token,
                },
              },
            },
          }),
        },
      },
    }),
    outer,
    inner,
  );
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const fromBob = (
    (await wire.pairingRequest('telegram', {
      subject: {id: String(bob.id), label: 'Bob (@bob)'},
      source: otherBot,
    })) as {readonly request: Asked}
  ).request;
  const telegram = await startTelegramServer([homeBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed('Telegram: management bot @home_bot is on.');

  const [card] = await cardsSent(telegram, homeBot, alice, 1);

  chmod(home, 0o500);

  try {
    const failed = (await wire.pairingAnswer(fromBob.code, 'approved')) as {
      readonly status: string;
      readonly message: string;
    };

    expect(failed.status).toBe('failed');
    expect(failed.message.length).toBeGreaterThan(200);

    const approve = pressOn(alice, card?.messageId ?? 0, `p:${fromBob.code}:a`);

    telegram.push(homeBot.token, approve);
    expect((await toast(telegram, homeBot, approve)).body['text']).toBe(
      `${failed.message.slice(0, 199)}…`,
    );
  } finally {
    chmod(home, 0o700);
  }
});
