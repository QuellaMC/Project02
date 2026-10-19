import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {configJson, createHome, sessionRecords} from './harness/home.ts';
import {
  calling,
  content,
  finish,
  messagesOf,
  reply,
  startModelServer,
  toolCall,
  visibleReply,
  type ModelRequest,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

type Decision = {
  readonly status: string;
  readonly decision?: {readonly text?: string};
  readonly rejection?: {readonly reason: string; readonly details: string};
};

/** What the parser made of each round, as the rounds were recorded. */
function decisionsOf(home: string): Decision[] {
  return sessionRecords(home, 'mira', 'role_model_round').map(
    record =>
      (record['parsedRoleModelDecisionSnapshot'] as {readonly result: Decision})
        .result,
  );
}

/** The system notes a request carries after the conversation began. */
function notesIn(request: ModelRequest): string[] {
  const messages = messagesOf(request);

  return messages
    .slice(messages.findIndex(message => message.role !== 'system'))
    .filter(message => message.role === 'system')
    .map(message => message.content ?? '');
}

function listing(index: number, argumentsText = '{}'): unknown[] {
  return toolCall({
    index,
    id: `call_list_${String(index)}`,
    name: 'runtime_plugin_list',
    arguments: argumentsText,
  });
}

it('model.decision-parse-failure-fed-back: a round that neither replies nor calls, replies blank, passes arguments that are no object, or replies blank beside a call is refused whole, nothing of it dispatched, recorded, and quoted back to the model in exactly the next round, which can recover', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);

  model.answer(
    {chunks: [finish('stop')]},
    {chunks: [...visibleReply('   '), finish('tool_calls')]},
    {chunks: [...listing(0, '[1]'), finish('tool_calls')]},
    {chunks: [...visibleReply(' '), ...listing(1), finish('tool_calls')]},
    reply('Recovered.'),
  );
  expect(await say('Hello?', 'hello')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Recovered.'}],
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'hello'}));

  const decisions = decisionsOf(home);

  expect(decisions.map(decision => decision.status)).toEqual([
    'rejected',
    'rejected',
    'rejected',
    'rejected',
    'accepted',
  ]);
  expect(model.requests.map(notesIn)).toEqual([
    [],
    ...decisions
      .slice(0, 4)
      .map(decision => [
        expect.stringContaining(
          JSON.stringify(decision.rejection?.details),
        ) as string,
      ]),
  ]);
  expect(sessionRecords(home, 'mira', 'tool_call_started')).toEqual([]);
  expect(
    events.frames.filter(
      frameOf('turn_progress', {progress: {kind: 'tool_calls_requested'}}),
    ),
  ).toEqual([]);
});

it('model.round-budget: a turn ends rejected tool_rounds_exhausted once its rounds are spent, the call of the round past them never dispatched, and rejected provider_error at once when the provider gave no usable output', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);

  model.answer(
    ...Array.from({length: 100}, () =>
      calling(['runtime_plugin_config', {pluginId: 'nothing'}]),
    ),
  );

  const turn = say('Keep looking.', 'looking');

  // A hundred rounds outlast one wait: each dispatched call is seen through.
  for (let round = 0; round < 99; round += 1) {
    await events.next(
      frameOf('turn_progress', {progress: {kind: 'tool_call_completed'}}),
    );
  }

  expect(await turn).toMatchObject({
    status: 'rejected',
    reason: 'tool_rounds_exhausted',
  });
  expect(model.requests).toHaveLength(100);
  expect(sessionRecords(home, 'mira', 'tool_call_started')).toHaveLength(99);
  model.answer({status: 400, body: {error: {message: 'Not now.'}}});
  expect(await say('Hello?', 'failed')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
  });
  expect(model.requests).toHaveLength(101);
});

it("model.note-never-shown: the model's note beside its calls is stored with its round's decision and never becomes a message", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  model.answer(
    {
      chunks: [
        ...content('A private note.'),
        ...listing(1),
        finish('tool_calls'),
      ],
    },
    {
      chunks: [
        ...content('Another private note.'),
        ...visibleReply('Here you are.'),
        finish('tool_calls'),
      ],
    },
  );
  expect(await say('Anything new?', 'new')).toMatchObject({
    messages: [{text: 'Anything new?'}, {text: 'Here you are.'}],
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'new'}));
  expect(decisionsOf(home).map(decision => decision.decision?.text)).toEqual([
    'A private note.',
    'Another private note.',
  ]);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{text: 'Anything new?'}, {text: 'Here you are.'}],
  });
  expect(JSON.stringify(events.frames)).not.toContain('private note');
});

it('model.multi-reply-turn: replies that rounds of one turn said alike read back as separate messages, and replies that normalize to the same text are each kept, normalized', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');

  model.answer(
    {
      chunks: [
        ...visibleReply('  Checking.  '),
        ...listing(1),
        finish('tool_calls'),
      ],
    },
    {
      chunks: [
        ...visibleReply('Checking.\r\n'),
        ...listing(1),
        finish('tool_calls'),
      ],
    },
    {chunks: [...visibleReply('Checking.'), finish('tool_calls')]},
  );
  await say('Anything?', 'anything');
  first.signal('SIGINT');
  await first.exit();

  const wire = wireOf(await startDaemon(home));

  await wire.start('mira');

  const {conversationId} = await conversationOf(wire, 'mira');
  const {messages} = (await wire.history(conversationId)) as {
    readonly messages: readonly {
      readonly messageId: string;
      readonly text: string;
    }[];
  };

  expect(messages.map(message => message.text)).toEqual([
    'Anything?',
    'Checking.',
    'Checking.',
    'Checking.',
  ]);
  expect(new Set(messages.map(message => message.messageId)).size).toBe(4);
});
