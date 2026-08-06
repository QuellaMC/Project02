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

    // Discovery folds character ids case-insensitively, so on a
    // case-sensitive filesystem a differently-cased sibling is a package
    // mkdir would accept and discovery would then reject as a duplicate
    // — taking the original down with it. The scaffold refuses under the
    // same fold discovery judges by, and names the directory in the way.
    expect(() =>
      scaffoldCharacterPackage({id: 'TEST.Scaffold-Char', packagesRoot}),
    ).toThrow(`already exists: ${packageRoot}`);

    // And it leaves nothing behind when it refuses. A claim kept for an
    // id that was never stamped would make the next attempt report a
    // package that does not exist.
    expect(readdirSync(packagesRoot)).toEqual(['test.scaffold-char']);

    // The same id twice is refused by the claim itself rather than by a
    // scan that ran before it, which is what makes two concurrent runs
    // safe: exactly one gets the directory.
    expect(() =>
      scaffoldCharacterPackage({id: 'test.scaffold-char', packagesRoot}),
    ).toThrow(`already exists: ${packageRoot}`);

    // The loser must not overwrite the winner's descriptor. `mkdir` with
    // `recursive: true` reports success on a directory it did not
    // create, so this is the failure an exclusive create rules out.
    expect(
      JSON.parse(
        readFileSync(join(packageRoot, 'project02.character.json'), 'utf8'),
      ),
    ).toEqual(raw);
  });

  it('accepts a plugins block through both the schema and the code validator', () => {
    const descriptor = {
      ...validDescriptor(),
      plugins: {
        required: ['character-state'],
        recommended: ['demo-config'],
        config: {
          'demo-config': {
            tone: 'warm',
            settings: {style: ['short', 'friendly']},
          },
        },
      },
    };

    expect(
      validateAgainstSchema(descriptor),
      JSON.stringify(validateAgainstSchema.errors),
    ).toBe(true);
    expect(parseCharacterPackageDescriptor(descriptor)).toMatchObject({
      status: 'accepted',
      definition: {
        plugins: {
          required: ['character-state'],
          recommended: ['demo-config'],
          config: {
            'demo-config': {
              tone: 'warm',
              settings: {style: ['short', 'friendly']},
            },
          },
        },
      },
    });
  });

  it.each([
    ['persona.system', 'system'],
    ['identity.displayName', 'displayName'],
  ])('measures the %s bound in code points, like the schema', (_label, key) => {
    // A schema `maxLength` counts code points; `String.length` counts UTF-16
    // units, so astral characters count twice and an editor-valid package
    // would be rejected at activation for half its documented length.
    const astral = '😀';
    const descriptor =
      key === 'system'
        ? {...validDescriptor(), persona: {system: [astral.repeat(4_000)]}}
        : {
            ...validDescriptor(),
            identity: {
              id: 'test-scaffold-char',
              displayName: astral.repeat(128),
            },
          };

    expect(
      validateAgainstSchema(descriptor),
      JSON.stringify(validateAgainstSchema.errors),
    ).toBe(true);
    expect(parseCharacterPackageDescriptor(descriptor).status).toBe('accepted');
  });

  it('accepts a string $schema key, and its absence, in both validators', () => {
    const descriptor = validDescriptor();

    expect(typeof descriptor['$schema']).toBe('string');
    expect(parseCharacterPackageDescriptor(descriptor).status).toBe('accepted');

    // Referencing the editor schema is optional, so an absent key stays
    // acceptable to both validators.
    const withoutSchemaRef = {...descriptor};

    delete withoutSchemaRef['$schema'];
    expect(
      validateAgainstSchema(withoutSchemaRef),
      JSON.stringify(validateAgainstSchema.errors),
    ).toBe(true);
    expect(parseCharacterPackageDescriptor(withoutSchemaRef).status).toBe(
      'accepted',
    );
  });

  it('preserves package-authored nested config key order', () => {
    const parsed = parseCharacterPackageDescriptor({
      ...validDescriptor(),
      plugins: {
        config: {
          'demo-config': {
            zeta: true,
            alpha: false,
          },
        },
      },
    });

    expect(parsed.status).toBe('accepted');
    if (parsed.status === 'accepted') {
      expect(
        Object.keys(parsed.definition.plugins?.config['demo-config'] ?? {}),
      ).toEqual(['zeta', 'alpha']);
    }
  });

  it.each([
    [
      'cycles',
      () => {
        const nested: Record<string, unknown> = {};

        nested['self'] = nested;
        return {
          ...validDescriptor(),
          plugins: {config: {'demo-config': nested}},
        };
      },
    ],
    [
      'excessive nesting',
      () => {
        let nested: Record<string, unknown> = {value: true};

        for (let depth = 0; depth < 20; depth += 1) {
          nested = {nested};
        }

        return {
          ...validDescriptor(),
          plugins: {config: {'demo-config': nested}},
        };
      },
    ],
    [
      'oversized containers',
      () => ({
        ...validDescriptor(),
        plugins: {
          config: {
            'demo-config': Object.fromEntries(
              Array.from({length: 257}, (_, index) => [
                `field-${String(index)}`,
                index,
              ]),
            ),
          },
        },
      }),
    ],
  ])('rejects unsafe direct-parser input with %s', (_label, createValue) => {
    expect(parseCharacterPackageDescriptor(createValue())).toMatchObject({
      status: 'rejected',
      issue: {
        code: 'invalid_descriptor',
        message: 'Character package descriptor exceeds safe JSON limits.',
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
      'an unknown plugins key',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {required: [], autoInstall: true},
      }),
    ],
    [
      'a duplicated required plugin id',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {required: ['demo-config', 'demo-config']},
      }),
    ],
    [
      'an invalid plugin id',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {recommended: ['9starts-with-digit']},
      }),
    ],
    [
      'a secret env reference in plugin defaults',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {
          config: {'demo-config': {apiKey: {$env: 'DEMO_API_KEY'}}},
        },
      }),
    ],
    [
      'a nested plaintext-secret marker in plugin defaults',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {
          config: {
            'demo-config': {
              nested: {
                token: {
                  $plaintextSecret: 'nope',
                  allowPlaintextSecret: true,
                  justification: 'still not package-safe',
                },
              },
            },
          },
        },
      }),
    ],
    [
      'a plaintext-secret allowance marker in plugin defaults',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {
          config: {
            'demo-config': {
              nested: {
                allowPlaintextSecret: false,
              },
            },
          },
        },
      }),
    ],
    [
      'a non-object plugin config entry',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {config: {'demo-config': 'warm'}},
      }),
    ],
    [
      'too many required plugins',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        plugins: {
          required: Array.from({length: 33}, (_, index) => `p${String(index)}`),
        },
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
      'a non-string $schema reference',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        // The key is allowed and ignored, so nothing else validates it;
        // without its own guard the code accepted a shape this schema
        // rejects, and the mistake surfaced only in the other tool.
        $schema: 42,
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
    [
      'a multiline display name',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        // Chat prints `<name>: <text>`, so a newline here would let an
        // accepted package forge extra terminal lines.
        identity: {
          ...(descriptor['identity'] as Record<string, unknown>),
          displayName: 'Mira\nError: failed',
        },
      }),
    ],
    [
      'an over-length meta version component',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        // The version is copied into every turn's `characterRef`, so digits are
        // bounded per component rather than left open.
        meta: {version: `1.0.${'9'.repeat(10)}`},
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
