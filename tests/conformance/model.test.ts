import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  content,
  finish,
  reply,
  startModelServer,
  visibleReply,
} from './harness/model-server.ts';
import {converse, wireOf} from './harness/wire.ts';

it('model.provider-request-body: a round asks the model for a streamed completion with usage, automatic and parallel tool calls, and thinking on', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({
        project02: {...model.settings, nvidiaModel: 'conformance-model'},
      }),
    }),
  );
  const say = await converse(wireOf(daemon), 'mira');

  model.answer(reply('Hello from the model.'));
  expect(await say('Hello?', 'hello')).toMatchObject({
    status: 'completed',
    messages: [
      {speakerName: 'You', text: 'Hello?'},
      {speakerName: 'Mira', text: 'Hello from the model.'},
    ],
  });
  expect(model.requests[0]?.body).toMatchObject({
    model: 'conformance-model',
    stream: true,
    stream_options: {include_usage: true},
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning_budget: expect.any(Number) as number,
    chat_template_kwargs: {enable_thinking: true},
  });
});

it('model.reply-drafts: a visible_reply is drafted as its arguments stream, escapes decoded and a possible tag held to the end, while plain content and the words beside a call never are', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);

  model.answer(
    {chunks: [...content('Plain words.', 6), finish('stop')]},
    {
      chunks: [
        ...content('A note to myself.'),
        // Two cuts fall inside an escaped quote, and `<thin` could open a
        // tag until the call is whole.
        ...visibleReply('Say "hi"\nthen <thin', 10, 14, 18, 24),
        finish('tool_calls'),
      ],
    },
  );
  expect(await say('One.', 'plain')).toMatchObject({
    messages: [{}, {text: 'Plain words.'}],
  });
  expect(await say('Two.', 'drafted')).toMatchObject({
    messages: [{}, {text: 'Say "hi"\nthen <thin'}],
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'drafted'}));
  expect(
    events.frames
      .filter(frameOf('turn_progress', {progress: {kind: 'reply_delta'}}))
      .map(
        frame =>
          (JSON.parse(frame.data ?? '') as {progress: {text: string}}).progress
            .text,
      ),
  ).toEqual(['S', 'ay ', '"hi', '"\nthe', 'n ', '<thin']);
});
