import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type ModelRequest,
} from './harness/model-server.ts';
import {converse, saveConfig, wireOf, type Wire} from './harness/wire.ts';

type Section = {
  readonly namespace: string;
  readonly id: string;
  readonly activation: {readonly status: string};
};

const mira = {scope: 'character', characterId: 'mira'} as const;
const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

function sectionsOf(view: unknown): readonly Section[] {
  return (view as {readonly sections: readonly Section[]}).sections;
}

function toolNames(request: ModelRequest | undefined): readonly string[] {
  return (
    request?.body as {
      readonly tools: readonly {readonly function: {readonly name: string}}[];
    }
  ).tools.map(tool => tool.function.name);
}

/** Each plugin the listing names, by its activation. */
function activationsListed(result: unknown): Record<string, string> {
  const {output} = result as {
    readonly output: {
      readonly plugins: readonly {
        readonly id: string;
        readonly activationStatus: string;
      }[];
    };
  };

  return Object.fromEntries(
    output.plugins.map(plugin => [plugin.id, plugin.activationStatus]),
  );
}

/** The lines of the system messages the model was shown. */
function systemLines(request: ModelRequest | undefined): readonly string[] {
  return messagesOf(request)
    .filter(message => message.role === 'system')
    .flatMap(message => String(message.content).split('\n'));
}

/** The demo-config settings her overlay authors. */
function demoConfigOverlay(
  home: string,
): Readonly<Record<string, unknown>> | undefined {
  return (
    JSON.parse(
      readFileSync(join(home, 'character-data', 'mira', 'config.json'), 'utf8'),
    ) as {
      readonly plugins: Readonly<
        Record<string, {readonly config?: Readonly<Record<string, unknown>>}>
      >;
    }
  ).plugins['demo-config']?.config;
}

function confirmationId(frame: Frame): string {
  return (JSON.parse(frame.data ?? '') as {readonly id: string}).id;
}

async function fingerprintOf(wire: Wire): Promise<string> {
  return ((await wire.configView(mira)) as {readonly fingerprint: string})
    .fingerprint;
}

it('plugins.default-catalog: a fresh home offers character-memory, character-state, demo-config, mem0, session-history and runtime.plugin, with character-memory, session-history and runtime.plugin on, demo-config and mem0 off, and character-state on only for a character whose package requires it', async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({project02: model.settings}),
        characters: {
          zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
        },
      }),
    ),
  );
  const catalog = async (characterId: string) => {
    const say = await converse(wire, characterId);

    model.answer(
      calling(['runtime_plugin_list', {scope: 'all'}]),
      reply('Listed.'),
    );
    await say('What plugins do you have?', characterId);

    return activationsListed(toolResults(model.requests.at(-1)).at(-1));
  };
  const bundled = {
    'runtime.plugin': 'active',
    'character-memory': 'active',
    'session-history': 'active',
    'demo-config': 'disabled',
    mem0: 'disabled',
  };

  expect(await catalog('mira')).toEqual({
    ...bundled,
    'character-state': 'active',
  });
  expect(await catalog('zeta')).toEqual({
    ...bundled,
    'character-state': 'disabled',
  });
});

it('plugins.tool-exposure: with runtime.plugin switched off, the model is offered none of the management tools', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: model.settings,
            plugins: {'runtime.plugin': {enabled: false}},
          }),
        }),
      ),
    ),
    'mira',
  );

  model.answer(reply('Hello.'));
  await say('Hello?', 'hello');

  const offered = toolNames(model.requests[0]);

  expect(offered).toContain('memory_update');

  for (const tool of [
    'runtime_plugin_list',
    'runtime_plugin_config',
    'runtime_plugin_config_update',
  ]) {
    expect(offered).not.toContain(tool);
  }
});

