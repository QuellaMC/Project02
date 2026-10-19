import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Events} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  content,
  finish,
  reply,
  startModelServer,
  visibleReply,
} from './harness/model-server.ts';
import {startRelay} from './harness/relay.ts';
import {
  messageFrom,
  startTelegramServer,
  textsIn,
  type Account,
  type TelegramBot,
  type TelegramServer,
} from './harness/telegram-server.ts';
import {conversationOf, converse, saveConfig, wireOf} from './harness/wire.ts';

const homeBot = {token: '123456:home', id: 123456, username: 'home_bot'};
const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const carol = {id: 6161, first_name: 'Carol'};
const dave = {id: 7171, first_name: 'Dave'};
const mira = {scope: 'character', characterId: 'mira'} as const;
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';
const settingsRead = '/api/connectors/telegram/config';

/** The home's settings: the model server's provider, these accounts paired, and the management bot when one is given. */
function homeSettings(
  model: {readonly settings: object},
  paired: readonly Account[],
  managementBot?: TelegramBot,
): string {
  return configJson({
    project02: model.settings,
    connectors: {
      telegram: {
        config: {
          pairedUsers: pairedUsers(paired),
          ...(managementBot === undefined
            ? {}
            : {managementBotToken: managementBot.token}),
        },
      },
    },
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

/** Settles once the stream carries a draft piece of these words. */
async function drafted(events: Events, text: string): Promise<void> {
  await events.next(
    frameOf('turn_progress', {progress: {kind: 'reply_delta', text}}),
  );
}

it('connectors.telegram-draft-edits: a reply is posted with its first words, edited at most once an interval however many pieces come meanwhile, each edit showing the reply so far, and ends as its committed text; an edit Telegram did not take is made again at the commit', async () => {
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
    await drafted(events, words[at] ?? '');
  }

  await editTo(words.slice(0, -1).join(''));
  telegram.away();
  driven.write(pieces.slice(-1));
  await drafted(events, '.');

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

  // One edit an interval while it was written, give or take one at either
  // end of the clock: far fewer than its pieces, a tenth of a second apart.
  expect(paced.length).toBeLessThanOrEqual((dropped.at - posted.at) / 400 + 2);
  expect(paced.length).toBeLessThan(words.length - 2);
  expect(retried.body).toEqual({chat_id: alice.id, message_id: 1, text: story});
  expect(run.stderr()).toContain(
    "Mira's bot could not write to chat 4242: Telegram could not be reached: ",
  );
});

it("connectors.telegram-draft-from-snapshot: a bot started mid-reply shows the reply from the snapshot's draft and ends with all of it, and across a stream the daemon could not resume a draft's message is kept and brought to the snapshot's words, then to the committed text", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice]),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {mira: {'config.json': miraSettings()}},
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);
  const sayOnWeb = await converse(wire, 'mira');
  const first = model.stream();
  const firstTurn = sayOnWeb('Tell me a story.', 'web-1');
  const [once, upon] = inPieces('Once', ' upon a time.');

  await first.arrived();
  first.write([once]);
  await drafted(events, 'Once');

  const relay = await startRelay(home);
  const run = connector(['--store', relay.home], {
    ...telegram.env,
    PROJECT02_TEST_DURATIONS: 'edit=100',
  });

  await run.printed(miraAnswers);
  await telegram.shows(miraBot.token, alice.id, 'Once');
  first.write([upon, finish('tool_calls')]);
  first.end();
  await firstTurn;
  await telegram.shows(miraBot.token, alice.id, 'Once upon a time.');
  expect(textsIn(telegram.calls(miraBot.token), alice.id)).toEqual([
    'Once',
    'Once upon a time.',
  ]);

  const second = model.stream();
  const secondTurn = sayOnWeb('And then?', 'web-2');
  const [and, then, ended] = inPieces('And', ' then', ' it ended.');

  await second.arrived();
  second.write([and]);
  await telegram.shows(miraBot.token, alice.id, 'And');

  const kept = telegram.calls(miraBot.token, 'sendMessage').at(-1)?.messageId;
  const cut = relay.requests.length;

  relay.away();
  await run.printed(
    `Telegram connector: waiting for the daemon on ${relay.home}; run pnpm serve.`,
  );
  second.write([then]);
  await drafted(events, ' then');

  // Another character says more than the daemon's stream keeps meanwhile:
  // where the connector left the stream is gone from it.
  const sayToNova = await converse(wire, 'nova');
  const everything = 'x'.repeat(1_200 * 1024);

  model.answer({
    chunks: [
      ...content(
        everything,
        ...Array.from({length: 18}, (_, at) => (at + 1) * 64 * 1024),
      ),
      finish('stop'),
    ],
  });
  await sayToNova('Tell me everything.', 'nova');

  relay.back();

  const resent = await relay.reached(requests =>
    requests.slice(cut).find(request => request.path.startsWith('/api/events')),
  );
  const lastEventId = resent.headers['last-event-id'];

  expect(lastEventId).toEqual(expect.any(String));
  expect(
    (await (await openEvents(daemon, String(lastEventId))).next(() => true))
      .event,
  ).toBe('ready');
  await telegram.shows(miraBot.token, alice.id, 'And then');
  second.write([ended, finish('tool_calls')]);
  second.end();
  await secondTurn;
  await telegram.shows(miraBot.token, alice.id, 'And then it ended.');
  expect(
    telegram
      .calls(miraBot.token, 'editMessageText')
      .filter(call => call.body['message_id'] === kept)
      .map(call => call.body['text']),
  ).toEqual(['And then', 'And then it ended.']);
  expect(telegram.calls(miraBot.token, 'deleteMessage')).toEqual([]);
});

