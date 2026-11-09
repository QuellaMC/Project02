import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Events} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  finish,
  reply,
  startModelServer,
  visibleReply,
} from './harness/model-server.ts';
import {
  messageFrom,
  startTelegramServer,
  textsIn,
  type Account,
  type TelegramServer,
} from './harness/telegram-server.ts';
import {saveConfig, wireOf} from './harness/wire.ts';

const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';

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

function miraSettings(): string {
  return configJson({
    connectors: {telegram: {config: {botToken: miraBot.token}}},
  });
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

/** A visible_reply whose arguments, `{"text":"…"}`, stream one piece for each of the words. */
function inPieces(...words: readonly string[]): unknown[] {
  const opening = '{"text":"'.length;

  return visibleReply(
    words.join(''),
    ...words
      .slice(0, -1)
      .map((_, at) => opening + words.slice(0, at + 1).join('').length),
  );
}

/** Settles once the stream carries the reply drafted up to these words. */
async function drafted(events: Events, text: string): Promise<void> {
  await events.next(frameOf('turn_running', {drafts: [{text}]}));
}

it('connectors.telegram-draft-edits: a reply is posted with its first words and edited as it grows, far fewer times than its pieces come, each edit showing the reply so far, and ends as its committed text; an edit Telegram did not take is made again at the commit', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice]),
    'character-data': {mira: {'config.json': miraSettings()}},
  });
  // The stream pings every tenth of a second: a piece of the reply on each.
  const daemon = await startDaemon(home, {
    PROJECT02_TEST_DURATIONS: 'heartbeat=100',
  });
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], {
    ...telegram.env,
    PROJECT02_TEST_DURATIONS: 'edit=400',
  });
  const words = [
    'Once',
    ' upon',
    ' a',
    ' time',
    ',',
    ' there',
    ' was',
    ' a',
    ' little',
    ' bot',
    '.',
  ];
  const story = words.join('');
  const pieces = inPieces(...words);
  const editTo = (text: string, place = 0) =>
    telegram.called(
      miraBot.token,
      calls =>
        calls.filter(
          call =>
            call.method === 'editMessageText' && call.body['text'] === text,
        )[place],
    );

  await run.printed(miraAnswers);

  const driven = model.stream();

  telegram.push(miraBot.token, messageFrom(alice, 1, 'Tell me a story.'));
  await driven.arrived();
  driven.write(pieces.slice(0, 1));

  const posted = await telegram.called(miraBot.token, calls =>
    calls.find(call => call.method === 'sendMessage'),
  );

  for (let at = 1; at < words.length - 1; at += 1) {
    await events.next(frame => frame.comment === 'ping');
    driven.write(pieces.slice(at, at + 1));
    await drafted(events, words.slice(0, at + 1).join(''));
  }

  await editTo(words.slice(0, -1).join(''));
  telegram.away();
  driven.write(pieces.slice(-1));
  await drafted(events, story);

  const dropped = await editTo(story);

  telegram.back();
  driven.write([finish('tool_calls')]);
  driven.end();

  const retried = await editTo(story, 1);

  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  expect(posted.body).toEqual({chat_id: alice.id, text: 'Once'});

  const paced = telegram.calls(miraBot.token, 'editMessageText').slice(0, -1);

  expect(paced.at(-1)).toBe(dropped);

  for (const call of paced) {
    expect(call.body).toMatchObject({chat_id: alice.id, message_id: 1});
    expect(story.startsWith(String(call.body['text']))).toBe(true);
  }

  expect(paced.length).toBeLessThan(words.length - 2);
  expect(retried.body).toEqual({chat_id: alice.id, message_id: 1, text: story});
  expect(run.stderr()).toContain(
    "Mira's bot could not write to chat 4242: Telegram could not be reached: ",
  );
});

it('connectors.telegram-unpaired-mid-reply: a chat unpaired while a reply is written gets no more of it, and a line from it after is told a pairing code instead of being carried', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice, bob]),
    'character-data': {mira: {'config.json': miraSettings()}},
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], {
    ...telegram.env,
    PROJECT02_TEST_DURATIONS: 'edit=100',
  });
  const [once, upon] = inPieces('Once', ' upon a time.');

  await run.printed(miraAnswers);

  const driven = model.stream();

  telegram.push(miraBot.token, messageFrom(alice, 1, 'Tell me a story.'));
  await driven.arrived();
  driven.write([once]);
  await telegram.shows(miraBot.token, bob.id, 'Once');
  await saveConfig(wire, {scope: 'global'}, pairing(alice));
  driven.write([upon, finish('tool_calls')]);
  driven.end();
  await telegram.shows(miraBot.token, alice.id, 'Once upon a time.');
  // A later reply to Alice: whatever Bob was to get of the first is in.
  model.answer(reply('The end.'));
  telegram.push(miraBot.token, messageFrom(alice, 2, 'And then?'));
  await telegram.shows(miraBot.token, alice.id, 'The end.');
  expect(textsIn(telegram.calls(miraBot.token), bob.id)).toEqual(['Once']);

  telegram.push(miraBot.token, messageFrom(bob, 1, 'Still there?'));
  await toldACode(telegram, bob);
});
