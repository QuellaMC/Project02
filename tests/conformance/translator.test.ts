import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, own, type Frame} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  calling,
  completion,
  finish,
  headed,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  visibleReply,
  type Answer,
  type ModelServer,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

/** A minute of her heartbeat, in milliseconds: a quarter of an hour passes in a second and a half. */
const shortened = {PROJECT02_TEST_DURATIONS: 'minute=100'};
/** What the person writes, in English. */
const written = 'Would you like some tea?';
/** A request the translator's service refuses. */
const refused: Answer = {
  status: 400,
  body: {error: {message: 'No translations today.'}},
};

/** A home where Kana, whose package says she speaks Japanese, answers through `model`, the person goes by Sam, and her heartbeat is a quarter of an hour. */
function kanaHome(model: ModelServer): string {
  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    characters: {
      kana: {
        'project02.character.json': characterJson('kana', 'Kana', {
          identity: {id: 'kana', displayName: 'Kana', language: 'ja'},
        }),
      },
    },
    'character-data': {
      kana: {'config.json': configJson({project02: {heartbeat: '15m'}})},
    },
  });
}

/** A request to the translator as the model is shown it: its instructions, putting a message into another language as `into` says, then `input`. */
function translating(into: string, input: string): readonly object[] {
  return [
    {
      role: 'system',
      content: [
        'You translate one message in a private conversation between two people, Sam and Kana. They write in different languages, and each reads the other through you. Neither of them sees you.',
        into,
        'Translate all of it and nothing else: add nothing, leave nothing out, explain nothing, and do not answer it. Keep its line breaks, its emoji and its tone.',
        'If the message is already in that language, give it back unchanged. Answer with the translation alone.',
      ].join('\n\n'),
    },
    {role: 'user', content: input},
  ];
}

const intoHers =
  'Put Sam\'s message into Kana\'s language, the one with the language tag "ja".';
const intoTheirs =
  "Put Kana's message into the language Sam writes in, which Sam's newest message shows.";

/** A moment of hers in which she writes `text`. */
function writes(text: string): Answer {
  return {chunks: [...visibleReply(text), finish('tool_calls')]};
}

function dataOf(frame: Frame): Record<string, unknown> {
  return JSON.parse(frame.data ?? '{}') as Record<string, unknown>;
}

/** The messages the stream committed so far, the person's and hers, as their frames said them. */
function committed(frames: readonly Frame[]): unknown[] {
  return frames
    .filter(frameOf('turn_progress', {characterId: 'kana'}))
    .map(frame => dataOf(frame)['progress'] as Record<string, unknown>)
    .filter(
      progress =>
        progress['kind'] === 'user_message' ||
        progress['kind'] === 'visible_reply',
    );
}

it("translator.both-ways: the person's line reaches her in her language and her message is committed with theirs beside it; her model is given her language alone, the line under its heading and on her phone as she read it, the stream and the scrollback carry both forms, and the translator is asked for each with what came before", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(kanaHome(model));
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'kana');
  const {conversationId} = await conversationOf(wire, 'kana');

  model.answer(
    completion('お茶はいかが？'),
    calling(['phone_open', {app: 'messages'}]),
    reply('いただきます。'),
    completion('I would love some.'),
  );
  await say(written, 'tea');
  await events.next(frameOf('turn_completed', {clientMessageId: 'tea'}));

  const [line, opening, replying, hers] = model.requests;

  expect(messagesOf(line)).toEqual(
    translating(intoHers, `The message to translate, from Sam:\n\n${written}`),
  );
  expect(messagesOf(opening).at(-1)).toEqual({
    role: 'user',
    content: expect.stringMatching(headed('お茶はいかが？')) as string,
  });
  expect(toolResults(replying)).toMatchObject([
    {
      status: 'accepted',
      output: {
        screen: {
          items: [
            {kind: 'note'},
            {kind: 'bubble', from: 'them', text: 'お茶はいかが？'},
          ],
        },
      },
    },
  ]);

  for (const request of [opening, replying]) {
    expect(request?.text).not.toContain(written);
  }

  expect(messagesOf(hers)).toEqual(
    translating(
      intoTheirs,
      `The conversation so far, for context only:\n\nSam: ${written}\n\nSam's newest message:\n\n${written}\n\nThe message to translate, from Kana:\n\nいただきます。`,
    ),
  );
  expect(committed(events.frames)).toMatchObject([
    {kind: 'user_message', text: 'お茶はいかが？', written},
    {
      kind: 'visible_reply',
      text: 'いただきます。',
      translation: 'I would love some.',
    },
  ]);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      {role: 'user', text: 'お茶はいかが？', written},
      {
        role: 'character',
        text: 'いただきます。',
        translation: 'I would love some.',
      },
    ],
  });
});

