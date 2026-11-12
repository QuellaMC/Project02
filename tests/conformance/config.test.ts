import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, chmod, configJson, createHome} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type ModelRequest,
} from './harness/model-server.ts';
import {
  changeConfig,
  conversationOf,
  converse,
  saveConfig,
  wireOf,
  type Wire,
} from './harness/wire.ts';

type Field = {
  readonly name: string;
  readonly label?: string;
  readonly authored: {readonly configured: boolean; readonly value?: unknown};
  readonly effectiveSource: string;
  readonly effective: {readonly source: string; readonly value?: unknown};
};

type Section = {
  readonly namespace: string;
  readonly id: string;
  readonly enabled: boolean;
  readonly fields: readonly Field[];
  readonly layout: readonly object[];
};

type View = {
  readonly fingerprint: string;
  readonly project02: readonly Field[];
  readonly sections: readonly Section[];
};

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
const mira = {scope: 'character', characterId: 'mira'} as const;

async function viewOf(
  wire: Wire,
  target: Parameters<Wire['configView']>[0],
): Promise<View> {
  return (await wire.configView(target)) as View;
}

function hostField(view: View, name: string): Field | undefined {
  return view.project02.find(field => field.name === name);
}

function sectionOf(view: View, id: string): Section | undefined {
  return view.sections.find(section => section.id === id);
}

function homeDocument(home: string): string {
  return readFileSync(join(home, 'config.json'), 'utf8');
}

/** The line of the model's system messages where her reply style names the tone. */
function toneIn(request: ModelRequest | undefined): string | undefined {
  return messagesOf(request)
    .filter(message => message.role === 'system')
    .flatMap(message => String(message.content).split('\n'))
    .find(line => line.includes(' tone'));
}

it("config.view-global: the home's view lists the host fields the home may set in page order, each with its label, what the home authored, what is in effect and where it comes from, every section the home may set with how a page draws it and its fields laid out in cards, the document's diagnostics and a fingerprint", async () => {
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({
          project02: {userDisplayName: 'Robin'},
          connectors: {discord: {}},
        }),
      }),
    ),
  );
  const view = await viewOf(wire, {scope: 'global'});
  /** A host field the home leaves unset and no default supplies. */
  const unset = (name: string) => ({
    name,
    authored: {configured: false},
    effectiveSource: 'default',
    effective: {source: 'missing', secret: name.endsWith('ApiKey')},
  });

  expect(view).toMatchObject({
    status: 'ok',
    fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string,
    diagnostics: [
      {
        severity: 'warning',
        code: 'runtime_config_unknown_connector',
        path: 'connectors.discord',
      },
    ],
    project02: [
      {
        name: 'userDisplayName',
        label: 'Name',
        authored: {configured: true, value: 'Robin'},
        effectiveSource: 'global',
        effective: {source: 'config', value: 'Robin'},
      },
      unset('roleModelProvider'),
      unset('openaiApiKey'),
      {
        name: 'openaiModel',
        authored: {configured: false},
        effectiveSource: 'default',
        effective: {source: 'default', value: 'gpt-6-luna'},
      },
      unset('nvidiaApiKey'),
      unset('nvidiaModel'),
      unset('nvidiaBaseUrl'),
      {
        name: 'contextWindowTokens',
        authored: {configured: false},
        effectiveSource: 'default',
        effective: {source: 'default', value: 32768},
      },
    ],
  });
  expect(
    view.sections.map(section => `${section.namespace}.${section.id}`),
  ).toEqual([
    'plugins.character-memory',
    'plugins.mem0',
    'plugins.phone',
    'plugins.runtime.plugin',
    'plugins.session-history',
    'connectors.telegram',
  ]);
  expect(sectionOf(view, 'mem0')).toMatchObject({
    displayName: 'Long-Term Memory',
    page: {
      summary: 'Remembers across all chats',
      icon: 'archive',
      tint: 'brown',
      placement: 'mind_body',
      order: 3,
      connection: 'Memory',
    },
    access: {network: 'write'},
  });
  expect(sectionOf(view, 'mem0')?.layout.slice(0, 2)).toEqual([
    {advanced: false, rows: [{field: 'backend'}]},
    {
      footer: 'Get a key at app.mem0.ai.',
      advanced: false,
      when: {field: 'backend', is: ['platform']},
      rows: [{field: 'apiKey'}],
    },
  ]);
});