it('connectors.telegram-unpaired-mid-reply: a chat unpaired while a reply is written gets no more of it, and a command from an account unpaired while the daemon was asked for its answer is answered with nothing', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice, bob], homeBot),
    'character-data': {mira: {'config.json': miraSettings()}},
  });
  const wire = wireOf(await startDaemon(home));
  const relay = await startRelay(home);
  const telegram = await startTelegramServer([homeBot, miraBot]);
  const run = connector(['--store', relay.home], {
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

  const status = relay.hold('/api/health');

  telegram.push(homeBot.token, messageFrom(alice, 1, '/status'));
  await status.answered();

  const reads = relay.requests.filter(
    request => request.path === settingsRead,
  ).length;

  await saveConfig(wire, {scope: 'global'}, pairing());
  await relay.reached(requests =>
    requests.filter(request => request.path === settingsRead).length > reads
      ? true
      : undefined,
  );
  status.release();
  // Asked again, now unpaired: the answer to the first would be before
  // this one's pairing code.
  telegram.push(homeBot.token, messageFrom(alice, 2, '/status'));
  await telegram.called(homeBot.token, calls =>
    textsIn(calls, alice.id).length > 0 ? true : undefined,
  );
  expect(textsIn(telegram.calls(homeBot.token), alice.id)).toEqual([
    expect.stringMatching(/^This bot is private\. Your pairing code is /u),
  ]);
});