it("plugins.config-tools-read: runtime_plugin_config answers a plugin's metadata, activation, the fingerprint her settings hand out, its authored and effective values with secrets redacted, and the diagnostics of the documents, and refuses an empty id plugin_config_inspect_invalid", async () => {
  const secret = 'sk-demo-secret-value';
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({
          project02: model.settings,
          plugins: {
            'demo-config': {enabled: true, config: {signoff: 'Yours.'}},
            // A switch only a character may set: a warning in the home.
            'character-state': {enabled: true},
          },
        }),
        'character-data': {
          mira: {
            'config.json': configJson({
              plugins: {
                'demo-config': {config: {tone: 'warm', apiKey: secret}},
              },
            }),
          },
        },
      }),
    ),
  );
  const say = await converse(wire, 'mira');

  model.answer(
    calling(['runtime_plugin_config', {pluginId: 'demo-config'}]),
    calling(['runtime_plugin_config', {pluginId: 'character-state'}]),
    calling(['runtime_plugin_config', {pluginId: ''}]),
    reply('Inspected.'),
  );
  await say('How are your plugins set?', 'inspect');

  const [demoConfig, characterState, empty] = toolResults(
    model.requests.at(-1),
  );
  const fingerprint = await fingerprintOf(wire);

  expect(demoConfig).toMatchObject({
    status: 'accepted',
    output: {
      id: 'demo-config',
      displayName: 'Demo Config',
      version: '1.0.0',
      enabled: true,
      activation: {enabled: true, status: 'active'},
      fingerprint,
      diagnostics: [],
      fields: [
        {
          name: 'tone',
          agentMutable: true,
          authored: {configured: true, value: 'warm'},
          effective: {value: 'warm'},
        },
        {
          name: 'signoff',
          authored: {configured: false},
          effectiveSource: 'global',
          effective: {value: 'Yours.'},
        },
        {
          name: 'operatorNote',
          agentMutable: false,
          authored: {configured: false},
          effectiveSource: 'default',
          effective: {source: 'missing'},
        },
        {
          name: 'apiKey',
          sensitive: true,
          authored: {configured: true, value: '[redacted]'},
          effective: {value: '[redacted]'},
        },
      ],
    },
  });
  expect(JSON.stringify(model.requests)).not.toContain(secret);
  expect(characterState).toMatchObject({
    output: {
      fingerprint,
      diagnostics: [
        {
          severity: 'warning',
          code: 'runtime_config_authored_outside_scope',
          path: 'plugins.character-state.enabled',
        },
      ],
    },
  });
  expect(empty).toMatchObject({
    status: 'rejected',
    reason: 'plugin_config_inspect_invalid',
  });
});

it("plugins.config-tools-update: an approved update writes her overlay before the round after it, never the home's config, and the model is told it applied now, its reloadRequired and the new fingerprint; an unset works the same, its confirmation showing an unset", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
    }),
  });
  const homeConfig = readFileSync(join(home, 'config.json'), 'utf8');
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const events = await openEvents(daemon);
  const update = (fingerprint: string, change: object) =>
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'demo-config',
        fieldName: 'tone',
        expectedFingerprint: fingerprint,
        ...change,
      },
    ]);

  model.answer(
    update(await fingerprintOf(wire), {operation: 'set', value: 'formal'}),
  );

  const afterSet = model.hold();
  const turn = say('Be formal.', 'formal');

  await wire.answer(
    confirmationId(await events.next(frameOf('confirmation_requested'))),
    'approved',
  );

  const set = toolResults(await afterSet.arrived()).at(-1);

  expect(demoConfigOverlay(home)).toEqual({tone: 'formal'});
  expect(set).toEqual({
    status: 'accepted',
    pluginId: 'runtime.plugin',
    toolName: 'runtime.plugin.config.update',
    output: {
      status: 'applied',
      appliesTo: 'now',
      pluginId: 'demo-config',
      fieldName: 'tone',
      operation: 'set',
      fingerprint: await fingerprintOf(wire),
      reloadRequired: false,
    },
  });

  const {fingerprint} = (
    set as {readonly output: {readonly fingerprint: string}}
  ).output;

  model.answer(reply('Very well.'));
  afterSet.release(update(fingerprint, {operation: 'unset'}));

  const unsetAsked = await events.next(frameOf('confirmation_requested'));

  expect(JSON.parse(unsetAsked.data ?? '')).toMatchObject({
    request: {
      preview: {
        operation: 'unset',
        before: {configured: true, value: 'formal'},
        after: {configured: false},
      },
    },
  });
  await wire.answer(confirmationId(unsetAsked), 'approved');
  expect(await turn).toMatchObject({status: 'completed'});
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    output: {status: 'applied', operation: 'unset', appliesTo: 'now'},
  });
  expect(demoConfigOverlay(home)?.['tone']).toBeUndefined();
  expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(homeConfig);
});

