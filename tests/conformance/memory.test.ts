import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {expect, it, onTestFinished} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  calling,
  completion,
  finish,
  messagesOf,
  reply,
  startModelServer,
  toolCall,
  toolResults,
  visibleReply,
  type ModelRequest,
} from './harness/model-server.ts';
import {conversationOf, converse, saveConfig, wireOf} from './harness/wire.ts';

type ToolResult = {
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly output?: Record<string, unknown>;
};

async function stop(daemon: Daemon): Promise<void> {
  daemon.signal('SIGINT');
  await daemon.exit();
}

function pluginData(home: string, pluginId: string): string {
  return join(home, 'character-data', 'mira', 'plugin-data', pluginId);
}

/** The runtime notes: the last system frame before the conversation. */
function runtimeNotesOf(request: ModelRequest | undefined): string {
  const messages = messagesOf(request);

  return (
    messages[messages.findIndex(message => message.role !== 'system') - 1]
      ?.content ?? ''
  );
}

/** What each tool call of the round before told the model, in call order. */
function toolResultsIn(request: ModelRequest | undefined): ToolResult[] {
  return toolResults(request) as ToolResult[];
}

function memoryUpdate(
  ...operations: readonly Record<string, string>[]
): readonly [name: string, input: object] {
  return ['memory_update', {operations}];
}

function storedMemory(home: string): unknown {
  return JSON.parse(
    readFileSync(
      join(pluginData(home, 'character-memory'), 'memory.json'),
      'utf8',
    ),
  ) as unknown;
}

it('memory.character-memory-tool: memory.update applies a batch of adds, replaces and removes across notes and user_profile whole, reporting each change, a duplicate as a no-op, and the usage; a batch whose old_text matches nothing or several entries, counted and unquoted, or with a control character, is refused and changes nothing', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(
    calling(
      memoryUpdate(
        {action: 'add', target: 'notes', text: 'Likes green tea.'},
        {action: 'add', target: 'notes', text: 'Likes black tea.'},
        {action: 'add', target: 'user_profile', text: 'Is called Sam.'},
      ),
    ),
    calling(
      memoryUpdate(
        {action: 'add', target: 'notes', text: 'Likes green tea.'},
        {
          action: 'replace',
          target: 'notes',
          old_text: 'black',
          text: 'Likes oolong.',
        },
        {action: 'remove', target: 'user_profile', old_text: 'Sam'},
      ),
    ),
  );

  const failing = model.hold();
  const turn = say('Remember these.', 'remember');

  await failing.arrived();

  const before = storedMemory(home);

  model.answer(reply('Done.'));
  failing.release(
    calling(
      memoryUpdate(
        {action: 'add', target: 'notes', text: 'Plays chess.'},
        {action: 'remove', target: 'notes', old_text: 'coffee'},
      ),
      memoryUpdate(
        {action: 'add', target: 'notes', text: 'Plays go.'},
        {action: 'replace', target: 'notes', old_text: 'Likes', text: 'Hm.'},
      ),
      memoryUpdate({action: 'add', target: 'notes', text: 'A bell \u0007.'}),
    ),
  );
  await turn;

  const usage = (
    [notesChars, notesEntries]: readonly [number, number],
    [profileChars, profileEntries]: readonly [number, number],
  ) => ({
    notes: {usedChars: notesChars, capChars: 2200, entryCount: notesEntries},
    user_profile: {
      usedChars: profileChars,
      capChars: 1375,
      entryCount: profileEntries,
    },
  });

  expect(toolResultsIn(model.requests[1])).toEqual([
    {
      status: 'accepted',
      pluginId: 'character-memory',
      toolName: 'memory.update',
      output: {
        status: 'accepted',
        appliedChanges: [
          {action: 'add', target: 'notes', status: 'applied'},
          {action: 'add', target: 'notes', status: 'applied'},
          {action: 'add', target: 'user_profile', status: 'applied'},
        ],
        usage: usage([35, 2], [14, 1]),
        visibleNextSession: true,
      },
    },
  ]);
  expect(toolResultsIn(model.requests[2]).at(-1)).toMatchObject({
    status: 'accepted',
    output: {
      appliedChanges: [
        {action: 'add', target: 'notes', status: 'duplicate'},
        {action: 'replace', target: 'notes', status: 'applied'},
        {action: 'remove', target: 'user_profile', status: 'applied'},
      ],
      usage: usage([32, 2], [0, 0]),
    },
  });
  expect(before).toMatchObject({
    notes: ['Likes green tea.', 'Likes oolong.'],
    userProfile: [],
  });

  const refused = toolResultsIn(model.requests[3]).slice(-3);

  expect(refused).toMatchObject([
    {status: 'rejected', reason: 'memory_old_text_not_found'},
    {
      status: 'rejected',
      reason: 'memory_old_text_ambiguous',
      message: expect.stringMatching(/\b2\b/u) as string,
    },
    {status: 'rejected', reason: 'memory_entry_invalid'},
  ]);
  expect(refused[1]?.message).not.toMatch(/green|oolong/u);
  expect(storedMemory(home)).toEqual(before);
});