it('connectors.telegram-settings-before-frames: settings changed while the connector was away apply before any frame that comes back reaches the bots, replayed on a resumed stream or in the ready after a restart, so a chat unpaired meanwhile sees nothing of a turn in progress', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice, bob]),
    'character-data': {mira: {'config.json': miraSettings()}},
  });
  const first = await startDaemon(home);
  const wire = wireOf(first);
  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', relay.home], {
    ...telegram.env,
    PROJECT02_TEST_DURATIONS: 'edit=100',
  });
  const sayOnWeb = await converse(wire, 'mira');
  const events = await openEvents(first);

  await run.printed(miraAnswers);
  model.answer(reply('Hello, both.'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Hello.'));
  await telegram.shows(miraBot.token, bob.id, 'Hello, both.');

  const beforeResume = textsIn(telegram.calls(miraBot.token), bob.id);

  relay.away();
  await run.printed(
    `Telegram connector: waiting for the daemon on ${relay.home}; run pnpm serve.`,
  );
  await saveConfig(wire, {scope: 'global'}, pairing(alice));

  const resumed = model.stream();
  const resumedTurn = sayOnWeb('From the web.', 'web-1');
  const [hello, fromWeb] = inPieces('Hello', ' from the web.');

  await resumed.arrived();
  resumed.write([hello]);
  await drafted(events, 'Hello');
  relay.back();
  await telegram.shows(miraBot.token, alice.id, 'Hello');
  resumed.write([fromWeb, finish('tool_calls')]);
  resumed.end();
  await resumedTurn;
  await telegram.shows(miraBot.token, alice.id, 'Hello from the web.');
  // A later reply to Alice: whatever Bob was to get of the turn is in.
  model.answer(reply('Hello again.'));
  telegram.push(miraBot.token, messageFrom(alice, 2, 'Hello?'));
  await telegram.shows(miraBot.token, alice.id, 'Hello again.');
  expect(textsIn(telegram.calls(miraBot.token), bob.id)).toEqual(beforeResume);

  await saveConfig(wire, {scope: 'global'}, pairing(alice, bob));
  model.answer(reply('Hello, both, again.'));
  telegram.push(miraBot.token, messageFrom(alice, 3, 'Both?'));
  await telegram.shows(miraBot.token, bob.id, 'Hello, both, again.');

  const beforeRestart = textsIn(telegram.calls(miraBot.token), bob.id);

  relay.away();
  await saveConfig(wire, {scope: 'global'}, pairing(alice));
  first.signal('SIGINT');
  await first.exit();

  const again = await startDaemon(home);
  const sayAgain = await converse(wireOf(again), 'mira');
  const watching = await openEvents(again);
  const restarted = model.stream();
  const restartedTurn = sayAgain('After the restart.', 'web-2');
  const [hi, afterAll] = inPieces('Hi', ' after all.');

  await restarted.arrived();
  restarted.write([hi]);
  await drafted(watching, 'Hi');
  relay.back();
  await telegram.shows(miraBot.token, alice.id, 'Hi');
  restarted.write([afterAll, finish('tool_calls')]);
  restarted.end();
  await restartedTurn;
  await telegram.shows(miraBot.token, alice.id, 'Hi after all.');
  model.answer(reply('Still here.'));
  telegram.push(miraBot.token, messageFrom(alice, 4, 'Still there?'));
  await telegram.shows(miraBot.token, alice.id, 'Still here.');
  expect(textsIn(telegram.calls(miraBot.token), bob.id)).toEqual(beforeRestart);
});

it('connectors.telegram-held-messages: a message that arrives while a change is read, while the stream is lost, or after a returning ready before its settings are read waits, and is judged by the settings that read returns; a read begun before the loss that lands after it does not end the wait', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': homeSettings(model, [alice, bob, carol, dave]),
    'character-data': {mira: {'config.json': miraSettings()}},
  });
  const first = await startDaemon(home);
  const wire = wireOf(first);
  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', relay.home], telegram.env);

  await run.printed(miraAnswers);
  model.answer(reply('Hello, Alice.'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Hello.'));
  await telegram.shows(miraBot.token, alice.id, 'Hello, Alice.');

  // While a change is read: Bob, unpaired by it.
  const changeRead = relay.hold(settingsRead);

  await saveConfig(wire, {scope: 'global'}, pairing(alice, carol, dave));
  await changeRead.answered();
  telegram.push(miraBot.token, messageFrom(bob, 1, 'Bob here.'));
  changeRead.release();
  await toldACode(telegram, bob);

  // While the stream is lost, an answer read before it landing meanwhile:
  // Carol, paired in that answer and unpaired since.
  const staleRead = relay.hold(settingsRead);

  await saveConfig(wire, mira, {
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
    field: 'mirror',
    value: false,
  });
  await staleRead.answered();
  relay.away();
  await run.printed(
    `Telegram connector: waiting for the daemon on ${relay.home}; run pnpm serve.`,
  );
  await saveConfig(wire, {scope: 'global'}, pairing(alice, dave));
  telegram.push(miraBot.token, messageFrom(carol, 1, 'Carol here.'));
  staleRead.release();
  relay.back();
  await toldACode(telegram, carol);

  // After the ready of a daemon that came back, before its settings are
  // read: Dave, unpaired while it was down.
  relay.away();
  await saveConfig(wire, {scope: 'global'}, pairing(alice));
  first.signal('SIGINT');
  await first.exit();

  const again = await startDaemon(home);
  const returnRead = relay.hold(settingsRead);

  relay.back();
  await returnRead.answered();
  telegram.push(miraBot.token, messageFrom(dave, 1, 'Dave here.'));
  returnRead.release();
  await toldACode(telegram, dave);

  const {conversationId} = await conversationOf(wireOf(again), 'mira');

  expect(await wireOf(again).history(conversationId)).toMatchObject({
    messages: [{text: 'Hello.'}, {text: 'Hello, Alice.'}],
  });
  expect(model.requests).toHaveLength(1);
});
