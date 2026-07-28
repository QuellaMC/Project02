import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  defaultProject02CharacterId,
  prepareProject02CharacterActivation,
} from '../../src/app/character.ts';
import {operatorCharacterPackagesRoot} from '../../src/characters/index.ts';

function writeOperatorCharacter(
  storeRoot: string,
  id: string,
  raw?: string,
): void {
  const packageRoot = join(operatorCharacterPackagesRoot(storeRoot), id);

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    raw ??
      `${JSON.stringify({
        format: 'project02.character.v1',
        identity: {id, displayName: id},
        persona: {system: [`You are ${id}.`]},
        meta: {version: '1.0.0'},
      })}\n`,
    'utf8',
  );
}

describe('project02 character activation', () => {
  it('resolves the bundled default character with no store root', () => {
    const activation = prepareProject02CharacterActivation();

    expect(activation).toMatchObject({
      status: 'resolved',
      configuredCharacterId: defaultProject02CharacterId,
      profile: {id: 'mira', displayName: 'Mira'},
      warnings: [],
    });
  });

  it('fails with discovered ids and a recovery path for an unknown character id', () => {
    const activation = prepareProject02CharacterActivation({
      configuredCharacterId: 'nope',
    });

    expect(activation.status).toBe('failed');
    if (activation.status !== 'failed') {
      throw new Error('Expected failed activation.');
    }

    expect(activation.messages[0]).toContain('Character "nope" was not found');
    expect(activation.messages[0]).toContain('mira');
    expect(activation.messages[0]).toContain(
      'Install the character package under the bundled or store characters root',
    );
  });

  it('surfaces unrelated broken packages as warnings without blocking', () => {
    const storeRoot = createTestTempRoot();

    writeOperatorCharacter(storeRoot, 'broken', '{not json');

    const activation = prepareProject02CharacterActivation({storeRoot});

    expect(activation.status).toBe('resolved');
    if (activation.status !== 'resolved') {
      throw new Error('Expected resolved activation.');
    }

    expect(activation.profile.id).toBe('mira');
    expect(activation.warnings).toHaveLength(1);
    expect(activation.warnings[0]).toContain('invalid_descriptor');
  });

  it('names the folder mismatch when the selected character sits in a misspelled folder', () => {
    const storeRoot = createTestTempRoot();

    writeOperatorCharacter(
      storeRoot,
      'wrong',
      `${JSON.stringify({
        format: 'project02.character.v1',
        identity: {id: 'nova', displayName: 'Nova'},
        persona: {system: ['You are Nova.']},
        meta: {version: '1.0.0'},
      })}\n`,
    );

    const activation = prepareProject02CharacterActivation({
      storeRoot,
      configuredCharacterId: 'nova',
    });

    expect(activation.status).toBe('failed');
    if (activation.status !== 'failed') {
      throw new Error('Expected failed activation.');
    }

    // Attributing this only to the folder would drop it into the
    // unrelated-package warnings and leave the operator with "nova was
    // not found; install it" — advice that cannot work, because nova is
    // installed and only the folder name is wrong.
    expect(
      activation.messages.some(message =>
        message.includes('package_id_mismatch'),
      ),
    ).toBe(true);
  });

  it('fails when the configured character id is defined in more than one root', () => {
    const storeRoot = createTestTempRoot();

    writeOperatorCharacter(storeRoot, 'mira');

    const activation = prepareProject02CharacterActivation({storeRoot});

    expect(activation.status).toBe('failed');
    if (activation.status !== 'failed') {
      throw new Error('Expected failed activation.');
    }

    expect(
      activation.messages.some(message =>
        message.includes('duplicate_character_id'),
      ),
    ).toBe(true);
  });
});