it('memory.character-memory-caps: a batch that would carry a target past its rendered capacity, its entries joined by a § line, is refused memory_capacity_exceeded with the numbers', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');
  const [long, longer] = ['a'.repeat(1100), 'b'.repeat(1097)];

  model.answer(
    calling(
      memoryUpdate(
        {action: 'add', target: 'notes', text: long},
        {action: 'add', target: 'notes', text: longer},
      ),
    ),
    calling(
      memoryUpdate({action: 'add', target: 'notes', text: 'c'}),
      memoryUpdate({
        action: 'add',
        target: 'user_profile',
        text: 'd'.repeat(1376),
      }),
    ),
    reply('Full.'),
  );
  await say('Remember all of it.', 'full');

  expect(toolResultsIn(model.requests[1])).toMatchObject([
    {output: {usage: {notes: {usedChars: 2200, entryCount: 2}}}},
  ]);
  expect(toolResultsIn(model.requests[2]).slice(-2)).toEqual([
    {
      status: 'rejected',
      pluginId: 'character-memory',
      toolName: 'memory.update',
      reason: 'memory_capacity_exceeded',
      message: expect.stringContaining('2204/2200') as string,
    },
    {
      status: 'rejected',
      pluginId: 'character-memory',
      toolName: 'memory.update',
      reason: 'memory_capacity_exceeded',
      message: expect.stringContaining('1376/1375') as string,
    },
  ]);
  await stop(first);

  const again = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('Hello.'));
  await again('Hello.', 'hello');
  expect(
    messagesOf(model.requests.at(-1)).some(
      message => message.content?.includes(`${long}\n§\n${longer}`) === true,
    ),
  ).toBe(true);
});

it('memory.character-memory-snapshot: curated memory reaches the trusted system frames as a snapshot frozen for the session, so a write shows from the next session on, and an empty store adds no section', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');
  const curated = (request: ModelRequest | undefined) =>
    messagesOf(request).filter(
      message =>
        message.role === 'system' &&
        message.content?.includes('Likes tea.') === true,
    );

  model.answer(
    calling([
      'memory_update',
      {
        operations: [{action: 'add', target: 'notes', text: 'Likes tea.'}],
      },
    ]),
    reply('Noted.'),
    reply('Still noted.'),
  );
  await say('I like tea.', 'tea');
  await say('Do you remember?', 'remember');
  await stop(first);

  const again = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('Tea, yes.'));
  await again('And now?', 'now');
  expect(
    model.requests.map(request => [
      messagesOf(request).filter(message => message.role === 'system').length,
      curated(request).length,
    ]),
  ).toEqual([
    [3, 0],
    [3, 0],
    [3, 0],
    [4, 1],
  ]);
});

it('memory.character-state-store: a patch is in events.jsonl and checkpoint.json before its call returns, the state is rebuilt from events.jsonl when the checkpoint is gone, and a checkpoint of a version it does not know fails the turn closed', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const state = pluginData(home, 'character-state');
  const checkpoint = join(state, 'checkpoint.json');
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');

  model.answer(calling(['character_state_patch', {mood: 'curious'}]));

  const returned = model.hold();
  const turn = say('Be curious.', 'curious');

  await returned.arrived();
  expect(
    readFileSync(join(state, 'events.jsonl'), 'utf8').trim().split('\n'),
  ).toEqual([expect.stringContaining('"input":{"mood":"curious"}')]);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toMatchObject({
    current: {current: {mood: 'curious'}},
  });
  returned.release(reply('Curious now.'));
  await turn;
  await stop(first);
  rmSync(checkpoint);

  const second = await startDaemon(home);
  const sayAgain = await converse(wireOf(second), 'mira');

  model.answer(reply('Still curious.'));
  await sayAgain('How are you?', 'rebuilt');
  expect(runtimeNotesOf(model.requests.at(-1))).toContain('mood=curious');
  expect(existsSync(checkpoint)).toBe(true);
  await stop(second);
  writeFileSync(
    checkpoint,
    JSON.stringify({
      ...(JSON.parse(readFileSync(checkpoint, 'utf8')) as object),
      version: 99,
    }),
  );

  const asked = model.requests.length;
  const sayLast = await converse(wireOf(await startDaemon(home)), 'mira');

  expect(await sayLast('And now?', 'unknown')).toMatchObject({
    status: 'rejected',
    reason: 'plugin_before_role_model_call_rejected',
  });
  expect(model.requests).toHaveLength(asked);
});

