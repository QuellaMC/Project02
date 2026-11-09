import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type ModelRequest,
} from './harness/model-server.ts';
import {converse, saveConfig, wireOf, type Wire} from './harness/wire.ts';

const mira = {scope: 'character', characterId: 'mira'} as const;
const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

function toolNames(request: ModelRequest | undefined): readonly string[] {
  return (
    request?.body as {
      readonly tools: readonly {readonly function: {readonly name: string}}[];
    }
  ).tools.map(tool => tool.function.name);
}

/** The lines of the system messages the model was shown. */
function systemLines(request: ModelRequest | undefined): readonly string[] {
  return messagesOf(request)
    .filter(message => message.role === 'system')
    .flatMap(message => String(message.content).split('\n'));
}

function confirmationId(frame: Frame): string {
  return (JSON.parse(frame.data ?? '') as {readonly id: string}).id;
}

async function fingerprintOf(wire: Wire): Promise<string> {
  return ((await wire.configView(mira)) as {readonly fingerprint: string})
    .fingerprint;
}

/** Mira on the model server, demo-config switched on beside the plugins she runs by default. */
async function demoConfigHome() {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({
        project02: model.settings,
        plugins: {'demo-config': {enabled: true}},
      }),
    }),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const events = await openEvents(daemon);

  return {model, wire, say, events};
}

it('plugins.tool-exposure: the model is offered the tools of each plugin she runs, and once one is switched off on her screen, none of its tools', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const events = await openEvents(daemon);
  const management = [
    'runtime_plugin_list',
    'runtime_plugin_config',
    'runtime_plugin_config_update',
  ];
  const others = [
    'visible_reply',
    'memory_update',
    'character_state_patch',
    'sessions_search',
    'sessions_read',
  ];

  model.answer(reply('Hello.'));
  await say('Hello?', 'on');
  expect(toolNames(model.requests.at(-1))).toEqual(
    expect.arrayContaining([...others, ...management]),
  );
  await saveConfig(wire, mira, {
    kind: 'section_enabled',
    namespace: 'plugins',
    id: 'runtime.plugin',
    enabled: false,
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  model.answer(reply('Hello again.'));
  await say('Hello?', 'off');

  const offered = toolNames(model.requests.at(-1));

  expect(offered).toEqual(expect.arrayContaining(others));

  for (const tool of management) {
    expect(offered).not.toContain(tool);
  }
});

it("plugins.config-tools-read: runtime_plugin_config shows the model a plugin's settings with a secret only as [redacted], so the secret never reaches the model's server", async () => {
  const secret = 'sk-demo-secret-value';
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: model.settings,
            plugins: {'demo-config': {enabled: true}},
          }),
          'character-data': {
            mira: {
              'config.json': configJson({
                plugins: {'demo-config': {config: {apiKey: secret}}},
              }),
            },
          },
        }),
      ),
    ),
    'mira',
  );

  model.answer(
    calling(['runtime_plugin_config', {pluginId: 'demo-config'}]),
    reply('Inspected.'),
  );
  await say('How is demo-config set?', 'inspect');
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'accepted',
      output: {
        id: 'demo-config',
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'apiKey',
            authored: expect.objectContaining({value: '[redacted]'}) as unknown,
            effective: expect.objectContaining({
              value: '[redacted]',
            }) as unknown,
          }),
        ]) as unknown[],
      },
    },
  ]);
  expect(JSON.stringify(model.requests)).not.toContain(secret);
});

it('plugins.config-tools-update-refusals: an update to a secret setting, or to one only the person may change, is refused without asking the person', async () => {
  const {model, wire, say, events} = await demoConfigHome();
  const fingerprint = await fingerprintOf(wire);
  const update = (fieldName: string, value: string) =>
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'demo-config',
        fieldName,
        operation: 'set',
        value,
        expectedFingerprint: fingerprint,
      },
    ]);
  const refused = (fieldName: string) => ({
    status: 'rejected',
    reason: 'plugin_config_update_invalid',
    message: expect.stringContaining(`"${fieldName}"`) as string,
  });

  model.answer(
    update('apiKey', 'sk-chosen-by-the-model'),
    update('operatorNote', 'Mine.'),
    reply('I may not.'),
  );
  expect(await say('Use this key.', 'key')).toMatchObject({
    status: 'completed',
  });
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    refused('apiKey'),
    refused('operatorNote'),
  ]);
  await events.next(frameOf('turn_completed', {clientMessageId: 'key'}));
  expect(events.frames.filter(frameOf('confirmation_requested'))).toEqual([]);
});

it("plugins.config-tools-live-apply: an approved change of hers takes effect within its turn, the model's very next round already showing it", async () => {
  const {model, wire, say, events} = await demoConfigHome();
  const toneOf = (request: ModelRequest | undefined) =>
    systemLines(request).filter(line => line.includes(' tone'));

  model.answer(
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'demo-config',
        fieldName: 'tone',
        operation: 'set',
        value: 'formal',
        expectedFingerprint: await fingerprintOf(wire),
      },
    ]),
    reply('Very well.'),
  );

  const turn = say('Be formal.', 'formal');

  await wire.answer(
    confirmationId(await events.next(frameOf('confirmation_requested'))),
    'approved',
  );
  expect(await turn).toMatchObject({status: 'completed'});
  expect(model.requests.slice(-2).map(toneOf)).toEqual([
    [expect.stringContaining('neutral tone') as string],
    [expect.stringContaining('formal tone') as string],
  ]);
});

it('plugins.memory-provider-selection: naming as her memory provider a plugin that is off fails her, saying so at that setting; she stays failed until the setting is put right, which starts her again', async () => {
  const daemon = await startDaemon(createHome(), {
    ...fixedReplies,
    PROJECT02_TEST_DURATIONS: 'heartbeat=500',
  });
  const wire = wireOf(daemon);

  await wire.start('mira');

  const events = await openEvents(daemon);
  const statesOfMira = () =>
    events.frames.filter(frameOf('state_changed', {characterId: 'mira'}));

  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.defaultMemoryProvider', value: 'mem0'},
  );
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'failed'}),
  );
  expect(await wire.health()).toMatchObject({
    characters: [
      {
        id: 'mira',
        state: 'failed',
        diagnostic: expect.stringContaining('"mem0"') as string,
      },
    ],
  });
  expect(await wire.configView(mira)).toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        path: 'project02.defaultMemoryProvider',
      }),
    ]) as unknown[],
  });

  // Tried again by nothing: two heartbeats on, nothing more has happened to her.
  const failedSoFar = statesOfMira().length;

  for (let beat = 0; beat < 2; beat += 1) {
    await events.next(frame => frame.comment === 'ping');
  }

  expect(statesOfMira()).toHaveLength(failedSoFar);
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'unset', path: 'project02.defaultMemoryProvider'},
  );
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
});
