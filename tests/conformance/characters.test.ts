import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {reply, startModelServer} from './harness/model-server.ts';
import {converse, saveConfig, wireOf} from './harness/wire.ts';

type Health = {
  readonly characters: readonly {readonly id: string}[];
  readonly packages: {
    readonly diagnostics: readonly {
      readonly characterId: string;
      readonly message: string;
      readonly path: string;
    }[];
  };
};

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

function descriptor(home: string, id: string): string {
  return join(home, 'characters', id, 'project02.character.json');
}

function characterData(home: string, id: string): string {
  return join(home, 'character-data', id);
}

function overlayOf(home: string, id: string): string {
  return readFileSync(join(characterData(home, id), 'config.json'), 'utf8');
}

it('characters.package-discovery: the bundled Mira is always there, packages dropped into the home are listed beside her in id order, and loose files are ignored', async () => {
  const wire = wireOf(
    await startDaemon(
      createHome({
        characters: {
          zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
          alpha: {'project02.character.json': characterJson('alpha', 'Alpha')},
          'notes.txt': 'Not a package.',
        },
      }),
    ),
  );

  expect(await wire.health()).toMatchObject({
    packages: {diagnostics: []},
    characters: [
      {id: 'alpha', displayName: 'Alpha'},
      {id: 'mira', displayName: 'Mira'},
      {id: 'zeta', displayName: 'Zeta'},
    ],
  });
});

it('characters.broken-package-diagnostic: a broken package is listed with a diagnostic naming its code or field and its path, and starting it is refused unknown_character with that diagnostic', async () => {
  const home = createHome({
    characters: {
      malformed: {'project02.character.json': '{not json'},
      nameless: {'project02.character.json': characterJson('nameless', '')},
      misfiled: {
        'project02.character.json': characterJson('elsewhere', 'Elsewhere'),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const {diagnostics} = ((await wire.health()) as Health).packages;

  expect(diagnostics).toHaveLength(3);
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'invalid_descriptor',
        path: descriptor(home, 'malformed'),
      }),
      expect.objectContaining({
        code: 'invalid_identity',
        message: expect.stringContaining('identity.displayName') as string,
        path: descriptor(home, 'nameless'),
      }),
      expect.objectContaining({
        code: 'package_id_mismatch',
        path: descriptor(home, 'misfiled'),
      }),
    ]),
  );

  for (const diagnostic of diagnostics) {
    const started = (await wire.start(diagnostic.characterId)) as {
      readonly message: string;
    };

    expect(started).toMatchObject({
      status: 'refused',
      reason: 'unknown_character',
    });
    expect(started.message).toContain(diagnostic.message);
    expect(started.message).toContain(diagnostic.path);
  }
});

it('characters.duplicate-id: an id defined in two places, or two ids differing only by case, is duplicate_character_id for both, telling the user to remove or rename one', async () => {
  for (const id of ['mira', 'Mira']) {
    const home = createHome({
      characters: {
        [id]: {'project02.character.json': characterJson(id, 'Mira Two')},
      },
    });
    const health = (await wireOf(await startDaemon(home)).health()) as Health;
    const duplicate = {
      code: 'duplicate_character_id',
      message: expect.stringContaining('remove or rename one') as string,
    };

    expect(health.characters, id).toEqual([]);
    expect(health.packages.diagnostics, id).toHaveLength(2);
    expect(health.packages.diagnostics, id).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ...duplicate,
          provenance: 'bundled',
          characterId: 'mira',
        }),
        expect.objectContaining({
          ...duplicate,
          provenance: 'operator',
          characterId: id,
          path: descriptor(home, id),
        }),
      ]),
    );
  }
});

it('characters.package-discovery-symlinks: a characters directory that is a link still lists its packages, and a package directory that is a link is refused', async () => {
  const elsewhere = createHome({
    linked: {'project02.character.json': characterJson('linked', 'Linked')},
  });
  const shelf = createHome({
    zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
  });
  const home = createHome();

  symlinkSync(join(elsewhere, 'linked'), join(shelf, 'linked'));
  symlinkSync(shelf, join(home, 'characters'));
  expect(await wireOf(await startDaemon(home)).health()).toMatchObject({
    characters: [{id: 'mira'}, {id: 'zeta'}],
    packages: {
      diagnostics: [
        {
          code: 'invalid_package_directory',
          path: join(home, 'characters', 'linked'),
        },
      ],
    },
  });
});