it('memory.character-state-idempotency: a patch whose identity a crash replayed into the log counts once, at its first occurrence', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const state = pluginData(home, 'character-state');
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');

  model.answer(
    calling(['character_state_patch', {mood: 'curious'}]),
    reply('Curious now.'),
  );
  await say('Be curious.', 'curious');
  await stop(first);

  const events = join(state, 'events.jsonl');
  const [patch = ''] = readFileSync(events, 'utf8').trim().split('\n');

  // The same identity again, as a retry after the crash appends it.
  appendFileSync(events, `${patch.replaceAll('"curious"', '"playful"')}\n`);
  rmSync(join(state, 'checkpoint.json'));

  const again = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('Hello.'));
  await again('How are you?', 'after');
  expect(runtimeNotesOf(model.requests.at(-1))).toContain('mood=curious');
  expect(
    JSON.parse(readFileSync(join(state, 'checkpoint.json'), 'utf8')),
  ).toMatchObject({eventCount: 1});
});

it('memory.session-history-guidance: with session-history on, the runtime notes carry its recall guidance, and with it off they do not', async () => {
  const model = await startModelServer();
  const notesWith = async (plugins: object) => {
    const say = await converse(
      wireOf(
        await startDaemon(
          createHome({
            'config.json': configJson({project02: model.settings, plugins}),
          }),
        ),
      ),
      'mira',
    );

    model.answer(reply('Hi.'));
    await say('Hello?', 'hello');

    return runtimeNotesOf(model.requests.at(-1));
  };

  expect(await notesWith({})).toContain('sessions.search');
  expect(await notesWith({'session-history': {enabled: false}})).not.toContain(
    'sessions.search',
  );
});

it("memory.session-history-index: the index holds the lines that committed, a rejected turn's among them, only while the plugin is on, and an index of a newer version or a corrupt one is rebuilt from the sessions' logs", async () => {
  const model = await startModelServer();
  const settings = {project02: {...model.settings, contextWindowTokens: 1}};
  // Each turn outgrows the window, so its session ends with it once its
  // summarizer, scripted to refuse, falls back.
  const turnIn = async (home: string, line: string, id: string) => {
    const daemon = await startDaemon(home);
    const say = await converse(wireOf(daemon), 'mira');

    await say(line, id);
    await stop(daemon);
  };
  const off = createHome({
    'config.json': configJson({
      ...settings,
      plugins: {'session-history': {enabled: false}},
    }),
  });
  const on = createHome({'config.json': configJson(settings)});
  const index = join(pluginData(on, 'session-history'), 'session-index.sqlite');
  const krakenFound = () =>
    toolResultsIn(model.requests.at(-2))[0]?.output?.['totalSessionsWithHits'];
  const searchAgain = async (id: string) => {
    model.answer(
      calling(['sessions_search', {query: 'kraken'}]),
      reply('Found it.'),
      {status: 400},
    );
    await turnIn(on, 'The sea monster?', id);
  };

  model.answer(reply('Noted.'), {status: 400});
  await turnIn(off, 'The kraken surfaced.', 'off');
  expect(existsSync(pluginData(off, 'session-history'))).toBe(false);
  // A rejected turn's line is committed before the model answers, so it
  // is indexed like any other.
  model.answer({status: 400});
  await turnIn(on, 'The kraken was rejected.', 'rejected');
  await searchAgain('after-rejection');
  expect(krakenFound()).toBe(1);
  model.answer(reply('Noted.'), {status: 400});
  await turnIn(on, 'The kraken surfaced.', 'on');
  expect(existsSync(index)).toBe(true);

  const version = (): unknown => {
    const database = new DatabaseSync(index);

    try {
      return database.prepare('PRAGMA user_version').get();
    } finally {
      database.close();
    }
  };
  const built = version();
  const database = new DatabaseSync(index);

  database.exec('PRAGMA user_version = 99');
  database.close();
  await searchAgain('newer');
  expect(krakenFound()).toBe(2);
  expect(version()).toEqual(built);

  for (const file of ['session-index.sqlite-wal', 'session-index.sqlite-shm']) {
    rmSync(join(pluginData(on, 'session-history'), file), {force: true});
  }

  writeFileSync(index, 'not a database');
  await searchAgain('corrupt');
  expect(krakenFound()).toBe(2);
  // Rebuilt, not worked around: a database again, at the version it was built at.
  expect(version()).toEqual(built);
});