it('plugins.config-tools-update-refusals: an update is refused without asking for approval for an unknown plugin, an operator-only or secret field, a set without a value or an unset with one, a value carrying a credential or a redaction, or while the authored config is invalid, never echoing the invalid value; a value the field refuses is handed back with the reason, and a corrected update in the same turn lands', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
    }),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const events = await openEvents(daemon);
  const fingerprint = await fingerprintOf(wire);
  const update = (change: object) =>
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'demo-config',
        fieldName: 'tone',
        operation: 'set',
        value: 'warm',
        expectedFingerprint: fingerprint,
        ...change,
      },
    ]);
  const invalid = (message: string) => ({
    status: 'rejected',
    reason: 'plugin_config_update_invalid',
    message: expect.stringContaining(message) as string,
  });

  model.answer(
    update({pluginId: 'not-installed'}),
    update({fieldName: 'operatorNote', value: 'Mine.'}),
    update({fieldName: 'apiKey', value: 'sk-chosen-by-the-model'}),
    update({value: undefined}),
    update({operation: 'unset'}),
    update({fieldName: 'signoff', value: {api_key: 'sk-nested'}}),
    update({fieldName: 'signoff', value: {note: '[redacted]'}}),
    update({value: 'grumpy'}),
    update({}),
    reply('Warmer now.'),
  );

  const turn = say('Be warmer.', 'warmer');

  await wire.answer(
    confirmationId(await events.next(frameOf('confirmation_requested'))),
    'approved',
  );
  expect(await turn).toMatchObject({status: 'completed'});
  expect(toolResults(model.requests.at(-1))).toEqual([
    expect.objectContaining({
      status: 'rejected',
      reason: 'plugin_config_unknown_plugin',
    }),
    expect.objectContaining(invalid('"operatorNote"')),
    expect.objectContaining(invalid('"apiKey"')),
    expect.objectContaining(invalid('must include value')),
    expect.objectContaining(invalid('must not include value')),
    expect.objectContaining(invalid('"signoff"')),
    expect.objectContaining(invalid('"signoff"')),
    expect.objectContaining(
      invalid('"tone" must be one of: neutral, warm, formal, playful, pirate'),
    ),
    expect.objectContaining({
      status: 'accepted',
      output: expect.objectContaining({status: 'applied'}) as unknown,
    }),
  ]);
  expect(demoConfigOverlay(home)).toEqual({tone: 'warm'});

  writeFileSync(
    join(home, 'config.json'),
    configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true, config: {signoff: 4242}}},
    }),
  );
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
    reply('Still warm.'),
  );
  await say('Be formal.', 'formal');

  const refused = toolResults(model.requests.at(-1)).at(-1);

  expect(refused).toMatchObject(invalid('"signoff"'));
  expect(JSON.stringify(refused)).not.toContain('4242');
  await events.next(frameOf('turn_completed', {clientMessageId: 'formal'}));
  expect(events.frames.filter(frameOf('confirmation_requested'))).toHaveLength(
    1,
  );
});

it('plugins.config-tools-conflict: an update approved after her settings changed while it waited is refused plugin_config_fingerprint_conflict and writes nothing', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
    }),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const events = await openEvents(daemon);

  model.answer(
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'demo-config',
        fieldName: 'tone',
        operation: 'set',
        value: 'pirate',
        expectedFingerprint: await fingerprintOf(wire),
      },
    ]),
    reply('Never mind.'),
  );

  const turn = say('Talk like a pirate.', 'pirate');
  const asked = await events.next(frameOf('confirmation_requested'));

  await saveConfig(wire, mira, {
    kind: 'section_field_set',
    namespace: 'plugins',
    id: 'demo-config',
    field: 'signoff',
    value: 'Yours.',
  });
  await wire.answer(confirmationId(asked), 'approved');
  expect(await turn).toMatchObject({status: 'completed'});
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'rejected',
    reason: 'plugin_config_fingerprint_conflict',
  });
  expect(demoConfigOverlay(home)).toEqual({signoff: 'Yours.'});
});

it('plugins.demo-config-fields: demo-config is bundled and off by default; its tone and signoff the model may change, its operatorNote not, and its apiKey is a secret', async () => {
  const wire = wireOf(await startDaemon(createHome()));
  const demoConfig = sectionsOf(await wire.configView({scope: 'global'})).find(
    section => section.id === 'demo-config',
  );

  expect(demoConfig).toMatchObject({
    namespace: 'plugins',
    enabled: false,
    enabledSource: 'default',
    activation: {status: 'disabled'},
    fields: [
      {name: 'tone', secret: false, agentMutable: true},
      {name: 'signoff', secret: false, agentMutable: true},
      {name: 'operatorNote', secret: false, agentMutable: false},
      {name: 'apiKey', secret: true, agentMutable: false},
    ],
  });
});

