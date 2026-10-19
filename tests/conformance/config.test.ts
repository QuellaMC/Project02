import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join, relative} from 'node:path';

import {expect, it} from 'vitest';

import {inspect, serve, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Events} from './harness/events.ts';
import {characterJson, chmod, configJson, createHome} from './harness/home.ts';
import {reply, startModelServer} from './harness/model-server.ts';
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
  readonly authored: {readonly configured: boolean; readonly value?: unknown};
  readonly effectiveSource: string;
  readonly effective: {readonly source: string; readonly value?: unknown};
};

type Section = {
  readonly namespace: string;
  readonly id: string;
  readonly enabled: boolean;
  readonly fields: readonly Field[];
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

function overlayPath(home: string, characterId: string): string {
  return join(home, 'character-data', characterId, 'config.json');
}

/** The stream's health_changed frames and the character's states, as they came. */
function timeline(events: Events, characterId: string): string[] {
  return events.frames.flatMap(frame => {
    if (frame.event === 'health_changed') {
      return ['health_changed'];
    }

    return frameOf('state_changed', {characterId})(frame)
      ? [(JSON.parse(frame.data ?? '') as {readonly state: string}).state]
      : [];
  });
}

it("config.view-global: the home's view lists the host fields in page order, each with what the home authored, what is in effect and where it comes from, every section the home may set, the document's diagnostics and a fingerprint", async () => {
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
    effective: {source: 'missing', secret: name === 'nvidiaApiKey'},
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
        authored: {configured: true, value: 'Robin'},
        effectiveSource: 'global',
        effective: {source: 'config', value: 'Robin'},
      },
      unset('roleModelProvider'),
      unset('nvidiaApiKey'),
      unset('nvidiaModel'),
      unset('nvidiaBaseUrl'),
      {
        name: 'contextWindowTokens',
        authored: {configured: false},
        effectiveSource: 'default',
        effective: {source: 'default', value: 32768},
      },
      unset('defaultMemoryProvider'),
      {
        name: 'enabled',
        authored: {configured: false},
        effectiveSource: 'default',
        effective: {source: 'default', value: true},
      },
    ],
  });
  expect(
    view.sections.map(section => `${section.namespace}.${section.id}`),
  ).toEqual([
    'plugins.character-memory',
    'plugins.demo-config',
    'plugins.mem0',
    'plugins.runtime.plugin',
    'plugins.session-history',
    'connectors.telegram',
  ]);
});

it("config.view-character: a character's view shows the home's values in effect but not authored there, her own overlay's values, a fingerprint of her own, and the plugin her package requires as active before she ever started", async () => {
  const home = createHome({
    'config.json': configJson({project02: {userDisplayName: 'Robin'}}),
    'character-data': {
      mira: {
        'config.json': configJson({
          project02: {enabled: false, contextWindowTokens: 4096},
        }),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const view = await viewOf(wire, mira);

  expect(await wire.health()).toMatchObject({
    characters: [{id: 'mira', state: 'not_started'}],
  });
  expect(hostField(view, 'userDisplayName')).toMatchObject({
    authored: {configured: false},
    effectiveSource: 'global',
    effective: {source: 'config', value: 'Robin'},
  });
  expect(hostField(view, 'contextWindowTokens')).toMatchObject({
    authored: {configured: true, value: 4096},
    effectiveSource: 'character',
    effective: {source: 'config', value: 4096},
  });
  expect(view.fingerprint).not.toBe(
    (await viewOf(wire, {scope: 'global'})).fingerprint,
  );
  expect(sectionOf(view, 'character-state')).toMatchObject({
    enabled: true,
    activation: {status: 'active'},
  });
});

it("config.view-refusals: a view of an unknown character or of a broken package is refused unknown_character, the broken one naming invalid_descriptor, and while the home's document cannot be loaded every view is refused config_unloadable instead of blank fields", async () => {
  const home = createHome({
    characters: {broken: {'project02.character.json': '{not json'}},
  });
  const wire = wireOf(await startDaemon(home));

  expect(
    await wire.configView({scope: 'character', characterId: 'nobody'}),
  ).toMatchObject({status: 'refused', reason: 'unknown_character'});
  expect(
    await wire.configView({scope: 'character', characterId: 'broken'}),
  ).toMatchObject({
    status: 'refused',
    reason: 'unknown_character',
    message: expect.stringContaining('invalid_descriptor') as string,
  });
  writeFileSync(join(home, 'config.json'), '{not json');

  for (const target of [{scope: 'global'}, mira] as const) {
    expect(await wire.configView(target), target.scope).toEqual({
      status: 'refused',
      reason: 'config_unloadable',
      message: expect.any(String) as string,
    });
  }
});

it('config.no-config-defaults: a home without config.json views with no diagnostics, each host field with a default showing it and the rest showing no value', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));

  rmSync(join(home, 'config.json'));

  const view = await wire.configView({scope: 'global'});

  expect(view).toMatchObject({status: 'ok', diagnostics: []});
  expect(
    (view as View).project02.map(field => [
      field.name,
      field.effective.source,
      field.effective.value,
    ]),
  ).toEqual([
    ['userDisplayName', 'default', 'You'],
    ['roleModelProvider', 'missing', undefined],
    ['nvidiaApiKey', 'missing', undefined],
    ['nvidiaModel', 'missing', undefined],
    ['nvidiaBaseUrl', 'missing', undefined],
    ['contextWindowTokens', 'default', 32768],
    ['defaultMemoryProvider', 'missing', undefined],
    ['enabled', 'default', true],
  ]);
});

it("config.effective-source-default: a declared default is in effect beneath both layers, and the home's value and then the character's override it", async () => {
  const wire = wireOf(await startDaemon(createHome()));
  const contextWindow = async () =>
    hostField(await viewOf(wire, mira), 'contextWindowTokens');

  expect(await contextWindow()).toMatchObject({
    effectiveSource: 'default',
    effective: {source: 'default', value: 32768},
  });
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.contextWindowTokens', value: 8192},
  );
  expect(await contextWindow()).toMatchObject({
    effectiveSource: 'global',
    effective: {value: 8192},
  });
  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.contextWindowTokens',
    value: 4096,
  });
  expect(await contextWindow()).toMatchObject({
    effectiveSource: 'character',
    effective: {value: 4096},
  });
});

