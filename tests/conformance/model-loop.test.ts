import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {configJson, createHome, sessionRecords} from './harness/home.ts';
import {
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
  readonly rejection?: {readonly details: string};
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

it('model.decision-parse-failure-fed-back: a round of empty content, a blank reply, arguments that are no object, or a blank reply beside a call is refused whole, nothing of it dispatched, and quoted back to the model in the next round, which can recover', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);

  model.answer(
    {chunks: [...content(''), finish('stop')]},
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

it("model.note-never-shown: the model's note beside its calls never reaches the person: it is no message, no draft and no line of history", async () => {
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
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{text: 'Anything new?'}, {text: 'Here you are.'}],
  });
  expect(JSON.stringify(events.frames)).not.toContain('private note');
});