it('config.change-ops: set, unset, section_enabled and a section field set and unset each answer applied with the new fingerprint, which the next view carries with the change in it', async () => {
  const wire = wireOf(await startDaemon(createHome()));
  const settingsIn = (view: View) => {
    const section = sectionOf(view, 'mem0');

    return {
      userDisplayName: hostField(view, 'userDisplayName')?.authored,
      memoryEnabled: section?.enabled,
      backend: section?.fields.find(field => field.name === 'backend')
        ?.authored,
    };
  };
  const memory = {namespace: 'plugins', id: 'mem0'};
  const unauthored = {configured: false};

  for (const [operation, after] of [
    [
      {kind: 'set', path: 'project02.userDisplayName', value: 'Robin'},
      {
        userDisplayName: {configured: true, value: 'Robin'},
        memoryEnabled: false,
        backend: unauthored,
      },
    ],
    [
      {kind: 'unset', path: 'project02.userDisplayName'},
      {userDisplayName: unauthored, memoryEnabled: false, backend: unauthored},
    ],
    [
      {kind: 'section_enabled', ...memory, enabled: true},
      {userDisplayName: unauthored, memoryEnabled: true, backend: unauthored},
    ],
    [
      {kind: 'section_field_set', ...memory, field: 'backend', value: 'server'},
      {
        userDisplayName: unauthored,
        memoryEnabled: true,
        backend: {configured: true, value: 'server'},
      },
    ],
    [
      {kind: 'section_field_unset', ...memory, field: 'backend'},
      {userDisplayName: unauthored, memoryEnabled: true, backend: unauthored},
    ],
  ] as const) {
    const before = await viewOf(wire, {scope: 'global'});
    const outcome = await wire.configChange({
      target: {scope: 'global'},
      expectedFingerprint: before.fingerprint,
      operation,
    });
    const view = await viewOf(wire, {scope: 'global'});

    expect(outcome, operation.kind).toEqual({
      status: 'applied',
      fingerprint: view.fingerprint,
    });
    expect(view.fingerprint, operation.kind).not.toBe(before.fingerprint);
    expect(settingsIn(view), operation.kind).toEqual(after);
  }
});

it('config.fingerprint-conflict: a change presenting a fingerprint from before another change is refused conflict and writes nothing', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const stale = await viewOf(wire, {scope: 'global'});

  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.userDisplayName', value: 'Robin'},
  );

  const written = homeDocument(home);

  expect(
    await wire.configChange({
      target: {scope: 'global'},
      expectedFingerprint: stale.fingerprint,
      operation: {kind: 'set', path: 'project02.userDisplayName', value: 'Sam'},
    }),
  ).toMatchObject({status: 'refused', reason: 'conflict'});
  expect(homeDocument(home)).toBe(written);
});

it('config.change-refusals: a value of the wrong type or outside its allowed values is refused invalid, naming the field, and nothing is written', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const written = homeDocument(home);

  for (const [field, operation] of [
    [
      'contextWindowTokens',
      {kind: 'set', path: 'project02.contextWindowTokens', value: 'many'},
    ],
    [
      'backend',
      {
        kind: 'section_field_set',
        namespace: 'plugins',
        id: 'mem0',
        field: 'backend',
        value: 'cloud',
      },
    ],
  ] as const) {
    expect(
      await changeConfig(wire, {scope: 'global'}, operation),
      field,
    ).toMatchObject({
      status: 'refused',
      reason: 'invalid',
      message: expect.stringContaining(field) as string,
    });
  }

  expect(homeDocument(home)).toBe(written);
});

