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

/** Mira on the model server, her reply style switched on beside the plugins she runs by default. */
async function replyStyleHome() {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({project02: model.settings}),
      'character-data': {
        mira: {
          'config.json': configJson({
            plugins: {'reply-style': {enabled: true}},
          }),
        },
      },
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
  model.answer(reply('Hello again.'));
  await say('Hello?', 'off');

  const offered = toolNames(model.requests.at(-1));

  expect(offered).toEqual(expect.arrayContaining(others));

  for (const tool of management) {
    expect(offered).not.toContain(tool);
  }
});

it("plugins.config-tools-read: runtime_plugin_config shows the model one plugin's settings as her own screen has them, what she set and what is in effect, and nothing the home alone sets: a key the home keeps for a plugin never reaches the model's server", async () => {
  const secret = 'm0-secret-key-value';
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: model.settings,
            plugins: {mem0: {config: {apiKey: secret}}},
          }),
          'character-data': {
            mira: {
              'config.json': configJson({
                plugins: {'reply-style': {config: {signoff: 'Yours.'}}},
              }),
            },
          },
        }),
      ),
    ),
    'mira',
  );

  model.answer(
    calling(
      ['runtime_plugin_config', {pluginId: 'reply-style'}],
      ['runtime_plugin_config', {pluginId: 'mem0'}],
    ),
    reply('Inspected.'),
  );
  await say('How are you set?', 'inspect');
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'accepted',
      output: {
        id: 'reply-style',
        fields: [
          {name: 'tone', authored: {configured: false}},
          {
            name: 'signoff',
            authored: {configured: true, value: 'Yours.'},
            effective: {value: 'Yours.'},
          },
        ],
      },
    },
    {status: 'accepted', output: {id: 'mem0', fields: []}},
  ]);
  expect(JSON.stringify(model.requests)).not.toContain(secret);
});

it('plugins.config-tools-update-refusals: an update to a secret setting, or to one only the person may change, is refused without asking the person, saying which it is', async () => {
  const {model, wire, say, events} = await replyStyleHome();
  const fingerprint = await fingerprintOf(wire);
  const update = (fieldName: string, value: string) =>
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'mem0',
        fieldName,
        operation: 'set',
        value,
        expectedFingerprint: fingerprint,
      },
    ]);
  const refused = (why: string) => ({
    status: 'rejected',
    reason: 'plugin_config_update_invalid',
    message: expect.stringContaining(why) as string,
  });

  model.answer(
    update('apiKey', 'sk-chosen-by-the-model'),
    update('backend', 'server'),
    reply('I may not.'),
  );
  expect(await say('Use this key.', 'key')).toMatchObject({
    status: 'completed',
  });
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    refused('"apiKey" is secret'),
    refused('"backend" is not one you may change'),
  ]);
  await events.next(frameOf('turn_completed', {clientMessageId: 'key'}));
  expect(events.frames.filter(frameOf('confirmation_requested'))).toEqual([]);
});

it('plugins.config-tools-live-apply: each change of hers the person approves is written at once and in effect from her very next request, a second change in the same reply as much as the first', async () => {
  const {model, wire, say, events} = await replyStyleHome();
  const update = (fieldName: string, value: string, fingerprint: string) =>
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'reply-style',
        fieldName,
        operation: 'set',
        value,
        expectedFingerprint: fingerprint,
      },
    ]);
  const approve = async () =>
    wire.answer(
      confirmationId(await events.next(frameOf('confirmation_requested'))),
      'approved',
    );
  /** The fingerprint her settings have after the change the request was told of. */
  const fingerprintAfter = (request: ModelRequest) =>
    (toolResults(request).at(-1) as {readonly output: {fingerprint: string}})
      .output.fingerprint;
  const styleOf = (request: ModelRequest | undefined) =>
    systemLines(request)
      .filter(line => line.includes(' tone'))
      .join('\n');

  model.answer(update('tone', 'formal', await fingerprintOf(wire)));

  const afterTone = model.hold();
  const turn = say('Be formal, and sign off.', 'formal');

  await approve();
  model.answer(reply('Very well.'));
  afterTone.release(
    update('signoff', 'Yours.', fingerprintAfter(await afterTone.arrived())),
  );
  await approve();
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Very well.'}],
  });

  const [asked, toned, signed] = model.requests.map(styleOf);

  expect(asked).toContain('neutral tone.');
  expect(toned).toContain('formal tone.');
  expect(toned).not.toContain('signoff');
  expect(signed).toContain(
    'formal tone. End everything you say with the exact signoff "Yours."',
  );
});