it('config.change-ops: set, unset, section_enabled and a section field set and unset each answer applied with the new fingerprint, which the next view carries with the change in it', async () => {
  const wire = wireOf(await startDaemon(createHome()));
  const settingsIn = (view: View) => {
    const section = sectionOf(view, 'demo-config');

    return {
      userDisplayName: hostField(view, 'userDisplayName')?.authored,
      demoConfigEnabled: section?.enabled,
      tone: section?.fields.find(field => field.name === 'tone')?.authored,
    };
  };
  const demoConfig = {namespace: 'plugins', id: 'demo-config'};
  const unauthored = {configured: false};

  for (const [operation, after] of [
    [
      {kind: 'set', path: 'project02.userDisplayName', value: 'Robin'},
      {
        userDisplayName: {configured: true, value: 'Robin'},
        demoConfigEnabled: false,
        tone: unauthored,
      },
    ],
    [
      {kind: 'unset', path: 'project02.userDisplayName'},
      {userDisplayName: unauthored, demoConfigEnabled: false, tone: unauthored},
    ],
    [
      {kind: 'section_enabled', ...demoConfig, enabled: true},
      {userDisplayName: unauthored, demoConfigEnabled: true, tone: unauthored},
    ],
    [
      {kind: 'section_field_set', ...demoConfig, field: 'tone', value: 'warm'},
      {
        userDisplayName: unauthored,
        demoConfigEnabled: true,
        tone: {configured: true, value: 'warm'},
      },
    ],
    [
      {kind: 'section_field_unset', ...demoConfig, field: 'tone'},
      {userDisplayName: unauthored, demoConfigEnabled: true, tone: unauthored},
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

it('config.secret-fingerprint: the fingerprint changes when a secret is first set but not when its value is replaced, so two pages replacing one secret both succeed and the later value stands', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const unset = await viewOf(wire, {scope: 'global'});

  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.nvidiaApiKey', value: 'nvapi-first'},
  );

  const {fingerprint} = await viewOf(wire, {scope: 'global'});

  expect(fingerprint).not.toBe(unset.fingerprint);

  for (const value of ['nvapi-second', 'nvapi-third']) {
    expect(
      await wire.configChange({
        target: {scope: 'global'},
        expectedFingerprint: fingerprint,
        operation: {kind: 'set', path: 'project02.nvidiaApiKey', value},
      }),
      value,
    ).toEqual({status: 'applied', fingerprint});
  }

  expect(JSON.parse(homeDocument(home))).toMatchObject({
    project02: {nvidiaApiKey: 'nvapi-third'},
  });
});

it('config.change-refusals: a change is refused invalid for a value of the wrong type, one outside its allowed values, the store root, an undeclared field and an unknown section, and unknown_character for a character not installed, and none creates her data directory', async () => {
  const home = createHome({
    'config.json': configJson({project02: {enabled: false}}),
  });
  const wire = wireOf(await startDaemon(home));
  const demoConfig = {
    kind: 'section_field_set',
    namespace: 'plugins',
    id: 'demo-config',
  };

  for (const operation of [
    {kind: 'set', path: 'project02.contextWindowTokens', value: 'many'},
    {...demoConfig, field: 'tone', value: 'shouty'},
    {kind: 'set', path: 'project02.storeRoot', value: '/elsewhere'},
    {...demoConfig, field: 'volume', value: 11},
    {...demoConfig, id: 'nope', field: 'tone', value: 'warm'},
  ]) {
    expect(
      await changeConfig(wire, mira, operation),
      JSON.stringify(operation),
    ).toMatchObject({status: 'refused', reason: 'invalid'});
  }

  expect(
    await wire.configChange({
      target: {scope: 'character', characterId: 'nobody'},
      expectedFingerprint: (await viewOf(wire, mira)).fingerprint,
      operation: {kind: 'set', path: 'project02.enabled', value: true},
    }),
  ).toMatchObject({status: 'refused', reason: 'unknown_character'});

  const data = join(home, 'character-data');

  expect(existsSync(data) ? readdirSync(data) : []).toEqual([]);
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

it("config.scope-rules: the home's view leaves out what belongs to a character and a character's what belongs to the home, and a write of either on the other's target is refused invalid and changes no file", async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');

  const telegramFields = (view: View) =>
    sectionOf(view, 'telegram')?.fields.map(field => field.name);
  const homeView = await viewOf(wire, {scope: 'global'});
  const miraView = await viewOf(wire, mira);

  expect(sectionOf(homeView, 'character-state')).toBeUndefined();
  expect(sectionOf(miraView, 'character-state')).toBeDefined();
  expect(telegramFields(homeView)).toEqual([
    'managementBotToken',
    'mirror',
    'pairedUsers',
  ]);
  expect(telegramFields(miraView)).toEqual(['botToken', 'mirror']);

  const documents = [join(home, 'config.json'), overlayPath(home, 'mira')];
  const before = documents.map(document => readFileSync(document, 'utf8'));
  const telegram = {
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
  };

  for (const [target, operation] of [
    [
      {scope: 'global'},
      {
        kind: 'section_enabled',
        namespace: 'plugins',
        id: 'character-state',
        enabled: true,
      },
    ],
    [{scope: 'global'}, {...telegram, field: 'botToken', value: '987654:bot'}],
    [mira, {...telegram, field: 'managementBotToken', value: '123456:bot'}],
    [mira, {...telegram, field: 'pairedUsers', value: {}}],
  ] as const) {
    expect(
      await changeConfig(wire, target, operation),
      JSON.stringify(operation),
    ).toMatchObject({status: 'refused', reason: 'invalid'});
  }

  expect(documents.map(document => readFileSync(document, 'utf8'))).toEqual(
    before,
  );
});

it("config.scope-target-document: a change on a character's screen, a secret's among them, is written into her overlay alone, and the home's config.json is left as it was", async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const homeBefore = homeDocument(home);

  for (const operation of [
    {kind: 'set', path: 'project02.userDisplayName', value: 'Sam'},
    {kind: 'set', path: 'project02.nvidiaApiKey', value: 'nvapi-mira'},
    {
      kind: 'section_field_set',
      namespace: 'connectors',
      id: 'telegram',
      field: 'botToken',
      value: '987654:mira',
    },
  ]) {
    await saveConfig(wire, mira, operation);
  }

  expect(
    JSON.parse(readFileSync(overlayPath(home, 'mira'), 'utf8')),
  ).toMatchObject({
    project02: {userDisplayName: 'Sam', nvidiaApiKey: 'nvapi-mira'},
    connectors: {telegram: {config: {botToken: '987654:mira'}}},
  });
  expect(homeDocument(home)).toBe(homeBefore);
});

it("config.authored-outside-scope-warning: a character's plugin switched on in the home's document, a character's field set there and a home's field set in an overlay each warn runtime_config_authored_outside_scope at its path and never take effect", async () => {
  const home = createHome({
    'config.json': configJson({
      plugins: {'character-state': {enabled: true}},
      connectors: {telegram: {config: {botToken: '111111:home'}}},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {managementBotToken: '222222:mira'}}},
        }),
      },
    },
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
  const wire = wireOf(await startDaemon(home));
  const outsideScope = (path: string) =>
    expect.objectContaining({
      severity: 'warning',
      code: 'runtime_config_authored_outside_scope',
      path,
    }) as unknown;

  expect(await wire.configView({scope: 'global'})).toMatchObject({
    diagnostics: expect.arrayContaining([
      outsideScope('plugins.character-state.enabled'),
      outsideScope('connectors.telegram.config.botToken'),
    ]) as unknown[],
  });
  expect(await wire.configView(mira)).toMatchObject({
    diagnostics: expect.arrayContaining([
      outsideScope('connectors.telegram.config.managementBotToken'),
    ]) as unknown[],
  });
  expect(
    sectionOf(
      await viewOf(wire, {scope: 'character', characterId: 'zeta'}),
      'character-state',
    ),
  ).toMatchObject({enabled: false, activation: {status: 'disabled'}});

  const {characters} = (await wire.connectorConfig('telegram')) as {
    readonly characters: readonly {
      readonly characterId: string;
      readonly values: unknown;
    }[];
  };

  expect(
    characters.map(character => [character.characterId, character.values]),
  ).toEqual([
    ['mira', {mirror: true, pairedUsers: {}}],
    ['zeta', {mirror: true, pairedUsers: {}}],
  ]);
});

it("config.overlay-merge: a character's overlay overrides the home field by field: a host field, a plugin's switch, which can turn on what the home turned off, and its settings, and a secret, the home's standing in when she has none", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: {
        ...model.settings,
        userDisplayName: 'Robin',
        contextWindowTokens: 8192,
      },
      plugins: {
        'demo-config': {enabled: false, config: {tone: 'warm', signoff: '-R'}},
      },
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          project02: {userDisplayName: 'Sam'},
          plugins: {'demo-config': {enabled: true, config: {tone: 'formal'}}},
        }),
      },
      zeta: {
        'config.json': configJson({project02: {nvidiaApiKey: 'zeta-key'}}),
      },
    },
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
  const wire = wireOf(await startDaemon(home));
  const view = await viewOf(wire, mira);
  const demoConfig = sectionOf(view, 'demo-config');

  expect(hostField(view, 'userDisplayName')).toMatchObject({
    effectiveSource: 'character',
    effective: {value: 'Sam'},
  });
  expect(hostField(view, 'contextWindowTokens')).toMatchObject({
    effectiveSource: 'global',
    effective: {value: 8192},
  });
  expect(demoConfig).toMatchObject({
    enabled: true,
    enabledSource: 'character',
    activation: {status: 'active'},
  });
  expect(
    demoConfig?.fields
      .filter(field => ['tone', 'signoff'].includes(field.name))
      .map(field => [field.name, field.effectiveSource, field.effective.value]),
  ).toEqual([
    ['tone', 'character', 'formal'],
    ['signoff', 'global', '-R'],
  ]);

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

