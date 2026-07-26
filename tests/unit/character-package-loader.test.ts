import {mkdirSync, renameSync, symlinkSync, writeFileSync} from 'node:fs';
import type * as NodeFs from 'node:fs';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  bundledCharacterPackagesRoot,
  defaultCharacterPackageSources,
  discoverCharacterPackages,
  operatorCharacterPackagesRoot,
} from '../../src/characters/loader/discovery.ts';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

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

  it('rejects character ids that differ only by case', () => {
    const storeRoot = createTestTempRoot();
    const operatorRoot = operatorCharacterPackagesRoot(storeRoot);

    // Distinct ids, one character-data directory on a case-insensitive
    // filesystem: whichever selection ran first would stamp the shared
    // marker and the other would fail as an identity mismatch.
    writeCharacterPackage(operatorRoot, 'Mira', {displayName: 'Upper Mira'});

    const discovery = discoverCharacterPackages({
      sources: defaultCharacterPackageSources(storeRoot),
    });

    expect(
      discovery.characters.map(character => character.definition.identity.id),
    ).not.toContain('mira');
    expect(
      discovery.characters.map(character => character.definition.identity.id),
    ).not.toContain('Mira');
    const duplicates = discovery.diagnostics.filter(
      diagnostic => diagnostic.code === 'duplicate_character_id',
    );

    expect(duplicates).toHaveLength(2);
    for (const diagnostic of duplicates) {
      expect(diagnostic.message).toContain('"Mira"');
      expect(diagnostic.message).toContain('"mira"');
      expect(diagnostic.message).toContain('differ only by case');
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

  it('reads a descriptor reached through a link inside the package', () => {
    const root = createTestTempRoot();
    const packageRoot = writeCharacterPackage(root, 'inside-link');
    const descriptorPath = join(packageRoot, 'project02.character.json');

    renameSync(descriptorPath, join(packageRoot, 'authored.json'));
    symlinkSync('authored.json', descriptorPath);

    const discovery = discoverCharacterPackages({
      sources: [{root, provenance: 'operator'}],
    });

    expect(discovery.diagnostics).toEqual([]);
    expect(
      discovery.characters.map(character => character.definition.identity.id),
    ).toEqual(['inside-link']);
  });

  it('rejects a descriptor link that leaves the package', () => {
    const parentRoot = createTestTempRoot();
    const root = join(parentRoot, 'source');
    const packageRoot = writeCharacterPackage(root, 'outside-link');
    const descriptorPath = join(packageRoot, 'project02.character.json');

    renameSync(descriptorPath, join(parentRoot, 'authored.json'));
    symlinkSync(join(parentRoot, 'authored.json'), descriptorPath);

    const discovery = discoverCharacterPackages({
      sources: [{root, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        message: 'Character package descriptor must be a regular file.',
        path: descriptorPath,
        characterId: 'outside-link',
      }),
    ]);
  });

  it('rejects a package replaced by an outside directory after source enumeration', async () => {
    const parentRoot = createTestTempRoot();
    const sourceRoot = join(parentRoot, 'source');
    const externalRoot = join(parentRoot, 'external');
    const packageRoot = writeCharacterPackage(sourceRoot, 'swapped');
    const externalPackageRoot = writeCharacterPackage(externalRoot, 'swapped');
    const parkedPackageRoot = join(parentRoot, 'parked');
    let swapped = false;

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        readdirSync(path: NodeFs.PathLike, options?: unknown) {
          const entries = Reflect.apply(actual.readdirSync, actual, [
            path,
            options,
          ]) as unknown;

          if (path === sourceRoot && !swapped) {
            swapped = true;
            renameSync(packageRoot, parkedPackageRoot);
            renameSync(externalPackageRoot, packageRoot);
          }

          return entries;
        },
      };
    });
    const {discoverCharacterPackages: discoverAfterEnumeration} =
      await import('../../src/characters/loader/discovery.ts');

    const discovery = discoverAfterEnumeration({
      sources: [{root: sourceRoot, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'package_source_unavailable',
        path: sourceRoot,
      }),
    ]);
  });

  it('rejects packages read from a source root replaced after enumeration', async () => {
    const parentRoot = createTestTempRoot();
    const sourceRoot = join(parentRoot, 'source');
    const externalRoot = join(parentRoot, 'external');
    const parkedSourceRoot = join(parentRoot, 'parked-source');

    writeCharacterPackage(sourceRoot, 'swapped');
    writeCharacterPackage(externalRoot, 'swapped', {
      displayName: 'Outside',
    });
    let swapped = false;

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        readdirSync(path: NodeFs.PathLike, options?: unknown) {
          const entries = Reflect.apply(actual.readdirSync, actual, [
            path,
            options,
          ]) as unknown;

          if (path === sourceRoot && !swapped) {
            swapped = true;
            renameSync(sourceRoot, parkedSourceRoot);
            renameSync(externalRoot, sourceRoot);
          }

          return entries;
        },
      };
    });
    const {discoverCharacterPackages: discoverAfterEnumeration} =
      await import('../../src/characters/loader/discovery.ts');

    const discovery = discoverAfterEnumeration({
      sources: [{root: sourceRoot, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'package_source_unavailable',
        path: sourceRoot,
        provenance: 'operator',
      }),
    ]);
  });

  it('rejects an outside descriptor read through an ancestor ABA swap', async () => {
    const parentRoot = createTestTempRoot();
    const boundAncestor = join(parentRoot, 'bound');
    const externalAncestor = join(parentRoot, 'external');
    const parkedAncestor = join(parentRoot, 'parked');
    const sourceRoot = join(boundAncestor, 'source');
    const externalSourceRoot = join(externalAncestor, 'source');
    const packageRoot = writeCharacterPackage(sourceRoot, 'swapped');

    writeCharacterPackage(externalSourceRoot, 'swapped', {
      displayName: 'Outside',
    });
    let swapped = false;
    let restored = false;
    let packageRealpathCount = 0;

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        readdirSync(path: NodeFs.PathLike, options?: unknown) {
          const entries = Reflect.apply(actual.readdirSync, actual, [
            path,
            options,
          ]) as unknown;

          if (path === sourceRoot && !swapped) {
            swapped = true;
            renameSync(boundAncestor, parkedAncestor);
            renameSync(externalAncestor, boundAncestor);
          }
          return entries;
        },
        realpathSync(path: NodeFs.PathLike, options?: unknown) {
          const realPath = Reflect.apply(actual.realpathSync, actual, [
            path,
            options,
          ]) as unknown;

          if (path === packageRoot && swapped && !restored) {
            packageRealpathCount += 1;
            if (packageRealpathCount === 2) {
              renameSync(boundAncestor, externalAncestor);
              renameSync(parkedAncestor, boundAncestor);
              restored = true;
            }
          }
          return realPath;
        },
      };
    });
    const {discoverCharacterPackages: discoverDuringAncestorSwap} =
      await import('../../src/characters/loader/discovery.ts');

    const discovery = discoverDuringAncestorSwap({
      sources: [{root: sourceRoot, provenance: 'operator'}],
    });

    // An ancestor that is swapped and restored mid-scan can be caught by the
    // per-package ancestry guard or by the closing source-root equality check,
    // depending on where the rename lands between those reads. Both are
    // correct refusals, so pin the contract — no outside descriptor is ever
    // published, and the swap is reported as an error — instead of pinning
    // which guard happened to win the race.
    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).not.toEqual([]);
    for (const diagnostic of discovery.diagnostics) {
      expect(diagnostic.severity).toBe('error');
      expect([
        'package_source_unavailable',
        'invalid_package_directory',
      ]).toContain(diagnostic.code);
      expect(diagnostic.path.startsWith(boundAncestor)).toBe(true);
    }
  });

  it('rejects a package replaced immediately after its directory check', async () => {
    const parentRoot = createTestTempRoot();
    const sourceRoot = join(parentRoot, 'source');
    const externalRoot = join(parentRoot, 'external');
    const packageRoot = writeCharacterPackage(sourceRoot, 'swapped');
    const externalPackageRoot = writeCharacterPackage(externalRoot, 'swapped', {
      displayName: 'Outside',
    });
    const parkedPackageRoot = join(parentRoot, 'parked');
    let packageRootInspected = false;

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        lstatSync(path: NodeFs.PathLike, options?: unknown) {
          const stat = Reflect.apply(actual.lstatSync, actual, [
            path,
            options,
          ]) as unknown;

          if (path === packageRoot && !packageRootInspected) {
            packageRootInspected = true;
            renameSync(packageRoot, parkedPackageRoot);
            symlinkSync(externalPackageRoot, packageRoot, 'dir');
          }

          return stat;
        },
      };
    });
    const {discoverCharacterPackages: discoverAfterDirectoryCheck} =
      await import('../../src/characters/loader/discovery.ts');

    const discovery = discoverAfterDirectoryCheck({
      sources: [{root: sourceRoot, provenance: 'operator'}],
    });

    expect(discovery.characters).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'package_source_unavailable',
        path: sourceRoot,
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