it('plugins.demo-config-directives: switched on, demo-config adds one style directive naming the tone, neutral while it is unset, and the exact signoff once one is set, none while it is blank', async () => {
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
  const directives = async (id: string): Promise<readonly string[]> => {
    model.answer(reply('Noted.'));
    await say('Hello.', id);

    return systemLines(model.requests.at(-1)).filter(line =>
      line.includes(' tone'),
    );
  };
  const configure = async (field: string, value: string): Promise<void> => {
    await saveConfig(wire, mira, {
      kind: 'section_field_set',
      namespace: 'plugins',
      id: 'demo-config',
      field,
      value,
    });
    await events.next(
      frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
    );
  };

  const unset = await directives('unset');

  expect(unset).toEqual([expect.stringContaining('neutral tone') as string]);
  expect(unset[0]).not.toContain('signoff');

  await configure('tone', 'pirate');
  await configure('signoff', 'Arr, matey!');

  const set = await directives('set');

  expect(set).toEqual([expect.stringContaining('pirate tone') as string]);
  expect(set[0]).toContain('"Arr, matey!"');

  await configure('signoff', '   ');
  expect(await directives('blank')).toEqual([
    expect.not.stringContaining('signoff') as string,
  ]);
});

it('plugins.memory-provider-selection: a default memory provider naming one that is not on, or one this build lacks while another is on, is default_memory_provider_unavailable, and naming a plugin of another kind default_memory_provider_not_memory_provider, each blocking her plugins and leaving off the plugin it names or displaces', async () => {
  for (const [named, code, plugins, off] of [
    ['mem0', 'default_memory_provider_unavailable', {}, 'mem0'],
    [
      'demo-config',
      'default_memory_provider_not_memory_provider',
      {},
      'demo-config',
    ],
    [
      'mem00',
      'default_memory_provider_unavailable',
      {mem0: {enabled: true}},
      'mem0',
    ],
  ] as const) {
    const wire = wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({
            project02: {defaultMemoryProvider: named},
            plugins,
          }),
        }),
        fixedReplies,
      ),
    );

    expect(await wire.start('mira'), named).toMatchObject({
      character: {
        state: 'failed',
        diagnostic: expect.stringContaining(`"${named}"`) as string,
      },
    });

    const view = await wire.configView(mira);
    const status = (id: string) =>
      sectionsOf(view).find(section => section.id === id)?.activation;

    expect(view, named).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code,
          path: 'project02.defaultMemoryProvider',
        }),
      ]) as unknown[],
    });
    expect(status('character-memory'), named).toMatchObject({
      status: 'blocked',
    });
    expect(status('session-history'), named).toMatchObject({
      status: 'blocked',
    });
    expect(status(off), named).toMatchObject({
      enabled: false,
      status: 'disabled',
    });
  }
});

it("plugins.activation-fails-closed: a config.json that does not load fails the character with the error in health, and an enabled plugin's invalid setting leaves no plugin but runtime.plugin active and fails the character", async () => {
  const unloadable = wireOf(
    await startDaemon(createHome({'config.json': '{not json'})),
  );

  await unloadable.start('mira');
  expect(await unloadable.health()).toMatchObject({
    config: {
      diagnostics: [{severity: 'error', code: 'runtime_config_malformed_json'}],
    },
    characters: [
      {
        id: 'mira',
        state: 'failed',
        diagnostic: expect.stringContaining('not valid JSON') as string,
      },
    ],
  });

  const invalid = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({
          plugins: {'demo-config': {enabled: true, config: {tone: 42}}},
        }),
      }),
    ),
  );

  await invalid.start('mira');
  expect(await invalid.health()).toMatchObject({
    characters: [
      {
        id: 'mira',
        state: 'failed',
        diagnostic: expect.stringContaining('"tone"') as string,
      },
    ],
  });
  expect(
    sectionsOf(await invalid.configView(mira))
      .filter(
        section =>
          section.namespace === 'plugins' &&
          section.activation.status === 'active',
      )
      .map(section => section.id),
  ).toEqual(['runtime.plugin']);
});