it('config.applied-reload: a change reloads a running character only when what she runs would differ, an effective value of hers or a re-keyed provider secret, not for a home value she overrides or a switched-off plugin, through reloading then ready; the turn in flight finishes first and one sent mid-reload waits and lands on the same conversation', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
    'character-data': {
      mira: {'config.json': configJson({project02: {userDisplayName: 'Sam'}})},
    },
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  for (const operation of [
    {kind: 'set', path: 'project02.userDisplayName', value: 'Robin'},
    {
      kind: 'section_field_set',
      namespace: 'plugins',
      id: 'demo-config',
      field: 'tone',
      value: 'warm',
    },
  ]) {
    await saveConfig(wire, {scope: 'global'}, operation);
  }

  const held = model.hold();
  const inFlight = say('First?', 'in-flight');

  await held.arrived();
  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.contextWindowTokens',
    value: 4096,
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'reloading'}),
  );

  const midReload = say('Second?', 'mid-reload');

  // A round trip the daemon answers after the request left: the request
  // is in by then in every run seen, and the turn lands the same either way.
  await wire.health();
  model.answer(reply('Second.'));
  held.release(reply('First.'));
  await events.next(
    frameOf('turn_completed', {
      clientMessageId: 'in-flight',
      status: 'completed',
    }),
  );
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  await events.next(
    frameOf('turn_completed', {
      clientMessageId: 'mid-reload',
      status: 'completed',
    }),
  );
  expect(await inFlight).toMatchObject({messages: [{}, {text: 'First.'}]});
  expect(await midReload).toMatchObject({
    status: 'completed',
    conversationId,
    messages: [{}, {text: 'Second.'}],
  });
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.nvidiaApiKey', value: 'rekeyed'},
  );
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  // Passes never overlap: a reload either of the first two changes began
  // would be on the stream before the third change's health_changed.
  expect(timeline(events, 'mira')).toEqual([
    'health_changed',
    'health_changed',
    'health_changed',
    'reloading',
    'ready',
    'health_changed',
    'reloading',
    'ready',
  ]);
});

