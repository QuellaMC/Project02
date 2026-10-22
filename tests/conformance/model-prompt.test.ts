import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {
  characterJson,
  configJson,
  createHome,
  sessionRecords,
} from './harness/home.ts';
import {startMem0Server} from './harness/mem0-server.ts';
import {
  calling,
  completion,
  content,
  finish,
  messagesOf,
  reply,
  startModelServer,
  toolCall,
  visibleReply,
  type Answer,
  type ChatMessage,
  type ModelRequest,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

/** Nova's package: a character that asks for no plugin, so the home's settings alone decide hers. */
const nova = {
  nova: {'project02.character.json': characterJson('nova', 'Nova')},
};

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

it("model.prompt-frames: the prompt runs persona, developer protocol, curated memory as titled sections with their fill (absent while there is none), the runtime notes without any plugin inventory, the history window, then the person's message", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
    characters: nova,
  });
  const first = await startDaemon(home);
  const sayFirst = await converse(wireOf(first), 'nova');

  model.answer(
    calling([
      'memory_update',
      {
        operations: [
          {action: 'add', target: 'notes', text: 'Prefers tea.'},
          {action: 'add', target: 'user_profile', text: 'Is called Sam.'},
        ],
      },
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
  const [persona, protocol, curated, runtime] = after;

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
  expect(persona?.content).toMatch(/^You are Nova\.\n\n/u);
  expect(protocol?.content).toContain('visible_reply');
  expect(curated?.content).toContain(
    '\n-- Notes to yourself [1% - 12/2200 chars] --\nPrefers tea.\n-- What you know about them [1% - 14/1375 chars] --\nIs called Sam.',
  );
  expect(runtime?.content).toMatch(/\n- Today is /u);

  for (const inventory of [
    'runtime.plugin',
    'visible_reply',
    'memory.update',
    'character-memory',
    'session-history',
  ]) {
    expect(runtime?.content).not.toContain(inventory);
  }

  expect(after.slice(4)).toMatchObject([
    {role: 'user', content: 'I like tea.'},
    {role: 'assistant'},
    {role: 'tool'},
    {role: 'assistant', content: 'Noted.'},
    {role: 'user', content: 'Back again.'},
  ]);
});

it('model.tool-protocol-text: the developer protocol says the inventory tool exists only when it is offered, names the person when their name is set, and speaks of several calls at once for a provider that makes them', async () => {
  const model = await startModelServer();
  const protocolOf = async (document: object): Promise<string> => {
    const say = await converse(
      wireOf(
        await startDaemon(
          createHome({'config.json': configJson(document), characters: nova}),
        ),
      ),
      'nova',
    );

    model.answer(reply('Hi.'));
    await say('Hello?', 'hello');

    return messagesOf(model.requests.at(-1))[1]?.content ?? '';
  };
  const bare = await protocolOf({
    project02: {...model.settings, userDisplayName: 'Sam'},
    plugins: {
      'runtime.plugin': {enabled: false},
      'character-memory': {enabled: false},
      'session-history': {enabled: false},
    },
  });
  const plain = await protocolOf({project02: model.settings});

  expect(bare).not.toContain('runtime.plugin.list');
  expect(bare).toContain('Sam');
  expect(plain).toContain('call runtime.plugin.list when you need');
  expect(plain).not.toContain('Sam');

  for (const protocol of [bare, plain]) {
    expect(protocol).toContain(
      'You may call several independent tools in one response',
    );
  }
});

it('model.visible-reply: visible_reply is offered when no plugin offers a tool at all', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: model.settings,
            plugins: {
              'runtime.plugin': {enabled: false},
              'character-memory': {enabled: false},
              'session-history': {enabled: false},
            },
          }),
          characters: nova,
        }),
      ),
    ),
    'nova',
  );

  model.answer(reply('Hi.'));
  expect(await say('Hello?', 'hello')).toMatchObject({status: 'completed'});
  expect(
    (
      model.requests[0]?.body as {
        readonly tools: readonly {readonly function: {readonly name: string}}[];
      }
    ).tools.map(tool => tool.function.name),
  ).toEqual(['visible_reply']);
});