it('characters.disabled-not-started: a character switched off in config does not start, failing with a diagnostic that says so, and gets no data directory', async () => {
  const home = createHome({
    'config.json': configJson({project02: {enabled: false}}),
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  expect(await wire.start('mira')).toMatchObject({
    character: {
      enabled: false,
      state: 'failed',
      diagnostic: expect.stringContaining('disabled') as string,
    },
  });
  expect(existsSync(characterData(home, 'mira'))).toBe(false);
});

it('characters.package-removed-while-running: a character whose package goes while she runs is stopped by the next reconcile, then refused unknown_character', async () => {
  const home = createHome({
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);

  expect(await wire.start('zeta')).toMatchObject({character: {state: 'ready'}});

  const events = await openEvents(daemon);

  rmSync(join(home, 'characters', 'zeta'), {recursive: true});
  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'section_field_set',
      namespace: 'connectors',
      id: 'telegram',
      field: 'mirror',
      value: false,
    },
  );
  await events.next(
    frameOf('state_changed', {characterId: 'zeta', state: 'stopped'}),
  );
  expect(await wire.open('zeta')).toMatchObject({
    status: 'refused',
    reason: 'unknown_character',
  });
});

it("characters.persona-prompt: the persona's sections, a blank line apart, then the runtime's words naming the person, are the system message the model receives, and each round records the character's id, version and persona fingerprint", async () => {
  const persona = ['First paragraph.', 'Second paragraph.'];
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          persona: {system: persona},
          meta: {version: '2.3.4'},
        }),
      },
    },
  });
  const say = await converse(wireOf(await startDaemon(home)), 'nova');

  model.answer(reply('Hi, Sam.'));
  await say('Hello.', 'hello');

  const [system] = (
    model.requests[0]?.body as {
      readonly messages: readonly {
        readonly role: string;
        readonly content: string;
      }[];
    }
  ).messages;
  const sections = `${persona.join('\n\n')}\n\n`;

  expect(system?.role).toBe('system');
  expect(system?.content.slice(0, sections.length)).toBe(sections);
  expect(system?.content.slice(sections.length)).toContain('Sam');

  const sessions = join(characterData(home, 'nova'), 'sessions');
  const rounds = readdirSync(sessions)
    .flatMap(session =>
      readFileSync(join(sessions, session, 'raw-events.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    )
    .map(
      line =>
        JSON.parse(line) as {
          readonly kind: string;
          readonly roleModelIOSnapshot?: {readonly characterRef?: unknown};
        },
    )
    .filter(event => event.kind === 'role_model_round');

  expect(rounds.map(round => round.roleModelIOSnapshot?.characterRef)).toEqual([
    {
      id: 'nova',
      version: '2.3.4',
      personaFingerprint: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ) as string,
    },
  ]);
});

it('characters.display-name: a display name of two lines, or with a space at its end, makes the package unusable before anything is written for it', async () => {
  const home = createHome({
    characters: {
      twolines: {
        'project02.character.json': characterJson(
          'twolines',
          'Line one\nLine two',
        ),
      },
      spaced: {'project02.character.json': characterJson('spaced', 'Spaced ')},
    },
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const {diagnostics} = ((await wire.health()) as Health).packages;
  const unusable = {
    code: 'invalid_identity',
    message: expect.stringContaining('identity.displayName') as string,
  };

  expect(diagnostics).toHaveLength(2);
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ...unusable,
        path: descriptor(home, 'twolines'),
      }),
      expect.objectContaining({...unusable, path: descriptor(home, 'spaced')}),
    ]),
  );

  for (const id of ['twolines', 'spaced']) {
    expect(await wire.start(id), id).toMatchObject({
      status: 'refused',
      reason: 'unknown_character',
    });
    expect(existsSync(characterData(home, id)), id).toBe(false);
  }
});

it('characters.display-name-rename: a character renamed under the same id keeps her conversation and its history under the names it was written with', async () => {
  const home = createHome({
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
  });
  const first = await startDaemon(home, fixedReplies);
  const say = await converse(wireOf(first), 'nova');
  const {conversationId} = (await say('Hello.', 'hello')) as {
    readonly conversationId: string;
  };

  first.signal('SIGINT');
  await first.exit();
  writeFileSync(descriptor(home, 'nova'), characterJson('nova', 'Nova Prime'));

  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('nova');
  expect(await wire.health()).toMatchObject({
    characters: [{id: 'mira'}, {id: 'nova', displayName: 'Nova Prime'}],
  });
  expect(await wire.open('nova')).toMatchObject({conversationId});
  expect(await wire.history(conversationId)).toMatchObject({
    messages: [
      {role: 'user', text: 'Hello.'},
      {role: 'character', speakerName: 'Nova'},
    ],
  });
});