it('config.reload-failure: a reload that cannot assemble leaves the character failed with the diagnostic, tried again by nothing until the next change, which starts her once the overlay is fixed', async () => {
  const home = createHome();
  const daemon = await startDaemon(home, {
    ...fixedReplies,
    PROJECT02_TEST_DURATIONS: 'heartbeat=1000',
  });
  const wire = wireOf(daemon);

  await wire.start('mira');

  const events = await openEvents(daemon);
  const overlay = readFileSync(overlayPath(home, 'mira'), 'utf8');
  const mirror = (value: boolean) =>
    saveConfig(
      wire,
      {scope: 'global'},
      {
        kind: 'section_field_set',
        namespace: 'connectors',
        id: 'telegram',
        field: 'mirror',
        value,
      },
    );

  writeFileSync(
    overlayPath(home, 'mira'),
    JSON.stringify({
      ...(JSON.parse(overlay) as object),
      project02: {contextWindowTokens: -5},
    }),
  );
  await mirror(false);

  const failed = await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'failed'}),
  );

  expect(JSON.parse(failed.data ?? '')).toMatchObject({
    message: expect.stringContaining('contextWindowTokens') as string,
  });
  expect(await wire.health()).toMatchObject({
    characters: [
      {
        id: 'mira',
        state: 'failed',
        diagnostic: expect.stringContaining('contextWindowTokens') as string,
      },
    ],
  });

  // Tried again by nothing: two heartbeats on, she is failed as before.
  const failedSoFar = timeline(events, 'mira');

  for (let beat = 0; beat < 2; beat += 1) {
    await events.next(frame => frame.comment === 'ping');
  }

  expect(timeline(events, 'mira')).toEqual(failedSoFar);
  expect(await wire.health()).toMatchObject({
    characters: [{id: 'mira', state: 'failed'}],
  });
  writeFileSync(overlayPath(home, 'mira'), overlay);
  await mirror(true);
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  expect(timeline(events, 'mira')).toEqual([
    'health_changed',
    'reloading',
    'failed',
    'health_changed',
    'starting',
    'ready',
  ]);
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

