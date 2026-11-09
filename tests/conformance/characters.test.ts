import {readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {saveConfig, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

function descriptor(home: string, id: string): string {
  return join(home, 'characters', id, 'project02.character.json');
}

function overlayOf(home: string, id: string): unknown {
  return JSON.parse(
    readFileSync(join(home, 'character-data', id, 'config.json'), 'utf8'),
  );
}

it('characters.broken-package-diagnostic: a broken package is reported at its path, saying what is wrong with it, while the other characters are served', async () => {
  const home = createHome({
    characters: {broken: {'project02.character.json': '{not json'}},
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  expect(await wire.start('mira')).toMatchObject({
    character: {state: 'ready'},
  });
  expect(await wire.health()).toMatchObject({
    characters: [{id: 'mira'}],
    packages: {
      diagnostics: [
        {
          path: descriptor(home, 'broken'),
          message: expect.stringContaining('valid JSON') as string,
        },
      ],
    },
  });
});

it('characters.package-discovery-symlinks: a package that is a link, its folder or its descriptor, is never read: it is reported at its own path and cannot be started, nothing of what the link names reaches the daemon, and the real package beside it is served', async () => {
  const outside = createHome({
    linked: {
      'project02.character.json': characterJson('linked', 'Kept Outside'),
    },
    'pointer.json': characterJson('pointer', 'Kept Outside'),
  });
  const home = createHome({
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
      pointer: {},
    },
  });

  symlinkSync(join(outside, 'linked'), join(home, 'characters', 'linked'));
  symlinkSync(join(outside, 'pointer.json'), descriptor(home, 'pointer'));

  const wire = wireOf(await startDaemon(home, fixedReplies));
  const health = await wire.health();

  expect(health).toMatchObject({
    characters: [{id: 'mira'}, {id: 'zeta'}],
    packages: {
      diagnostics: [
        {path: join(home, 'characters', 'linked')},
        {path: descriptor(home, 'pointer')},
      ],
    },
  });
  expect(JSON.stringify(health)).not.toContain('Kept Outside');

  for (const id of ['linked', 'pointer']) {
    expect(await wire.start(id), id).toMatchObject({
      status: 'refused',
      reason: 'unknown_character',
    });
  }
});

it('characters.package-version-upgrade: her first start and each new version of her package fill in only the settings she lacks, so what the person set on her screen, before her first start or after, stays', async () => {
  const home = createHome({
    'config.json': configJson({project02: {enabled: false}}),
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          plugins: {config: {'demo-config': {tone: 'warm'}}},
        }),
      },
    },
  });
  const nova = {scope: 'character', characterId: 'nova'} as const;
  const first = await startDaemon(home, fixedReplies);
  const wire = wireOf(first);

  await saveConfig(wire, nova, {
    kind: 'set',
    path: 'project02.enabled',
    value: true,
  });
  expect(await wire.start('nova')).toMatchObject({
    character: {state: 'ready'},
  });
  expect(overlayOf(home, 'nova')).toEqual({
    version: 'project02.config.v2',
    project02: {enabled: true},
    plugins: {'demo-config': {config: {tone: 'warm'}}},
  });
  await saveConfig(wire, nova, {
    kind: 'section_field_set',
    namespace: 'plugins',
    id: 'demo-config',
    field: 'tone',
    value: 'playful',
  });
  first.signal('SIGINT');
  await first.exit();
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
  expect(
    await wireOf(await startDaemon(home, fixedReplies)).start('nova'),
  ).toMatchObject({character: {state: 'ready'}});
  expect(overlayOf(home, 'nova')).toEqual({
    version: 'project02.config.v2',
    project02: {enabled: true},
    plugins: {
      'demo-config': {
        enabled: true,
        config: {tone: 'playful', signoff: 'Upgraded.'},
      },
    },
  });
});
