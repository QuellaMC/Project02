import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {configJson, createHome, snapshot} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
} from './harness/model-server.ts';
import {converse, wireOf} from './harness/wire.ts';

it('plugins.character-state-patch: a state patch shows in her next prompt, while one its input schema refuses never reaches the plugin: the model is told which field, the turn goes on to its reply, and her state stays as it was', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');
  const state = join(
    home,
    'character-data',
    'mira',
    'plugin-data',
    'character-state',
  );

  model.answer(
    calling(['character_state_patch', {mood: 'playful'}]),
    reply('Playful.'),
  );
  await say('Feeling playful?', 'playful');

  const kept = snapshot(state);

  model.answer(
    calling(['character_state_patch', {mood: 'angry'}]),
    reply('Hm.'),
    reply('Still playful.'),
  );
  expect(await say('Be angry.', 'angry')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Hm.'}],
  });
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'rejected',
    reason: 'invalid_input',
    message: expect.stringContaining('"mood"') as string,
  });
  expect(snapshot(state)).toEqual(kept);
  await say('How are you?', 'how');
  expect(
    messagesOf(model.requests.at(-1)).some(
      message =>
        message.role === 'system' &&
        message.content?.includes('mood=playful') === true,
    ),
  ).toBe(true);
});