it('characters.required-plugins: a required plugin is switched on in her overlay above a home that switched it off, one missing or switched off in her overlay fails her, and a missing recommended one only warns', async () => {
  const home = createHome({
    'config.json': configJson({plugins: {'demo-config': {enabled: false}}}),
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          plugins: {required: ['demo-config']},
        }),
      },
      ghost: {
        'project02.character.json': characterJson('ghost', 'Ghost', {
          plugins: {required: ['not-installed']},
        }),
      },
      vega: {
        'project02.character.json': characterJson('vega', 'Vega', {
          plugins: {required: ['demo-config']},
        }),
      },
      lyra: {
        'project02.character.json': characterJson('lyra', 'Lyra', {
          plugins: {recommended: ['not-installed']},
        }),
      },
    },
    'character-data': {
      vega: {
        'config.json': configJson({
          plugins: {'demo-config': {enabled: false}},
        }),
      },
    },
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  expect(await wire.start('nova')).toMatchObject({character: {state: 'ready'}});
  expect(JSON.parse(overlayOf(home, 'nova'))).toMatchObject({
    plugins: {'demo-config': {enabled: true}},
  });

  for (const [id, plugin] of [
    ['ghost', 'not-installed'],
    ['vega', 'demo-config'],
  ] as const) {
    expect(await wire.start(id), id).toMatchObject({
      character: {
        state: 'failed',
        diagnostic: expect.stringContaining(`"${plugin}"`) as string,
      },
    });
  }

  expect(await wire.start('lyra')).toMatchObject({character: {state: 'ready'}});
  expect(
    await wire.configView({scope: 'character', characterId: 'lyra'}),
  ).toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        code: 'character_recommended_plugin_missing',
      }),
    ]) as unknown[],
  });
});

it('characters.package-version-upgrade: a version bump fills only the fields and switches her overlay lacks and records the version, while the same version changes nothing', async () => {
  const home = createHome({
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          plugins: {config: {'demo-config': {tone: 'warm'}}},
        }),
      },
    },
  });
  const restart = async (running: Daemon): Promise<Daemon> => {
    running.signal('SIGINT');
    await running.exit();

    const next = await startDaemon(home, fixedReplies);

    await wireOf(next).start('nova');

    return next;
  };
  const first = await startDaemon(home, fixedReplies);
  const wire = wireOf(first);

  await wire.start('nova');
  await saveConfig(
    wire,
    {scope: 'character', characterId: 'nova'},
    {
      kind: 'section_field_set',
      namespace: 'plugins',
      id: 'demo-config',
      field: 'tone',
      value: 'playful',
    },
  );

  const edited = overlayOf(home, 'nova');

  writeFileSync(
    descriptor(home, 'nova'),
    characterJson('nova', 'Nova', {
      plugins: {config: {'demo-config': {tone: 'formal', signoff: 'Same.'}}},
    }),
  );

  const second = await restart(first);

  expect(overlayOf(home, 'nova')).toBe(edited);

  writeFileSync(
    descriptor(home, 'nova'),
    characterJson('nova', 'Nova', {
      meta: {version: '2.0.0'},
      plugins: {
        recommended: ['demo-config'],
        config: {'demo-config': {tone: 'formal', signoff: 'Upgraded.'}},
      },
    }),
  );
  await restart(second);
  expect(JSON.parse(overlayOf(home, 'nova'))).toEqual({
    version: 'project02.config.v2',
    plugins: {
      'demo-config': {
        enabled: true,
        config: {tone: 'playful', signoff: 'Upgraded.'},
      },
    },
  });
  expect(
    JSON.parse(
      readFileSync(join(characterData(home, 'nova'), 'schema.json'), 'utf8'),
    ),
  ).toMatchObject({materializedCharacterPackageVersion: '2.0.0'});
});

it('characters.package-secret-refused: a package shipping a credential for a secret field is invalid and never materializes', async () => {
  const home = createHome({
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          plugins: {config: {'demo-config': {apiKey: 'sk-shipped'}}},
        }),
      },
    },
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  expect(await wire.start('nova')).toMatchObject({
    character: {
      state: 'failed',
      diagnostic: expect.stringContaining(
        'plugins.demo-config.config.apiKey',
      ) as string,
    },
  });
  expect(existsSync(characterData(home, 'nova'))).toBe(false);
});

it('characters.package-plugin-config-invalid: a package plugin setting of the wrong type is character_package_plugin_config_invalid and creates no state', async () => {
  const home = createHome({
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          plugins: {config: {'demo-config': {tone: 42}}},
        }),
      },
    },
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  expect(await wire.start('nova')).toMatchObject({
    character: {state: 'failed'},
  });
  expect(
    await wire.configView({scope: 'character', characterId: 'nova'}),
  ).toMatchObject({
    diagnostics: [
      {severity: 'error', code: 'character_package_plugin_config_invalid'},
    ],
  });
  expect(existsSync(characterData(home, 'nova'))).toBe(false);
});

it('characters.no-state-on-invalid-config: with an invalid config.json no character state is created, neither character-data nor schema.json', async () => {
  const home = createHome({
    'config.json': configJson({unknownField: true}),
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  expect(await wire.start('mira')).toMatchObject({
    character: {state: 'failed'},
  });
  expect(readdirSync(home)).not.toContain('character-data');
  expect(readdirSync(home)).not.toContain('schema.json');
});