it('config.write-failed: a change to a home that cannot be written answers failed, and the fingerprint stays what it was', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const before = await viewOf(wire, {scope: 'global'});

  chmod(home, 0o555);

  try {
    expect(
      await wire.configChange({
        target: {scope: 'global'},
        expectedFingerprint: before.fingerprint,
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Robin',
        },
      }),
    ).toEqual({status: 'failed', message: expect.any(String) as string});
  } finally {
    chmod(home, 0o755);
  }

  expect((await viewOf(wire, {scope: 'global'})).fingerprint).toBe(
    before.fingerprint,
  );
});

it("config.overlay-merge: what a character's screen saves is written into her overlay alone and overrides the home's values for her field by field, a plugin's switch and a key among them, while the home's values stand in for what she leaves unset", async () => {
  const model = await startModelServer();
  const switchedOff = {
    'config.json': configJson({project02: {enabled: false}}),
  };
  const home = createHome({
    'config.json': configJson({
      project02: {
        ...model.settings,
        userDisplayName: 'Robin',
        contextWindowTokens: 8192,
      },
      plugins: {'session-history': {enabled: false}},
    }),
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
    'character-data': {mira: switchedOff, zeta: switchedOff},
  });
  const wire = wireOf(await startDaemon(home));
  const zeta = {scope: 'character', characterId: 'zeta'} as const;
  const homeBefore = homeDocument(home);

  // Switched on last, each starts once, on all she was given.
  for (const [target, operation] of [
    [mira, {kind: 'set', path: 'project02.userDisplayName', value: 'Sam'}],
    [
      mira,
      {
        kind: 'section_enabled',
        namespace: 'plugins',
        id: 'session-history',
        enabled: true,
      },
    ],
    [zeta, {kind: 'set', path: 'project02.nvidiaApiKey', value: 'zeta-key'}],
    [mira, {kind: 'set', path: 'project02.enabled', value: true}],
    [zeta, {kind: 'set', path: 'project02.enabled', value: true}],
  ] as const) {
    await saveConfig(wire, target, operation);
  }

  expect(homeDocument(home)).toBe(homeBefore);

  const view = await viewOf(wire, mira);

  expect(hostField(view, 'userDisplayName')).toMatchObject({
    effectiveSource: 'character',
    effective: {value: 'Sam'},
  });
  expect(hostField(view, 'contextWindowTokens')).toMatchObject({
    authored: {configured: false},
    effectiveSource: 'global',
    effective: {value: 8192},
  });
  expect(sectionOf(view, 'session-history')).toMatchObject({
    enabled: true,
    enabledSource: 'character',
    activation: {status: 'active'},
  });
  expect(sectionOf(await viewOf(wire, zeta), 'session-history')).toMatchObject({
    enabled: false,
    enabledSource: 'global',
    activation: {status: 'disabled'},
  });

  for (const [characterId, key] of [
    ['mira', 'model-server-key'],
    ['zeta', 'zeta-key'],
  ] as const) {
    const say = await converse(wire, characterId);

    model.answer(reply('Hello.'));
    await say('Hello?', characterId);
    expect(model.requests.at(-1)?.authorization, characterId).toBe(
      `Bearer ${key}`,
    );
  }
});

it("config.applied-reload: a change saved while her reply runs is in effect from her next request, inside that reply, which goes on with what it did so far and lands on the same conversation, as does a line sent meanwhile; a key changed between her turns is her next turn's", async () => {
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
  const {conversationId} = await conversationOf(wire, 'mira');
  const held = model.hold();
  const inFlight = say('First?', 'in-flight');

  await held.arrived();
  await saveConfig(wire, mira, {
    kind: 'section_field_set',
    namespace: 'plugins',
    id: 'reply-style',
    field: 'tone',
    value: 'pirate',
  });

  const meanwhile = say('Second?', 'meanwhile');

  model.answer(reply('First.'), reply('Second.'));
  held.release(calling(['runtime_plugin_list', {}]));
  expect(await inFlight).toMatchObject({
    status: 'completed',
    conversationId,
    messages: [{}, {text: 'First.'}],
  });
  expect(await meanwhile).toMatchObject({
    status: 'completed',
    conversationId,
    messages: [{}, {text: 'Second.'}],
  });
  expect(model.requests.map(toneIn)).toEqual([
    expect.stringContaining('neutral tone'),
    expect.stringContaining('pirate tone'),
    expect.stringContaining('pirate tone'),
  ]);
  expect(toolResults(model.requests[1])).toMatchObject([
    {status: 'accepted', toolName: 'runtime.plugin.list'},
  ]);
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.nvidiaApiKey', value: 'rekeyed'},
  );
  model.answer(reply('Third.'));
  expect(await say('Third?', 'third')).toMatchObject({conversationId});
  expect(model.requests.at(-1)?.authorization).toBe('Bearer rekeyed');
});