it('model.tool-schema-strict: a tool whose schema strict mode can hold whole, each object it types closed to the properties it lists, is sent strict, and one holding a combinator or a keyword strict mode cannot hold, a pattern or a length, is not', async () => {
  const model = await startModelServer();
  const mem0 = await startMem0Server();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: model.settings,
            plugins: {
              mem0: {
                enabled: true,
                config: {backend: 'server', baseUrl: mem0.baseUrl},
              },
            },
          }),
        }),
      ),
    ),
    'mira',
  );

  model.answer(reply('Hello.'));
  await say('Hello?', 'hello');
  expect(
    Object.fromEntries(
      (
        model.requests[0]?.body as {
          readonly tools: readonly {
            readonly function: {readonly name: string; readonly strict?: true};
          }[];
        }
      ).tools.map(({function: tool}) => [tool.name, tool.strict === true]),
    ),
  ).toEqual({
    visible_reply: true,
    runtime_plugin_list: true,
    runtime_plugin_config: true,
    runtime_plugin_config_update: true,
    character_state_patch: true,
    mem0_search: true,
    mem0_add: true,
    memory_update: false,
    sessions_search: false,
    sessions_read: false,
  });
});

it('model.history-window: the replayed history is the newest whole turns that fit half the context window, oldest first and contiguous, so a newest turn too big for it leaves it empty', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: {...model.settings, contextWindowTokens: 4000},
          }),
        }),
      ),
    ),
    'mira',
  );
  // Half the window holds 2000 tokens, about 8000 characters of messages:
  // the two long lines fit together, not with the first turn as well, and
  // the longest line not even alone.
  const lines = ['b', 'c', 'd'].map((letter, at) =>
    letter.repeat(at === 2 ? 9000 : 3000),
  );
  const refused: Answer = {status: 400, body: {error: {message: 'Not now.'}}};

  model.answer(
    reply('a'.repeat(2400)),
    refused,
    refused,
    refused,
    reply('Still here.'),
  );
  await say('Hello.', 'hello');

  for (const [at, line] of lines.entries()) {
    await say(line, `line-${String(at)}`);
  }

  await say('Still there?', 'still');
  expect(conversationIn(model.requests[3])).toEqual(
    lines.map(line => ({role: 'user', content: line})),
  );
  expect(conversationIn(model.requests[4])).toEqual([
    {role: 'user', content: 'Still there?'},
  ]);
});