it('config.document-format: what the daemon saves is a project02.config.v2 document holding the host fields under project02 and each section under plugins or connectors', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));

  for (const operation of [
    {kind: 'set', path: 'project02.userDisplayName', value: 'Robin'},
    {
      kind: 'section_field_set',
      namespace: 'plugins',
      id: 'demo-config',
      field: 'tone',
      value: 'warm',
    },
    {
      kind: 'section_field_set',
      namespace: 'connectors',
      id: 'telegram',
      field: 'mirror',
      value: false,
    },
  ]) {
    await saveConfig(wire, {scope: 'global'}, operation);
  }

  expect(JSON.parse(homeDocument(home))).toEqual({
    version: 'project02.config.v2',
    project02: {userDisplayName: 'Robin'},
    plugins: {'demo-config': {config: {tone: 'warm'}}},
    connectors: {telegram: {config: {mirror: false}}},
  });
});

it("config.unloadable: while the home's config.json is malformed a change on a character's screen is refused, saying the home's document failed to load, and creates no overlay", async () => {
  const home = createHome({
    'config.json': configJson({project02: {enabled: false}}),
  });
  const wire = wireOf(await startDaemon(home));
  const {fingerprint} = await viewOf(wire, mira);

  writeFileSync(join(home, 'config.json'), '{not json');
  expect(
    await wire.configChange({
      target: mira,
      expectedFingerprint: fingerprint,
      operation: {kind: 'set', path: 'project02.userDisplayName', value: 'Sam'},
    }),
  ).toMatchObject({
    status: 'refused',
    message: expect.stringContaining('failed to load') as string,
  });
  expect(existsSync(overlayPath(home, 'mira'))).toBe(false);
});

