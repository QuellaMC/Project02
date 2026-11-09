import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  calling,
  completion,
  messagesOf,
  reply,
  startModelServer,
  type ChatMessage,
  type ModelRequest,
} from './harness/model-server.ts';
import {converse, wireOf} from './harness/wire.ts';

async function stop(daemon: Daemon): Promise<void> {
  daemon.signal('SIGINT');
  await daemon.exit();
}

/** The request's messages after its leading system frames. */
function conversationIn(
  request: ModelRequest | undefined,
): readonly ChatMessage[] {
  const messages = messagesOf(request);

  return messages.slice(
    messages.findIndex(message => message.role !== 'system'),
  );
}

/** The `<earlier_conversation>` fence of a request, when it has one. */
function earlierConversation(request: ModelRequest | undefined): string {
  return (
    messagesOf(request).find(
      message =>
        message.role === 'user' &&
        message.content?.startsWith('<earlier_conversation>\n') === true,
    )?.content ?? ''
  );
}

it("model.prompt-frames: the model is shown her persona's sections and the person's name, her curated memory once she has some, the runtime notes with the day, the history, and last the person's message", async () => {
  const persona = ['You are Nova.', 'You keep a lighthouse.'];
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    // A character that asks for no plugin, so the home's settings alone decide hers.
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          persona: {system: persona},
        }),
      },
    },
  });
  const first = await startDaemon(home);
  const sayFirst = await converse(wireOf(first), 'nova');

  model.answer(
    calling([
      'memory_update',
      {operations: [{action: 'add', target: 'notes', text: 'Prefers tea.'}]},
    ]),
    reply('Noted.'),
  );
  await sayFirst('I like tea.', 'tea');
  await stop(first);

  const say = await converse(wireOf(await startDaemon(home)), 'nova');

  model.answer(reply('Hello again.'));
  await say('Back again.', 'back');

  const before = messagesOf(model.requests[0]);
  const after = messagesOf(model.requests[2]);
  const [opening, , curated, runtime] = after;
  const sections = `${persona.join('\n\n')}\n\n`;

  expect(before.map(message => message.role)).toEqual([
    'system',
    'system',
    'system',
    'user',
  ]);
  expect(before[2]?.content).toMatch(/\n- Today is /u);
  expect(after.map(message => message.role)).toEqual([
    'system',
    'system',
    'system',
    'system',
    'user',
    'assistant',
    'tool',
    'assistant',
    'user',
  ]);
  expect(opening?.content?.slice(0, sections.length)).toBe(sections);
  expect(opening?.content?.slice(sections.length)).toContain('Sam');
  expect(curated?.content).toContain('Prefers tea.');
  expect(runtime?.content).toMatch(/\n- Today is /u);
  expect(after.slice(4)).toMatchObject([
    {role: 'user', content: 'I like tea.'},
    {role: 'assistant'},
    {role: 'tool'},
    {role: 'assistant', content: 'Noted.'},
    {role: 'user', content: 'Back again.'},
  ]);
});

it("model.history-replay: after the daemon dies in the middle of a turn, her next turn replays that turn's line and each call that finished with its result, and drops the call that never did", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
    }),
  });
  const first = await startDaemon(home);
  const wire = wireOf(first);
  const say = await converse(wire, 'mira');
  const events = await openEvents(first);
  const {fingerprint} = (await wire.configView({
    scope: 'character',
    characterId: 'mira',
  })) as {readonly fingerprint: string};

  model.answer(
    calling(
      ['runtime_plugin_list', {}],
      [
        'runtime_plugin_config_update',
        {
          pluginId: 'demo-config',
          fieldName: 'tone',
          operation: 'set',
          value: 'pirate',
          expectedFingerprint: fingerprint,
        },
      ],
    ),
  );
  // The update waits on an approval that never comes: the daemon dies first.
  void say('Interrupted?', 'interrupted').catch(() => undefined);
  await events.next(frameOf('confirmation_requested'));
  first.signal('SIGKILL');
  await first.exit();

  const sayAgain = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('Back.'));
  await sayAgain('Still there?', 'still');

  const replayed = conversationIn(model.requests.at(-1));

  expect(replayed).toMatchObject([
    {role: 'user', content: 'Interrupted?'},
    {
      role: 'assistant',
      content: null,
      tool_calls: [{function: {name: 'runtime_plugin_list'}}],
    },
    {role: 'tool'},
    {role: 'user', content: 'Still there?'},
  ]);
  expect(replayed[2]?.tool_call_id).toBe(replayed[1]?.tool_calls?.[0]?.id);
});

it('model.continued-session-summary: once a session continues, its summary is a fenced user message ahead of the turns it carried, and no prompt has one before', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: {...model.settings, contextWindowTokens: 400},
          }),
        }),
      ),
    ),
    'mira',
  );
  // About 70 tokens a turn: the third outgrows the 200-token half of the
  // window, and only the newest fits the quarter a new segment carries.
  const line = (word: string) => `${word} ${'.'.repeat(200)}`;

  model.answer(
    reply('One.'),
    reply('Two.'),
    reply('Three.'),
    completion('We spoke of one and two.'),
    reply('Four.'),
  );

  for (const word of ['One', 'Two', 'Three', 'Four']) {
    await say(line(word), word);
  }

  for (const request of model.requests.slice(0, 3)) {
    expect(earlierConversation(request)).toBe('');
  }

  expect(conversationIn(model.requests[4])).toEqual([
    {
      role: 'user',
      content: expect.stringMatching(
        /^<earlier_conversation>\n.*\nWe spoke of one and two\.\n<\/earlier_conversation>$/su,
      ) as string,
    },
    {role: 'user', content: line('Three')},
    {role: 'assistant', content: 'Three.'},
    {role: 'user', content: line('Four')},
  ]);
});

it('model.summarizer-fallback: a summarizer that fails leaves her turn completed, and the next turn carries a plain summary of what the person said instead', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: {...model.settings, contextWindowTokens: 1},
          }),
        }),
      ),
    ),
    'mira',
  );

  model.answer(reply('Reply.'), {
    status: 400,
    body: {error: {message: 'No summaries today.'}},
  });
  expect(await say('First line.', 'first')).toMatchObject({
    status: 'completed',
  });
  model.answer(reply('Last.'));
  await say('Last line.', 'last');
  expect(
    earlierConversation(
      model.requests.find(
        request => messagesOf(request).at(-1)?.content === 'Last line.',
      ),
    ),
  ).toContain('First line.');
});

it('model.today-note: the runtime notes say the day it is in the host time zone', async () => {
  const model = await startModelServer();
  const notedIn = async (timeZone: string) => {
    const say = await converse(
      wireOf(
        await startDaemon(
          createHome({'config.json': configJson({project02: model.settings})}),
          {TZ: timeZone},
        ),
      ),
      'mira',
    );
    const day = () =>
      new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone,
      }).format(new Date());
    const days = [day()];

    model.answer(reply('Hi.'));
    await say('What day is it?', 'day');
    days.push(day());

    return {days, runtime: messagesOf(model.requests.at(-1))[2]?.content};
  };

  // A day apart wherever the clock stands: UTC-12 and UTC+14.
  for (const timeZone of ['Etc/GMT+12', 'Etc/GMT-14']) {
    const {days, runtime} = await notedIn(timeZone);

    expect(
      days
        .map(day => `\n- Today is ${day}.`)
        .some(note => runtime?.includes(note)),
      `${timeZone}: ${String(runtime)}`,
    ).toBe(true);
  }
});