it('config.enabled-switch: switching a character off through a change says so at once in health_changed and then stops her, her view stays readable with the switch the way back, and switching her on starts her again', async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');

  const events = await openEvents(daemon);
  const enabled = (value: boolean) =>
    saveConfig(wire, mira, {kind: 'set', path: 'project02.enabled', value});

  await enabled(false);
  await events.next(
    frameOf('health_changed', {
      health: {characters: [{id: 'mira', enabled: false, state: 'ready'}]},
    }),
  );
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'stopped'}),
  );
  expect(hostField(await viewOf(wire, mira), 'enabled')).toMatchObject({
    authored: {configured: true, value: false},
  });
  await enabled(true);
  await events.next(
    frameOf('health_changed', {
      health: {characters: [{id: 'mira', enabled: true, state: 'stopped'}]},
    }),
  );
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
});

it("config.secret-redaction: no secret appears in the home's view or a character's, only [redacted]: the model's key, a plugin's and the Telegram tokens", async () => {
  const secrets = [
    'nvapi-home-secret',
    'mem0-key-secret',
    '123456:management-secret',
    '987654:mira-secret',
  ];
  const home = createHome({
    'config.json': configJson({
      project02: {nvidiaApiKey: 'nvapi-home-secret'},
      plugins: {mem0: {config: {apiKey: 'mem0-key-secret'}}},
      connectors: {
        telegram: {config: {managementBotToken: '123456:management-secret'}},
      },
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: '987654:mira-secret'}}},
        }),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const homeView = await viewOf(wire, {scope: 'global'});
  const miraView = await viewOf(wire, mira);
  const sectionField = (view: View, id: string, name: string) =>
    sectionOf(view, id)?.fields.find(field => field.name === name);

  expect(hostField(homeView, 'nvidiaApiKey')).toMatchObject({
    authored: {value: '[redacted]'},
    effective: {value: '[redacted]'},
  });
  expect(sectionField(homeView, 'mem0', 'apiKey')).toMatchObject({
    authored: {value: '[redacted]'},
  });
  expect(
    sectionField(homeView, 'telegram', 'managementBotToken'),
  ).toMatchObject({authored: {value: '[redacted]'}});
  expect(sectionField(miraView, 'telegram', 'botToken')).toMatchObject({
    authored: {value: '[redacted]'},
  });

  for (const shown of [JSON.stringify(homeView), JSON.stringify(miraView)]) {
    for (const secret of secrets) {
      expect(shown).not.toContain(secret);
    }
  }
});

it('config.nvidia-base-url-rule: an NVIDIA base URL carrying credentials or a query is refused when saved, and neither the refusal nor the home repeats it', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const marker = 'never-repeated';
  const nvidiaBaseUrl = (value: string) => ({
    kind: 'set',
    path: 'project02.nvidiaBaseUrl',
    value,
  });

  await saveConfig(
    wire,
    {scope: 'global'},
    nvidiaBaseUrl('https://nim.example.test/v1'),
  );

  for (const value of [
    `https://user:${marker}@nim.example.test/v1`,
    `https://nim.example.test/v1?key=${marker}`,
  ]) {
    const refused = await changeConfig(
      wire,
      {scope: 'global'},
      nvidiaBaseUrl(value),
    );

    expect(refused, value).toMatchObject({
      status: 'refused',
      reason: 'invalid',
    });
    expect(JSON.stringify(refused), value).not.toContain(marker);
  }

  expect(homeDocument(home)).not.toContain(marker);
});