it('config.symlinked-config-file: a home whose config.json is a symlink is refused by serve and by inspect, each exiting 1, with nothing written in the home or to the file the link names', async () => {
  const home = createHome();
  const first = await startDaemon(home);

  first.signal('SIGINT');
  await first.exit();
  rmSync(join(home, 'config.json'));
  symlinkSync(
    join(
      createHome({
        'config.json': configJson({project02: {userDisplayName: 'Robin'}}),
      }),
      'config.json',
    ),
    join(home, 'config.json'),
  );

  const tree = () =>
    readdirSync(home, {recursive: true, withFileTypes: true}).map(entry => {
      const path = join(entry.parentPath, entry.name);

      return {
        path: relative(home, path),
        link: entry.isSymbolicLink(),
        ...(entry.isDirectory() ? {} : {bytes: readFileSync(path, 'utf8')}),
      };
    });
  const before = tree();

  for (const run of [
    serve(['--store', home]),
    inspect(['--store', home, '--sessions']),
  ]) {
    expect(await run.exit()).toBe(1);
  }

  expect(tree()).toEqual(before);
});

it("config.retired-shapes-refused: a config.json still carrying project02.storeRoot, or the NVIDIA key written as an environment reference, is refused as invalid at that path, in health's diagnostics and by every view, and neither takes effect: the home stays where it is and no character starts on a key from the environment", async () => {
  const home = createHome();
  const elsewhere = createHome();
  const wire = wireOf(
    await startDaemon(home, {NVIDIA_API_KEY: 'nvapi-from-environment'}),
  );

  for (const [project02, field, code] of [
    [
      {storeRoot: elsewhere},
      'storeRoot',
      'runtime_config_unknown_project02_field',
    ],
    [
      {roleModelProvider: 'nvidia', nvidiaApiKey: {$env: 'NVIDIA_API_KEY'}},
      'nvidiaApiKey',
      'runtime_config_secret_value_invalid',
    ],
  ] as const) {
    writeFileSync(join(home, 'config.json'), configJson({project02}));
    expect(await wire.health(), field).toMatchObject({
      homeRoot: home,
      config: {
        diagnostics: [{severity: 'error', code, path: `project02.${field}`}],
      },
    });

    for (const target of [{scope: 'global'}, mira] as const) {
      expect(await wire.configView(target), field).toMatchObject({
        status: 'refused',
        reason: 'config_unloadable',
      });
    }

    expect(await wire.start('mira'), field).toMatchObject({
      character: {
        state: 'failed',
        diagnostic: expect.stringContaining(field) as string,
      },
    });
  }

  expect(readdirSync(elsewhere)).toEqual([]);
});