it('model.history-replay: a prior turn replays as its line, each finished tool round as the note and interim replies beside its calls with one result for each, then its replies; an unfinished call is dropped, a rejected turn keeps its line and the rounds it finished, and a reopen replays the same bytes', async () => {
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
  const list = (index: number) =>
    toolCall({
      index,
      id: `call_list_${String(index)}`,
      name: 'runtime_plugin_list',
      arguments: '{}',
    });
  const {fingerprint} = (await wire.configView({
    scope: 'character',
    characterId: 'mira',
  })) as {readonly fingerprint: string};

  model.answer(
    {
      chunks: [
        ...content('A note.'),
        ...visibleReply('One moment.'),
        ...list(1),
        finish('tool_calls'),
      ],
    },
    reply('All set.'),
    {chunks: [...list(0), finish('tool_calls')]},
    {status: 400, body: {error: {message: 'Not now.'}}},
    {
      chunks: [
        ...list(0),
        ...toolCall({
          index: 1,
          id: 'call_update',
          name: 'runtime_plugin_config_update',
          arguments: JSON.stringify({
            pluginId: 'demo-config',
            fieldName: 'tone',
            operation: 'set',
            value: 'pirate',
            expectedFingerprint: fingerprint,
          }),
        }),
        finish('tool_calls'),
      ],
    },
  );
  await say('Finished?', 'finished');
  await say('Rejected?', 'rejected');
  // The update waits on an approval that never comes: the daemon dies first.
  void say('Interrupted?', 'interrupted').catch(() => undefined);
  await events.next(frameOf('confirmation_requested'));
  first.signal('SIGKILL');
  await first.exit();

  const sayAgain = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('Back.'));
  await sayAgain('Still there?', 'still');

  const beforeReopen = conversationIn(model.requests[4]);
  const afterReopen = conversationIn(model.requests[5]);

  expect(JSON.stringify(afterReopen.slice(0, beforeReopen.length - 1))).toBe(
    JSON.stringify(beforeReopen.slice(0, -1)),
  );
  expect(afterReopen).toMatchObject([
    {role: 'user', content: 'Finished?'},
    {
      role: 'assistant',
      content: 'A note.\n\nOne moment.',
      tool_calls: [{function: {name: 'runtime_plugin_list', arguments: '{}'}}],
    },
    {role: 'tool'},
    {role: 'assistant', content: 'All set.'},
    {role: 'user', content: 'Rejected?'},
    {
      role: 'assistant',
      content: null,
      tool_calls: [{function: {name: 'runtime_plugin_list'}}],
    },
    {role: 'tool'},
    {role: 'user', content: 'Interrupted?'},
    {
      role: 'assistant',
      content: null,
      tool_calls: [{function: {name: 'runtime_plugin_list'}}],
    },
    {role: 'tool'},
    {role: 'user', content: 'Still there?'},
  ]);

  for (const [call, result] of [
    [afterReopen[1], afterReopen[2]],
    [afterReopen[5], afterReopen[6]],
    [afterReopen[8], afterReopen[9]],
  ]) {
    expect(result?.tool_call_id).toBe(call?.tool_calls?.[0]?.id);
  }
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

it("model.summarizer: a rotation asks the summarizer once, on the character's model and server with stream false, max_tokens 3000 and thinking off, the instructions as system and the transcript as user, and its trimmed text opens the new segment the model replays", async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({
          project02: {
            ...model.settings,
            nvidiaModel: 'conformance-model',
            userDisplayName: 'Sam',
          },
        }),
      }),
    ),
  );
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  // Past half the default window by itself: the turn outgrows it.
  const story = 'A very long story. '.repeat(3_700);

  model.answer(
    reply(story),
    completion('  We said hello, and I told a long story.  '),
    reply('Again.'),
  );

  const told = (await say('Hello.', 'hello')) as {
    readonly messages: readonly {readonly messageId: string}[];
  };
  const {messages} = (await wire.history(conversationId)) as {
    readonly messages: readonly {readonly committedAt: string}[];
  };
  const day = messages[0]?.committedAt.slice(0, 10) ?? '';

  expect(await say('Again?', 'again')).toMatchObject({
    status: 'completed',
    messages: [
      {messageId: `${conversationId}.2:message-1`},
      {messageId: `${conversationId}.2:message-2`},
    ],
  });
  expect(told.messages[0]?.messageId).toBe(`${conversationId}.1:message-1`);
  expect(model.requests.map(request => request.path)).toEqual(
    Array(3).fill('/v1/chat/completions'),
  );

  const summarizer = model.requests[1]?.body as {
    readonly messages: readonly ChatMessage[];
  };

  expect(summarizer).toMatchObject({
    model: 'conformance-model',
    stream: false,
    max_tokens: 3000,
    chat_template_kwargs: {enable_thinking: false},
  });
  expect(summarizer).not.toHaveProperty('tools');
  expect(summarizer.messages).toEqual([
    {
      role: 'system',
      content: expect.stringMatching(/Sam.*Mira|Mira.*Sam/su) as string,
    },
    {
      role: 'user',
      content: expect.stringMatching(
        new RegExp(
          `^<conversation>\\n\\[${day}\\]\\nSam: Hello\\.\\nMira: A very long story\\..*\\n</conversation>$`,
          'su',
        ),
      ) as string,
    },
  ]);
  expect(earlierConversation(model.requests[2])).toContain(
    '\nWe said hello, and I told a long story.\n</earlier_conversation>',
  );
});