it('memory.session-history-search: sessions.search finds lines of earlier sessions and lines out of the window but never what the model sees or its own interim reply; it routes CJK, short, non-ASCII case-folded and literal queries, keeps one best hit per session, the newest of equals, and centers a 160-character snippet on the match beside text bounded to 200', async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({
          project02: {...model.settings, contextWindowTokens: 1},
        }),
      }),
    ),
  );
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const long = `${'a'.repeat(300)} anchovy pizza ${'b'.repeat(300)}`;
  // Each completed turn outgrows the window and ends its session; its
  // summarizer is refused, so the session ends on its fallback.
  const sessions = [
    ['The kraken surfaced near the pier.', 'The kraken waved.'],
    ['Echoed kraken phrase.', 'Echoed kraken phrase.'],
    ['我们讨论了插件权限设计吗？', '讨论过。'],
    ['Привет, как дела?', 'Хорошо!'],
    [long, 'Noted.'],
  ] as const;
  const queries = [
    'kraken',
    '插件权限',
    'su',
    'ПР',
    '"kraken" OR pier*',
    'zephyr77',
    'glimmerwing',
    'anchovy',
  ];

  for (const [at, [line, answer]] of sessions.entries()) {
    model.answer(reply(answer), {status: 400});
    await say(line, `session-${String(at)}`);
  }

  // Refused, so it stays in the session the next turn runs in, out of a
  // window too small to hold it.
  model.answer({status: 400});
  await say('My locker code is zephyr77.', 'locker');
  model.answer(
    {
      chunks: [
        ...visibleReply('One moment, the phrase is glimmerwing.'),
        ...queries.flatMap((query, at) =>
          toolCall({
            index: at + 1,
            id: `call_${String(at)}`,
            name: 'sessions_search',
            arguments: JSON.stringify({query}),
          }),
        ),
        finish('tool_calls'),
      ],
    },
    reply('Found them.'),
    {status: 400},
  );
  await say('Is zephyr77 still my code?', 'search');

  type View = {
    readonly sessionId: string;
    readonly aroundMatch: readonly {
      readonly messageId: string;
      readonly text: string;
      readonly matched?: boolean;
      readonly snippet?: string;
    }[];
  };
  const results = toolResultsIn(model.requests.at(-2)).map(
    result =>
      result.output as {
        readonly totalSessionsWithHits: number;
        readonly sessions: readonly View[];
      },
  );
  const found = results.map(result =>
    result.sessions.map(view => view.sessionId).sort(),
  );
  const session = (segment: number) => `${conversationId}.${String(segment)}`;
  const matched = (view: View | undefined) =>
    view?.aroundMatch.find(message => message.matched === true);

  expect(found).toEqual([
    [session(1), session(2)],
    [session(3)],
    [session(1)],
    [session(4)],
    [],
    [session(6)],
    [],
    [session(5)],
  ]);
  expect(results[0]?.totalSessionsWithHits).toBe(2);
  expect(
    matched(results[0]?.sessions.find(view => view.sessionId === session(2)))
      ?.messageId,
  ).toBe(`${session(2)}:message-2`);
  expect(matched(results[5]?.sessions[0])?.text).toBe(
    'My locker code is zephyr77.',
  );

  const pizza = matched(results[7]?.sessions[0]);

  expect(pizza?.text).toHaveLength(200);
  expect(pizza?.snippet).toHaveLength(160);
  expect(pizza?.snippet).toMatch(/^\.\.\.a+ anchovy pizza b+\.\.\.$/u);
  expect(
    Math.abs(
      (pizza?.snippet?.indexOf('anchovy') ?? 0) -
        (pizza?.snippet?.length ?? 0) / 2,
    ),
  ).toBeLessThan(10);

  // With the window wide again, a line the model still sees is indexed
  // once committed but never found, while the earlier sessions still are.
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.contextWindowTokens', value: 32768},
  );
  model.answer(
    reply('Noted.'),
    calling(
      ['sessions_search', {query: 'moonwort'}],
      ['sessions_search', {query: 'kraken'}],
    ),
    reply('Found.'),
  );
  await say('The moonwort bloomed.', 'visible');
  await say('Did we speak of moonwort?', 'visible-search');
  expect(
    toolResultsIn(model.requests.at(-1)).map(result =>
      (result.output as {readonly sessions: readonly View[]}).sessions
        .map(view => view.sessionId)
        .sort(),
    ),
  ).toEqual([[], [session(1), session(2)]]);
});