it('config.overlay-unloadable: an overlay that is malformed, unreadable or invalid stops its character from starting with its diagnostic and has nothing written for her, and an edit sent from her screen as it was before is refused and leaves the overlay as it is', async () => {
  const broken = [
    ['nova', '{not json', 'not valid JSON'],
    ['vega', configJson({}), 'could not be read'],
    [
      'lyra',
      configJson({project02: {contextWindowTokens: -5}}),
      'contextWindowTokens',
    ],
  ] as const;
  const home = createHome({
    'config.json': configJson({project02: {enabled: false}}),
    characters: Object.fromEntries(
      broken.map(([id]) => [
        id,
        {'project02.character.json': characterJson(id, id)},
      ]),
    ),
    'character-data': Object.fromEntries(
      broken.map(([id]) => [id, {'config.json': configJson({})}]),
    ),
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const screens = await Promise.all(
    broken.map(([id]) => viewOf(wire, {scope: 'character', characterId: id})),
  );

  for (const [id, overlay] of broken) {
    writeFileSync(overlayPath(home, id), overlay);
  }

  chmod(overlayPath(home, 'vega'), 0o000);

  try {
    for (const [index, [id]] of broken.entries()) {
      expect(
        await wire.configChange({
          target: {scope: 'character', characterId: id},
          expectedFingerprint: screens[index]?.fingerprint,
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Sam',
          },
        }),
        id,
      ).toMatchObject({status: 'refused'});
    }

    await saveConfig(
      wire,
      {scope: 'global'},
      {kind: 'unset', path: 'project02.enabled'},
    );

    for (const [id, , diagnostic] of broken) {
      expect(await wire.start(id), id).toMatchObject({
        character: {
          state: 'failed',
          diagnostic: expect.stringContaining(diagnostic) as string,
        },
      });
      expect(readdirSync(join(home, 'character-data', id)), id).toEqual([
        'config.json',
      ]);
    }
  } finally {
    chmod(overlayPath(home, 'vega'), 0o644);
  }

  for (const [id, overlay] of broken) {
    expect(readFileSync(overlayPath(home, id), 'utf8'), id).toBe(overlay);
  }
});

it('config.secret-redaction: no secret appears in a view, in inspect or in a diagnostic, only [redacted], whether declared secret or held in an object under a credential-looking name: an API key, a token, an access_token deeper down or a dotted name', async () => {
  const secrets = [
    'nvapi-home-secret',
    'demo-key-secret',
    '123456:management-secret',
    '111111:misplaced-secret',
    '987654:mira-secret',
    'paired-key-secret',
    'paired-token-secret',
    'paired-access-secret',
    'paired-dotted-secret',
  ];
  const home = createHome({
    'config.json': configJson({
      project02: {nvidiaApiKey: 'nvapi-home-secret'},
      plugins: {'demo-config': {config: {apiKey: 'demo-key-secret'}}},
      connectors: {
        telegram: {
          config: {
            managementBotToken: '123456:management-secret',
            botToken: '111111:misplaced-secret',
            pairedUsers: {
              '381940562': 'Alice (@alice)',
              apiKey: 'paired-key-secret',
              token: 'paired-token-secret',
              nested: {access_token: 'paired-access-secret', label: 'kept'},
              'api.key': 'paired-dotted-secret',
            },
          },
        },
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
  const pairedUsers = {
    '381940562': 'Alice (@alice)',
    apiKey: '[redacted]',
    token: '[redacted]',
    nested: {access_token: '[redacted]', label: 'kept'},
    'api.key': '[redacted]',
  };
  const wire = wireOf(await startDaemon(home));
  const homeView = await viewOf(wire, {scope: 'global'});
  const miraView = await viewOf(wire, mira);
  const report = inspect(['--store', home, '--sessions']);
  const sectionField = (view: View, id: string, name: string) =>
    sectionOf(view, id)?.fields.find(field => field.name === name);

  expect(homeView).toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({path: 'connectors.telegram.config.botToken'}),
    ]) as unknown[],
  });
  expect(hostField(homeView, 'nvidiaApiKey')).toMatchObject({
    authored: {value: '[redacted]'},
    effective: {value: '[redacted]'},
  });
  expect(sectionField(homeView, 'demo-config', 'apiKey')).toMatchObject({
    authored: {value: '[redacted]'},
  });
  expect(
    sectionField(homeView, 'telegram', 'managementBotToken'),
  ).toMatchObject({authored: {value: '[redacted]'}});
  expect(
    sectionField(homeView, 'telegram', 'pairedUsers')?.authored.value,
  ).toEqual(pairedUsers);
  expect(sectionField(miraView, 'telegram', 'botToken')).toMatchObject({
    authored: {value: '[redacted]'},
  });
  expect(await report.exit()).toBe(0);
  expect(JSON.parse(report.stdout())).toMatchObject({
    runtimeConfig: {project02: {nvidiaApiKey: '[redacted]'}},
    connectors: [
      {
        config: {
          managementBotToken: {value: '[redacted]'},
          pairedUsers: {value: pairedUsers},
        },
      },
    ],
  });

  for (const shown of [
    JSON.stringify(homeView),
    JSON.stringify(miraView),
    report.stdout(),
  ]) {
    for (const secret of secrets) {
      expect(shown).not.toContain(secret);
    }
  }
});

it('config.secret-values: a secret is kept as it was typed and handed to its connector as written; a blank one is refused when saved, and a blank or non-string one written by hand is runtime_config_secret_value_invalid at its path', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const typed = '  123456:as typed  ';
  const managementBotToken = (value: unknown) => ({
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
    field: 'managementBotToken',
    value,
  });

  await saveConfig(wire, {scope: 'global'}, managementBotToken(typed));
  expect(JSON.parse(homeDocument(home))).toMatchObject({
    connectors: {telegram: {config: {managementBotToken: typed}}},
  });
  expect(await wire.connectorConfig('telegram')).toMatchObject({
    home: {values: {managementBotToken: typed}},
  });

  for (const blank of ['', '   ']) {
    expect(
      await changeConfig(wire, {scope: 'global'}, managementBotToken(blank)),
      JSON.stringify(blank),
    ).toMatchObject({status: 'refused', reason: 'invalid'});
  }

  for (const value of ['', '   ', 42]) {
    writeFileSync(
      join(home, 'config.json'),
      configJson({
        connectors: {telegram: {config: {managementBotToken: value}}},
      }),
    );
    expect(
      await wire.configView({scope: 'global'}),
      JSON.stringify(value),
    ).toMatchObject({
      diagnostics: [
        {
          severity: 'error',
          code: 'runtime_config_secret_value_invalid',
          path: 'connectors.telegram.config.managementBotToken',
        },
      ],
    });
  }
});

it('config.user-display-name-bounds: the name a person goes by is used trimmed and may run to 128 characters on one line; a longer, multi-line or blank one is refused when saved and is an error at its path when written by hand', async () => {
  const home = createHome({
    'config.json': configJson({project02: {userDisplayName: '  Robin  '}}),
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const userDisplayName = (value: string) => ({
    kind: 'set',
    path: 'project02.userDisplayName',
    value,
  });

  expect(await wire.health()).toMatchObject({config: {diagnostics: []}});

  const say = await converse(wire, 'mira');

  expect(await say('Hello.', 'hello')).toMatchObject({
    messages: [{speakerName: 'Robin'}, {}],
  });
  await saveConfig(wire, {scope: 'global'}, userDisplayName('x'.repeat(128)));

  for (const value of ['x'.repeat(129), 'Two\nlines', '   ']) {
    expect(
      await changeConfig(wire, {scope: 'global'}, userDisplayName(value)),
      JSON.stringify(value),
    ).toMatchObject({status: 'refused', reason: 'invalid'});
  }

  for (const value of ['x'.repeat(129), 'Two\nlines', '   ']) {
    writeFileSync(
      join(home, 'config.json'),
      configJson({project02: {userDisplayName: value}}),
    );
    expect(await wire.health(), JSON.stringify(value)).toMatchObject({
      config: {
        diagnostics: [{severity: 'error', path: 'project02.userDisplayName'}],
      },
    });
  }
});

it('config.context-window-validation: the context window takes a positive whole number of tokens, and 0, 1.5 or a string is refused invalid', async () => {
  const wire = wireOf(await startDaemon(createHome()));
  const contextWindowTokens = (value: unknown) => ({
    kind: 'set',
    path: 'project02.contextWindowTokens',
    value,
  });

  for (const value of [0, 1.5, '4096']) {
    expect(
      await changeConfig(wire, {scope: 'global'}, contextWindowTokens(value)),
      JSON.stringify(value),
    ).toMatchObject({status: 'refused', reason: 'invalid'});
  }

  await saveConfig(wire, {scope: 'global'}, contextWindowTokens(4096));
});

it('config.nvidia-base-url-rule: the NVIDIA base URL takes only an absolute http or https address without credentials, a query or a fragment; anything else is refused invalid when saved and is runtime_config_nvidia_base_url_invalid at its path when written by hand, and neither repeats the address', async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home));
  const marker = 'never-repeated';
  const nvidiaBaseUrl = (value: string) => ({
    kind: 'set',
    path: 'project02.nvidiaBaseUrl',
    value,
  });

  for (const value of [
    'http://127.0.0.1:1234/v1',
    'https://nim.example.test/v1',
  ]) {
    await saveConfig(wire, {scope: 'global'}, nvidiaBaseUrl(value));
  }

  for (const value of [
    `ftp://${marker}.example.test/v1`,
    `${marker}.example.test/v1`,
    `https://user:${marker}@nim.example.test/v1`,
    `https://nim.example.test/v1?key=${marker}`,
    `https://nim.example.test/v1#${marker}`,
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
    writeFileSync(
      join(home, 'config.json'),
      configJson({project02: {nvidiaBaseUrl: value}}),
    );

    const health = await wire.health();

    expect(health, value).toMatchObject({
      config: {
        diagnostics: [
          {
            code: 'runtime_config_nvidia_base_url_invalid',
            path: 'project02.nvidiaBaseUrl',
          },
        ],
      },
    });
    expect(JSON.stringify(health), value).not.toContain(marker);
    writeFileSync(join(home, 'config.json'), configJson({}));
  }
});
