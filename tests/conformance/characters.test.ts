import {existsSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {
  characterJson,
  configJson,
  createHome,
  snapshot,
} from './harness/home.ts';
import {conversationOf, converse, saveConfig, wireOf} from './harness/wire.ts';

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
    characters: {
      nova: {
        'project02.character.json': characterJson('nova', 'Nova', {
          plugins: {config: {'reply-style': {tone: 'warm'}}},
        }),
      },
    },
    'character-data': {
      nova: {'config.json': configJson({project02: {enabled: false}})},
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
    plugins: {'reply-style': {config: {tone: 'warm'}}},
  });
  await saveConfig(wire, nova, {
    kind: 'section_field_set',
    namespace: 'plugins',
    id: 'reply-style',
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
        recommended: ['reply-style'],
        config: {'reply-style': {tone: 'formal', signoff: 'Upgraded.'}},
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
      'reply-style': {
        enabled: true,
        config: {tone: 'playful', signoff: 'Upgraded.'},
      },
    },
  });
});

it('characters.add-from-file: a file previews as who she is and what she comes with, and adding her while the daemon runs starts her; adding a new version of her restarts her from it; removing her takes her package and leaves her data, so adding her again brings her conversation back', async () => {
  const home = createHome();
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const first = characterJson('nova', 'Nova', {
    identity: {
      id: 'nova',
      displayName: 'Nova',
      about: 'A quiet one, who notices things.',
    },
    plugins: {recommended: ['reply-style', 'teleport']},
  });
  const second = characterJson('nova', 'Nova Two', {meta: {version: '2.0.0'}});
  const ready = frameOf('state_changed', {characterId: 'nova', state: 'ready'});
  const stopped = frameOf('state_changed', {
    characterId: 'nova',
    state: 'stopped',
  });

  expect(await wire.previewCharacter(first)).toEqual({
    status: 'ok',
    id: 'nova',
    displayName: 'Nova',
    version: '1.0.0',
    about: 'A quiet one, who notices things.',
    comesWith: [
      {
        kind: 'plugin',
        id: 'runtime.plugin',
        displayName: 'Ask to Change Settings',
      },
      {kind: 'plugin', id: 'character-memory', displayName: 'Notebook'},
      {kind: 'plugin', id: 'reply-style', displayName: 'Reply Style'},
      {kind: 'plugin', id: 'session-history', displayName: 'Look Back'},
      {kind: 'unknown', id: 'teleport'},
    ],
    installed: 'none',
    hasData: false,
  });
  expect(await wire.addCharacter(first)).toEqual({
    status: 'added',
    characterId: 'nova',
  });
  await events.next(ready);
  expect(await wire.health()).toMatchObject({
    characters: [
      {id: 'mira', builtIn: true},
      {id: 'nova', builtIn: false, state: 'ready'},
    ],
  });

  const say = await converse(wire, 'nova');
  const reply = (speakerName: string) => ({
    status: 'completed',
    messages: [{}, {speakerId: 'nova', speakerName}],
  });

  expect(await say('Hello, Nova.', 'first')).toMatchObject(reply('Nova'));
  expect(await wire.previewCharacter(second)).toMatchObject({
    installed: 'other_version',
    hasData: true,
  });
  expect(await wire.addCharacter(second)).toEqual({
    status: 'updated',
    characterId: 'nova',
  });
  expect(await wire.previewCharacter(second)).toMatchObject({
    installed: 'same',
  });
  await events.next(stopped);
  await events.next(ready);
  expect(await say('Still you?', 'second')).toMatchObject(reply('Nova Two'));

  const {conversationId} = await conversationOf(wire, 'nova');

  expect(await wire.removeCharacter('nova')).toEqual({status: 'removed'});
  await events.next(stopped);
  expect(await wire.health()).toMatchObject({characters: [{id: 'mira'}]});
  expect(await wire.open('nova')).toMatchObject({
    status: 'refused',
    reason: 'character_unavailable',
  });
  expect(existsSync(join(home, 'characters', 'nova'))).toBe(false);
  expect(await wire.previewCharacter(second)).toMatchObject({
    installed: 'none',
    hasData: true,
  });
  expect(await wire.addCharacter(second)).toEqual({
    status: 'added',
    characterId: 'nova',
  });
  await wire.start('nova');
  expect(await conversationOf(wire, 'nova')).toMatchObject({conversationId});
  expect(await wire.history(conversationId)).toMatchObject({
    status: 'ok',
    messages: [
      {text: 'Hello, Nova.'},
      {speakerName: 'Nova'},
      {text: 'Still you?'},
      {speakerName: 'Nova Two'},
    ],
  });
});

it('characters.add-remove-refusals: a file that is no character, one whose id differs from an installed one only in capital letters, and one that comes with the app are refused and nothing is written; the character that comes with the app is not removed, nor one that is not here; and nothing is written or removed through a link', async () => {
  const home = createHome({
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const packages = snapshot(join(home, 'characters'));

  for (const offer of [wire.previewCharacter, wire.addCharacter]) {
    expect(await offer('{"name": "Nova"}')).toEqual({
      status: 'refused',
      reason: 'invalid',
      message: 'This file is not a character file this app can read.',
    });
    expect(await offer(characterJson('Nova', 'Nova Again'))).toMatchObject({
      status: 'refused',
      reason: 'invalid',
      message: expect.stringContaining('"nova"') as string,
    });
  }

  expect(
    await wire.previewCharacter(characterJson('mira', 'Mira Again')),
  ).toMatchObject({status: 'ok', installed: 'built_in'});
  expect(
    await wire.addCharacter(characterJson('mira', 'Mira Again')),
  ).toMatchObject({status: 'refused', reason: 'built_in'});
  expect(await wire.removeCharacter('mira')).toMatchObject({
    status: 'refused',
    reason: 'built_in',
  });

  expect(await wire.removeCharacter('ghost')).toMatchObject({
    status: 'refused',
    reason: 'unknown_character',
  });

  expect(snapshot(join(home, 'characters'))).toEqual(packages);

  const outside = createHome({
    zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
  });
  const linked = createHome();

  symlinkSync(outside, join(linked, 'characters'));

  const throughLink = wireOf(await startDaemon(linked, fixedReplies));
  const kept = snapshot(outside);
  const failed = {
    status: 'failed',
    message: expect.stringContaining(join(linked, 'characters')) as string,
  };

  expect(
    await throughLink.addCharacter(characterJson('lyra', 'Lyra')),
  ).toMatchObject(failed);
  expect(await throughLink.removeCharacter('zeta')).toMatchObject(failed);
  expect(snapshot(outside)).toEqual(kept);
});
