import {mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  bundledCharacterPackagesRoot,
  defaultCharacterPackageSources,
  discoverCharacterPackages,
  operatorCharacterPackagesRoot,
} from '../../src/characters/loader/discovery.ts';

function writeCharacterPackage(
  root: string,
  id: string,
  options: {
    readonly descriptorId?: string;
    readonly displayName?: string;
    readonly raw?: string;
  } = {},
): string {
  const packageRoot = join(root, id);

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    options.raw ??
      `${JSON.stringify({
        format: 'project02.character.v1',
        identity: {
          id: options.descriptorId ?? id,
          displayName: options.displayName ?? id,
        },
        persona: {system: [`You are ${options.displayName ?? id}.`]},
        meta: {version: '1.0.0'},
      })}\n`,
    'utf8',
  );

  return packageRoot;
}

describe('character package discovery', () => {
  it('discovers the bundled mira package from the real bundled root', () => {
    const discovery = discoverCharacterPackages({
      sources: defaultCharacterPackageSources(),
    });

    expect(discovery.diagnostics).toEqual([]);
    expect(
      discovery.characters.map(character => ({
        id: character.definition.identity.id,
        provenance: character.provenance,
      })),
    ).toContainEqual({id: 'mira', provenance: 'bundled'});
    const mira = discovery.characters.find(
      character => character.definition.identity.id === 'mira',
    );

    expect(mira?.definition).toMatchObject({
      identity: {id: 'mira', displayName: 'Mira'},
      meta: {version: '1.1.0'},
    });
    expect(mira?.definition.persona.system[0]).toContain('You are Mira');
    expect(mira?.packageRoot).toBe(join(bundledCharacterPackagesRoot, 'mira'));
  });

  it('discovers operator packages next to bundled ones and sorts by id', () => {
    const storeRoot = createTestTempRoot();
    const operatorRoot = operatorCharacterPackagesRoot(storeRoot);

    writeCharacterPackage(operatorRoot, 'zoe', {displayName: 'Zoe'});
    writeCharacterPackage(operatorRoot, 'aki', {displayName: 'Aki'});

    const discovery = discoverCharacterPackages({
      sources: defaultCharacterPackageSources(storeRoot),
    });

    expect(discovery.diagnostics).toEqual([]);
    expect(
      discovery.characters.map(character => character.definition.identity.id),
    ).toEqual(['aki', 'mira', 'zoe']);
    expect(discovery.characters.map(character => character.provenance)).toEqual(
      ['operator', 'bundled', 'operator'],
    );
  });

  it('skips a root nested under a plain file without diagnostics', () => {
    const root = createTestTempRoot();
    const filePath = join(root, 'not-a-dir');

    writeFileSync(filePath, 'plain file\n', 'utf8');

    const discovery = discoverCharacterPackages({
      sources: [{root: join(filePath, 'characters'), provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([]);
  });

  it('skips a missing operator root without diagnostics', () => {
    const storeRoot = createTestTempRoot();

    const discovery = discoverCharacterPackages({
      sources: [
        {
          root: operatorCharacterPackagesRoot(storeRoot),
          provenance: 'operator',
        },
      ],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([]);
  });

  it('rejects the same character id defined in more than one root', () => {
    const storeRoot = createTestTempRoot();
    const operatorRoot = operatorCharacterPackagesRoot(storeRoot);

    writeCharacterPackage(operatorRoot, 'mira', {displayName: 'Other Mira'});

    const discovery = discoverCharacterPackages({
      sources: defaultCharacterPackageSources(storeRoot),
    });

    expect(
      discovery.characters.map(character => character.definition.identity.id),
    ).not.toContain('mira');
    const duplicates = discovery.diagnostics.filter(
      diagnostic => diagnostic.code === 'duplicate_character_id',
    );

    expect(duplicates).toHaveLength(2);
    expect(duplicates.map(diagnostic => diagnostic.provenance).sort()).toEqual([
      'bundled',
      'operator',
    ]);
    for (const diagnostic of duplicates) {
      expect(diagnostic.message).toContain('"mira"');
      expect(diagnostic.message).toContain('remove or rename');
    }
  });

  it('rejects a package whose folder does not match its identity id', () => {
    const root = createTestTempRoot();

    writeCharacterPackage(root, 'folder-name', {descriptorId: 'other-id'});

    const discovery = discoverCharacterPackages({
      sources: [{root, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'package_id_mismatch',
        characterId: 'folder-name',
        provenance: 'operator',
      }),
    ]);
  });

  it('rejects symbolic-link package directories', () => {
    const root = createTestTempRoot();
    const realRoot = createTestTempRoot();

    writeCharacterPackage(realRoot, 'linked');
    symlinkSync(join(realRoot, 'linked'), join(root, 'linked'));

    const discovery = discoverCharacterPackages({
      sources: [{root, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_package_directory',
        characterId: 'linked',
      }),
    ]);
  });

  it('reports invalid JSON and invalid descriptors with the descriptor path', () => {
    const root = createTestTempRoot();

    writeCharacterPackage(root, 'broken-json', {raw: '{not json'});
    writeCharacterPackage(root, 'bad-persona', {
      raw: `${JSON.stringify({
        format: 'project02.character.v1',
        identity: {id: 'bad-persona', displayName: 'Bad Persona'},
        persona: {system: []},
        meta: {version: '1.0.0'},
      })}\n`,
    });

    const discovery = discoverCharacterPackages({
      sources: [{root, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_persona',
        characterId: 'bad-persona',
        path: join(root, 'bad-persona', 'project02.character.json'),
      }),
      expect.objectContaining({
        code: 'invalid_descriptor',
        characterId: 'broken-json',
        message: 'Character package descriptor must contain valid JSON.',
      }),
    ]);
  });

  it('preserves the discovery diagnostic for unsafe descriptor JSON', () => {
    const root = createTestTempRoot();

    writeCharacterPackage(root, 'unsafe-json', {
      raw: `${JSON.stringify({
        format: 'project02.character.v1',
        identity: {id: 'unsafe-json', displayName: 'Unsafe JSON'},
        persona: {system: ['You are Unsafe JSON.']},
        meta: {version: '1.0.0'},
        plugins: {
          config: {
            fixture: Object.fromEntries(
              Array.from({length: 257}, (_, index) => [
                `field-${String(index)}`,
                index,
              ]),
            ),
          },
        },
      })}\n`,
    });

    const discovery = discoverCharacterPackages({
      sources: [{root, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        characterId: 'unsafe-json',
        message: 'Character package descriptor exceeds safe JSON limits.',
      }),
    ]);
  });

  it('ignores loose files in a discovery root', () => {
    const root = createTestTempRoot();

    writeFileSync(join(root, 'notes.txt'), 'not a package\n', 'utf8');
    writeCharacterPackage(root, 'solo');

    const discovery = discoverCharacterPackages({
      sources: [{root, provenance: 'operator'}],
    });

    expect(discovery.diagnostics).toEqual([]);
    expect(
      discovery.characters.map(character => character.definition.identity.id),
    ).toEqual(['solo']);
  });
});