it('model.summarizer-fallback: a summarizer that fails, by HTTP error, blank text, a cut-off answer or a dropped connection, is reported in the continuation and the turn completes, a mechanical summary of the turn count, the dates and what the person said last carried instead', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: {
        ...model.settings,
        contextWindowTokens: 1,
        userDisplayName: 'Sam',
      },
    }),
  });
  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const failures: readonly (readonly Answer[])[] = [
    [{status: 400, body: {error: {message: 'No summaries today.'}}}],
    [completion('   ')],
    [completion('We spoke of', 'length')],
    [{drop: true}, {drop: true}, {drop: true}],
  ];

  for (const [at, failing] of failures.entries()) {
    model.answer(reply(`Reply ${String(at)}.`), ...failing);
    expect(
      await say(`Line ${String(at)}.`, `line-${String(at)}`),
    ).toMatchObject({status: 'completed'});
  }

  model.answer(reply('Last.'));
  await say('Last line.', 'last');

  const {messages} = (await wire.history(conversationId)) as {
    readonly messages: readonly {
      readonly text: string;
      readonly committedAt: string;
    }[];
  };
  const day =
    messages
      .find(message => message.text === 'Line 3.')
      ?.committedAt.slice(0, 10) ?? '';
  const carried = earlierConversation(
    model.requests.find(
      request => messagesOf(request).at(-1)?.content === 'Last line.',
    ),
  );

  expect(
    sessionRecords(home, 'mira', 'session_continued')
      .slice(0, failures.length)
      .map(record => {
        const {summarizer, summary} = record['sessionContinuation'] as {
          readonly summarizer: unknown;
          readonly summary: string;
        };

        return {summarizer, summary};
      }),
  ).toEqual(
    failures.map((_, at) => ({
      summarizer: {status: 'fallback', reason: expect.any(String) as string},
      summary: expect.stringContaining(`Line ${String(at)}.`) as string,
    })),
  );
  expect(carried).toContain(`1 turns, ${day} to ${day}`);
  expect(carried).toContain('Line 3.');
});

it('model.code-point-cuts: where the daemon cuts text to a length, a tool output bounded for the model, a session-history snippet, the summary a new segment carries, it cuts between characters, so no half of a surrogate pair reaches the model or a record', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: {...model.settings, contextWindowTokens: 1},
    }),
  });
  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const loneHalf = /\\ud[89a-f][0-9a-f]{2}/iu;
  // Each bound below would split a 😀: the read cuts the reply at unit 397,
  // the search cuts the line's text at 197 and starts its snippet at 225,
  // and the summary's 1000 falls inside a pair, one unit after the "a".
  const line = `${'😀'.repeat(150)}  needle ${'😀'.repeat(150)}`;

  model.answer(
    reply('😀'.repeat(250)),
    completion(`a${'😀'.repeat(600)}`),
    calling(
      ['sessions_search', {query: 'needle'}],
      ['sessions_read', {sessionId: `${conversationId}.1`}],
    ),
    reply('Found it.'),
  );
  await say(line, 'line');
  await say('What did I say?', 'recall');

  const results = messagesOf(model.requests[3])
    .filter(message => message.role === 'tool')
    .map(message => message.content ?? '');

  expect(results.join('\n')).toMatch(/\.\.\./u);
  expect(earlierConversation(model.requests[2])).not.toBe('');

  for (const request of model.requests) {
    expect(JSON.stringify(request.body)).not.toMatch(loneHalf);
  }

  const sessions = join(home, 'character-data', 'mira', 'sessions');

  for (const session of readdirSync(sessions)) {
    expect(
      readFileSync(join(sessions, session, 'raw-events.jsonl'), 'utf8'),
    ).not.toMatch(loneHalf);
  }
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