it('translator.already: an answer that is the message as it was written leaves each one form, the line as written and her message alone, and the person is told nothing', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(kanaHome(model));
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'kana');
  const {conversationId} = await conversationOf(wire, 'kana');

  model.answer(
    completion('お茶はいかが？'),
    reply('いただきます。'),
    completion('いただきます。'),
  );
  await say('お茶はいかが？', 'tea');
  await events.next(frameOf('turn_completed', {clientMessageId: 'tea'}));

  const said = committed(events.frames);
  const {messages} = (await wire.history(conversationId)) as {
    readonly messages: readonly object[];
  };

  expect(messagesOf(model.requests[1]).at(-1)).toEqual({
    role: 'user',
    content: expect.stringMatching(headed('お茶はいかが？')) as string,
  });
  expect(said).toMatchObject([
    {kind: 'user_message', text: 'お茶はいかが？'},
    {kind: 'visible_reply', text: 'いただきます。'},
  ]);
  expect(messages).toMatchObject([
    {role: 'user', text: 'お茶はいかが？'},
    {role: 'character', text: 'いただきます。'},
  ]);

  for (const message of [...said, ...messages]) {
    expect(message).not.toHaveProperty('written');
    expect(message).not.toHaveProperty('translation');
  }

  expect(events.frames.filter(frameOf('maintenance_failed'))).toEqual([]);
});

it('translator.refused: a line whose translation the service refuses never reaches her: its turn ends rejected with nothing committed, saying why, her model never asked and the scrollback empty, and the next line is taken as any; a message of hers whose translation it refuses is committed in her words alone, and her maintenance note says so', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(kanaHome(model));
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'kana');
  const {conversationId} = await conversationOf(wire, 'kana');

  model.answer(refused);
  expect(await say(written, 'tea')).toMatchObject({
    status: 'rejected',
    committed: false,
    reason: 'line_not_translated',
    message:
      'Your message did not reach Kana, because it could not be put into her language: NVIDIA provider error: No translations today.',
    messages: [],
  });
  expect(model.requests).toHaveLength(1);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [],
  });

  model.answer(completion('お茶はいかが？'), reply('いただきます。'), refused);
  await say(written, 'again');

  const noted = await events.next(
    frameOf('maintenance_failed', {characterId: 'kana'}),
  );
  const {messages} = (await wire.history(conversationId)) as {
    readonly messages: readonly object[];
  };

  await events.next(frameOf('turn_completed', {clientMessageId: 'again'}));
  expect(dataOf(noted)['message']).toBe(
    "A message of Kana's was not translated: NVIDIA provider error: No translations today.",
  );
  expect(events.frames.filter(frameOf('maintenance_failed'))).toHaveLength(1);
  expect(messages).toMatchObject([
    {role: 'user', text: 'お茶はいかが？', written},
    {role: 'character', text: 'いただきます。'},
  ]);
  expect(messages[1]).not.toHaveProperty('translation');
});

it("translator.moment: a message of her own is put into the language of the person's newest message, which its request quotes as they wrote it, from a turn before, while her own model replays that line as she read it; and into English while the person has never written", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(kanaHome(model), shortened);
  const events = await openEvents(daemon);

  model.answer(writes('起きてる？'), completion('Are you up?'));

  const say = await converse(wireOf(daemon), 'kana');

  await events.next(own('turn_completed', 'kana'));
  model.answer(completion('お茶？'), reply('飲む！'), completion('Yes!'));
  await say('Tea?', 'tea');
  model.answer(writes('お茶、おいしかった。'), completion('The tea was nice.'));
  await events.next(own('turn_completed', 'kana'));

  expect(messagesOf(model.requests[1])).toEqual(
    translating(
      "Put Kana's message into English.",
      'The message to translate, from Kana:\n\n起きてる？',
    ),
  );
  expect(model.requests[5]?.text).toContain('お茶？');
  expect(model.requests[5]?.text).not.toContain('Tea?');
  expect(messagesOf(model.requests[6])).toEqual(
    translating(
      intoTheirs,
      "The conversation so far, for context only:\n\nKana: 起きてる？\nSam: Tea?\nKana: 飲む！\n\nSam's newest message:\n\nTea?\n\nThe message to translate, from Kana:\n\nお茶、おいしかった。",
    ),
  );
});
