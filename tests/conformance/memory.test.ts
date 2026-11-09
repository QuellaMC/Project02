import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type ModelRequest,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

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
      join(
        home,
        'character-data',
        'mira',
        'plugin-data',
        'character-memory',
        'memory.json',
      ),
      'utf8',
    ),
  ) as unknown;
}

it('memory.character-memory-tool: memory.update adds, replaces and removes entries of notes and user_profile, and a batch whose old_text matches several entries is refused whole, changing nothing', async () => {
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
        {
          action: 'replace',
          target: 'notes',
          old_text: 'black',
          text: 'Likes oolong.',
        },
        {action: 'remove', target: 'user_profile', old_text: 'Sam'},
      ),
    ),
    calling(
      memoryUpdate(
        {action: 'add', target: 'notes', text: 'Plays go.'},
        {action: 'replace', target: 'notes', old_text: 'Likes', text: 'Hm.'},
      ),
    ),
    reply('Done.'),
  );
  await say('Remember these.', 'remember');
  expect(toolResultsIn(model.requests.at(-1))).toMatchObject([
    {status: 'accepted'},
    {status: 'accepted'},
    {status: 'rejected', reason: 'memory_old_text_ambiguous'},
  ]);
  expect(storedMemory(home)).toMatchObject({
    notes: ['Likes green tea.', 'Likes oolong.'],
    userProfile: [],
  });
});

it('memory.character-memory-snapshot: a memory she writes is in her system prompt once she starts again', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');

  model.answer(
    calling(memoryUpdate({action: 'add', target: 'notes', text: 'Likes tea.'})),
    reply('Noted.'),
  );
  await say('I like tea.', 'tea');
  await stop(first);

  const again = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('Tea, yes.'));
  await again('Do you remember?', 'remember');
  expect(
    messagesOf(model.requests.at(-1)).some(
      message =>
        message.role === 'system' &&
        message.content?.includes('Likes tea.') === true,
    ),
  ).toBe(true);
});

it('memory.character-state-store: a state she patches is still hers after a restart, in the runtime notes the model reads', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');

  model.answer(
    calling(['character_state_patch', {mood: 'curious'}]),
    reply('Curious now.'),
  );
  await say('Be curious.', 'curious');
  await stop(first);

  const again = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('Still curious.'));
  await again('How are you?', 'after');
  expect(runtimeNotesOf(model.requests.at(-1))).toContain('mood=curious');
});

it("memory.session-history-search: sessions.search finds the person's lines in her earlier sessions, by a CJK query too, and sessions.read reads back a session it found", async () => {
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
  const session = (segment: number) => `${conversationId}.${String(segment)}`;
  const sessions = [
    ['The kraken surfaced near the pier.', 'The kraken waved.'],
    ['我们讨论了插件权限设计吗？', '讨论过。'],
  ] as const;

  // Each turn outgrows the window and ends its session; its summarizer is
  // refused, so the session ends on its fallback.
  for (const [at, [line, answer]] of sessions.entries()) {
    model.answer(reply(answer), {status: 400});
    await say(line, `session-${String(at)}`);
  }

  model.answer(
    calling(
      ['sessions_search', {query: 'kraken'}],
      ['sessions_search', {query: '插件权限'}],
      ['sessions_read', {sessionId: session(1)}],
    ),
    reply('Found them.'),
    {status: 400},
  );
  await say('Do you remember?', 'search');

  const [kraken, cjk, read] = toolResultsIn(model.requests.at(-2));
  const found = (result: ToolResult | undefined) =>
    (
      result?.output as
        {readonly sessions: readonly {readonly sessionId: string}[]} | undefined
    )?.sessions.map(view => view.sessionId);

  expect(found(kraken)).toEqual([session(1)]);
  expect(found(cjk)).toEqual([session(2)]);
  expect(
    (
      read?.output as
        {readonly messages: readonly {readonly text: string}[]} | undefined
    )?.messages.map(message => message.text),
  ).toEqual(sessions[0]);
});