it('memory.session-history-read: sessions.search anchors a view with the bookends of its session, sessions.read scrolls by anchor with paging flags and texts bounded to 400, an unknown session is session_not_found and an unknown anchor message_not_found, damage is counted, and a storage failure names no local path', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const earlier = `${conversationId}.1`;
  const story = 'A very long story. '.repeat(3_700);

  for (let turn = 0; turn < 10; turn += 1) {
    model.answer(reply(`Filler answer ${String(turn)}.`));
    await say(
      turn === 6
        ? 'Where did we put the anchovy pizza?'
        : `Filler question ${String(turn)}.`,
      `filler-${String(turn)}`,
    );
  }

  // Past half the window by itself: the session ends after this turn and
  // carries nothing, so all of it lies outside what the model sees.
  model.answer(reply(story), completion('We talked a lot.'));
  await say('Tell me a story.', 'story');
  appendFileSync(
    join(
      home,
      'character-data',
      'mira',
      'sessions',
      earlier,
      'raw-events.jsonl',
    ),
    'not-json\n',
  );
  model.answer(
    calling(
      ['sessions_search', {query: 'anchovy'}],
      [
        'sessions_read',
        {
          sessionId: earlier,
          anchorMessageId: `${earlier}:message-13`,
          window: 2,
        },
      ],
      ['sessions_read', {sessionId: earlier}],
      ['sessions_read', {sessionId: 'nope'}],
      [
        'sessions_read',
        {sessionId: earlier, anchorMessageId: `${earlier}:message-99`},
      ],
    ),
  );

  const broken = model.hold();
  const turn = say('Where was the pizza?', 'pizza');
  const outside = realpathSync(
    mkdtempSync(join(tmpdir(), 'project02-outside-')),
  );

  onTestFinished(() => {
    rmSync(outside, {recursive: true, force: true});
  });
  await broken.arrived();

  const sessionRoot = join(home, 'character-data', 'mira', 'sessions', earlier);

  cpSync(sessionRoot, outside, {recursive: true});
  rmSync(sessionRoot, {recursive: true});
  symlinkSync(outside, sessionRoot);
  model.answer(reply('In the fridge.'));
  broken.release(calling(['sessions_read', {sessionId: earlier}]));
  await turn;

  type Listed = {readonly messageId: string; readonly text: string};
  type Read = {
    readonly messages: readonly Listed[];
    readonly hasBefore: boolean;
    readonly hasAfter: boolean;
    readonly damagedRecordsSkipped: number;
  };
  type View = Record<
    'conversationStart' | 'aroundMatch' | 'conversationEnd',
    readonly Listed[]
  >;
  const numbers = (messages: readonly Listed[] | undefined) =>
    messages?.map(message => Number(message.messageId.split(':message-')[1]));
  const [search, around, latest, unknown, unanchored] = toolResultsIn(
    model.requests.at(-2),
  );
  const [view] = (search?.output as {readonly sessions: readonly View[]})
    .sessions;
  const [aroundRead, latestRead] = [around, latest].map(
    result => result?.output as Read | undefined,
  );

  expect([
    numbers(view?.conversationStart),
    numbers(view?.aroundMatch),
    numbers(view?.conversationEnd),
  ]).toEqual([
    [1, 2],
    [10, 11, 12, 13, 14, 15, 16],
    [21, 22],
  ]);
  expect(aroundRead).toMatchObject({
    hasBefore: true,
    hasAfter: true,
    damagedRecordsSkipped: 1,
  });
  expect(numbers(aroundRead?.messages)).toEqual([11, 12, 13, 14, 15]);
  expect(latestRead).toMatchObject({hasBefore: true, hasAfter: false});
  expect(numbers(latestRead?.messages)).toEqual([
    15, 16, 17, 18, 19, 20, 21, 22,
  ]);
  expect(latestRead?.messages.at(-1)?.text).toHaveLength(400);
  expect(unknown).toMatchObject({
    status: 'rejected',
    reason: 'session_not_found',
  });
  expect(unanchored).toMatchObject({
    status: 'rejected',
    reason: 'message_not_found',
  });

  const failed = toolResultsIn(model.requests.at(-1)).at(-1);

  expect(failed).toMatchObject({
    status: 'rejected',
    reason: 'session_history_read_failed',
  });
  // Nowhere in what the model is handed, not only in the message.
  expect(JSON.stringify(failed)).not.toContain(home);
  expect(JSON.stringify(failed)).not.toContain(outside);
});
