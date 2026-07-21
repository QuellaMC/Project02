import {mkdtempSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {Ajv} from 'ajv';
import {describe, expect, it} from 'vitest';

import {scaffoldCharacterPackage} from '../../scripts/create-character.mjs';

import {parseCharacterPackageDescriptor} from '../../src/characters/api/package-descriptor.ts';
import {bundledCharacterPackagesRoot} from '../../src/characters/loader/discovery.ts';

const schemaPath = join(
  process.cwd(),
  'schemas',
  'project02.character.schema.json',
);
const validateAgainstSchema = new Ajv({allErrors: true, strict: true}).compile(
  JSON.parse(readFileSync(schemaPath, 'utf8')) as object,
);

function bundledDescriptorPaths(): readonly string[] {
  return readdirSync(bundledCharacterPackagesRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry =>
      join(
        bundledCharacterPackagesRoot,
        entry.name,
        'project02.character.json',
      ),
    );
}

function validDescriptor(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(bundledCharacterPackagesRoot, 'mira', 'project02.character.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('character package descriptor schema parity', () => {
  it('accepts every bundled descriptor through both the schema and the code validator', () => {
    const paths = bundledDescriptorPaths();

    expect(paths.length).toBeGreaterThanOrEqual(1);
    for (const path of paths) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;

      expect(
        validateAgainstSchema(raw),
        JSON.stringify(validateAgainstSchema.errors),
      ).toBe(true);
      expect(parseCharacterPackageDescriptor(raw).status).toBe('accepted');
    }
  });

  it('accepts the scaffold output through both the schema and the code validator', () => {
    const packagesRoot = mkdtempSync(
      join(tmpdir(), 'project02-char-scaffold-'),
    );
    const {packageRoot} = scaffoldCharacterPackage({
      id: 'test.scaffold-char',
      packagesRoot,
    });
    const raw = JSON.parse(
      readFileSync(join(packageRoot, 'project02.character.json'), 'utf8'),
    ) as unknown;

    expect(
      validateAgainstSchema(raw),
      JSON.stringify(validateAgainstSchema.errors),
    ).toBe(true);
    expect(parseCharacterPackageDescriptor(raw)).toMatchObject({
      status: 'accepted',
      definition: {
        identity: {
          id: 'test.scaffold-char',
          displayName: 'Test Scaffold Char',
        },
        persona: {system: ['You are Test Scaffold Char.']},
        meta: {version: '1.0.0'},
      },
    });
  });

  it.each([
    [
      'an unknown descriptor key',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        style: {mode: 'rewrite'},
      }),
    ],
    [
      'a wrong format value',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        format: 'project02.character.v2',
      }),
    ],
    [
      'a missing identity',
      (descriptor: Record<string, unknown>) => {
        const rest = {...descriptor};

        delete rest['identity'];
        return rest;
      },
    ],
    [
      'an unknown identity key',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        identity: {id: 'mira', displayName: 'Mira', pronouns: 'she/her'},
      }),
    ],
    [
      'an invalid identity id',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        identity: {id: '9mira', displayName: 'Mira'},
      }),
    ],
    [
      'a blank display name',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        identity: {id: 'mira', displayName: '   '},
      }),
    ],
    [
      'an empty persona section list',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        persona: {system: []},
      }),
    ],
    [
      'too many persona sections',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        persona: {system: Array.from({length: 17}, () => 'section')},
      }),
    ],
    [
      'a blank persona section',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        persona: {system: ['You are Mira.', '  ']},
      }),
    ],
    [
      'an over-length persona section',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        persona: {system: ['x'.repeat(4001)]},
      }),
    ],
    [
      'an unknown persona key',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        persona: {system: ['You are Mira.'], exampleDialogues: []},
      }),
    ],
    [
      'a non-semantic meta version',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        meta: {version: 'v1'},
      }),
    ],
  ])(
    'rejects %s through both the schema and the code validator',
    (_label, mutate) => {
      const mutated = mutate(validDescriptor());

      expect(validateAgainstSchema(mutated)).toBe(false);
      expect(parseCharacterPackageDescriptor(mutated).status).toBe('rejected');
    },
  );

  it('names the offending field in code-validator rejections', () => {
    const unknownField = parseCharacterPackageDescriptor({
      ...validDescriptor(),
      voice: {},
    });
    const badSection = parseCharacterPackageDescriptor({
      ...validDescriptor(),
      persona: {system: ['fine', '']},
    });

    expect(unknownField).toMatchObject({
      status: 'rejected',
      issue: {
        code: 'invalid_descriptor',
        message: 'Character package descriptor contains unknown field "voice".',
      },
    });
    expect(badSection).toMatchObject({
      status: 'rejected',
      issue: {
        code: 'invalid_persona',
        message:
          'Character package persona.system[1] must be a non-blank string ' +
          'of at most 4000 characters.',
      },
    });
  });
});
