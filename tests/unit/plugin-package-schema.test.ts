import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {Ajv} from 'ajv';
import {describe, expect, it} from 'vitest';

import {scaffoldRuntimePluginPackage} from '../../scripts/create-plugin.mjs';

import {
  parseRuntimePluginPackageDescriptor,
  readRuntimePluginPackageDescriptor,
} from '../../src/plugins/api/package-descriptor.ts';
import {isJsonRecord} from '../../src/shared/json-boundary.ts';
import {
  bundledRuntimePluginPackageRoot,
  maxRuntimePluginPackageMetadataBytes,
} from '../../src/plugins/package-loader/index.ts';

const schemaPath = join(
  process.cwd(),
  'schemas',
  'project02.plugin.schema.json',
);
const validateAgainstSchema = new Ajv({allErrors: true, strict: true}).compile(
  JSON.parse(readFileSync(schemaPath, 'utf8')) as object,
);

function bundledDescriptorPaths(): readonly string[] {
  return readdirSync(bundledRuntimePluginPackageRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry =>
      join(
        bundledRuntimePluginPackageRoot,
        entry.name,
        'project02.plugin.json',
      ),
    );
}

function validDescriptor(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(
        bundledRuntimePluginPackageRoot,
        'demo-config',
        'project02.plugin.json',
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('plugin package descriptor schema parity', () => {
  it('accepts trusted_context in requestedAccess through both validators', () => {
    const descriptor = validDescriptor();
    const manifest = descriptor['manifest'] as Record<string, unknown>;
    const withCuratedContext = {
      ...descriptor,
      manifest: {
        ...manifest,
        requestedAccess: {
          ...(manifest['requestedAccess'] as Record<string, unknown>),
          trusted_context: 'write',
        },
      },
    };

    expect(
      validateAgainstSchema(withCuratedContext),
      JSON.stringify(validateAgainstSchema.errors),
    ).toBe(true);
    expect(parseRuntimePluginPackageDescriptor(withCuratedContext).status).toBe(
      'accepted',
    );
  });

  it('accepts every bundled descriptor through both the schema and the code validator', () => {
    const paths = bundledDescriptorPaths();

    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;

      expect(
        validateAgainstSchema(raw),
        JSON.stringify(validateAgainstSchema.errors),
      ).toBe(true);
      expect(parseRuntimePluginPackageDescriptor(raw).status).toBe('accepted');
      expect(() =>
        readRuntimePluginPackageDescriptor({
          descriptorUrl: new URL(`file://${path}`),
        }),
      ).not.toThrow();
    }
  });

  it.each([
    [
      'an unknown descriptor key',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        install: 'never',
      }),
    ],
    [
      'a wrong format value',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        format: 'project02.plugin.v0',
      }),
    ],
    [
      'an entry outside the package',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        entry: '/etc/passwd.js',
      }),
    ],
    [
      'an unsupported manifest kind',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        manifest: {
          ...(descriptor['manifest'] as Record<string, unknown>),
          kind: 'marketplace',
        },
      }),
    ],
    [
      'a missing config scope',
      (descriptor: Record<string, unknown>) => {
        const manifest = descriptor['manifest'] as Record<string, unknown>;
        const config = {...(manifest['config'] as Record<string, unknown>)};

        delete config['scope'];
        return {...descriptor, manifest: {...manifest, config}};
      },
    ],
    [
      'an unsupported config scope',
      (descriptor: Record<string, unknown>) => {
        const manifest = descriptor['manifest'] as Record<string, unknown>;

        return {
          ...descriptor,
          manifest: {
            ...manifest,
            config: {
              ...(manifest['config'] as Record<string, unknown>),
              scope: 'sometimes_global',
            },
          },
        };
      },
    ],
    [
      'a non-string $schema reference',
      (descriptor: Record<string, unknown>) => ({
        ...descriptor,
        // The key is allowed and ignored, so only its own guard validates it.
        $schema: 42,
      }),
    ],
    [
      'a character-only plugin enabled by manifest default',
      (descriptor: Record<string, unknown>) => {
        const manifest = descriptor['manifest'] as Record<string, unknown>;

        return {
          ...descriptor,
          manifest: {
            ...manifest,
            config: {
              ...(manifest['config'] as Record<string, unknown>),
              scope: 'character_only',
            },
            activation: {
              ...(manifest['activation'] as Record<string, unknown>),
              defaultEnabled: true,
            },
          },
        };
      },
    ],
    [
      'a secret agent-mutable config field',
      (descriptor: Record<string, unknown>) => {
        const manifest = descriptor['manifest'] as Record<string, unknown>;
        const config = manifest['config'] as {fields: readonly object[]};

        return {
          ...descriptor,
          manifest: {
            ...manifest,
            config: {
              scope: 'global_with_character_overrides',
              fields: [
                ...config.fields,
                {
                  name: 'leakyKey',
                  description: 'Secret that claims agent mutation.',
                  required: false,
                  secret: true,
                  valueType: 'string',
                  agentMutable: true,
                  redactionLabels: [],
                },
              ],
            },
          },
        };
      },
    ],
  ])(
    'rejects %s through both the schema and the code validator',
    (_case, mutate) => {
      const mutated = mutate(validDescriptor());

      expect(validateAgainstSchema(mutated)).toBe(false);
      expect(parseRuntimePluginPackageDescriptor(mutated).status).toBe(
        'rejected',
      );
    },
  );

  it("accepts a field scope that narrows its config's and refuses one that widens it, in both validators", () => {
    const descriptor = validDescriptor();
    const manifest = descriptor['manifest'];

    if (!isJsonRecord(manifest)) {
      throw new Error('Expected the demo descriptor to carry a manifest.');
    }

    const withConfig = (
      scope: string,
      fields: readonly {readonly name: string; readonly scope?: string}[],
    ) => ({
      ...descriptor,
      manifest: {
        ...manifest,
        config: {
          scope,
          fields: fields.map(field => ({
            ...field,
            description: `The ${field.name} setting.`,
            required: false,
            secret: false,
            valueType: 'string',
            redactionLabels: [],
          })),
        },
      },
    });
    const verdicts = (candidate: Record<string, unknown>) => [
      validateAgainstSchema(candidate),
      parseRuntimePluginPackageDescriptor(candidate).status,
    ];

    expect(verdicts(withConfig('global_only', [{name: 'tone'}]))).toEqual([
      true,
      'accepted',
    ]);
    expect(
      verdicts(
        withConfig('global_with_character_overrides', [
          {name: 'ownSetting', scope: 'character_only'},
          {name: 'homeSetting', scope: 'global_only'},
        ]),
      ),
    ).toEqual([true, 'accepted']);

    const widened = withConfig('character_only', [
      {name: 'homeSetting', scope: 'global_only'},
    ]);

    expect(validateAgainstSchema(widened)).toBe(false);
    expect(validateAgainstSchema.errors).toContainEqual(
      expect.objectContaining({
        instancePath: '/manifest/config/fields/0/scope',
      }),
    );
    expect(parseRuntimePluginPackageDescriptor(widened)).toEqual({
      status: 'rejected',
      issue: {
        code: 'invalid_manifest',
        message:
          'Plugin config field "homeSetting" cannot be "global_only" in a ' +
          '"character_only" config: a field\'s scope must equal its ' +
          'config\'s, or narrow "global_with_character_overrides".',
      },
    });
  });

  it('accepts a string $schema key, and its absence, in both validators', () => {
    const descriptor = validDescriptor();

    expect(typeof descriptor['$schema']).toBe('string');
    expect(parseRuntimePluginPackageDescriptor(descriptor).status).toBe(
      'accepted',
    );

    const withoutSchemaRef = {...descriptor};

    delete withoutSchemaRef['$schema'];
    expect(
      validateAgainstSchema(withoutSchemaRef),
      JSON.stringify(validateAgainstSchema.errors),
    ).toBe(true);
    expect(parseRuntimePluginPackageDescriptor(withoutSchemaRef).status).toBe(
      'accepted',
    );
  });

  it('bounds descriptor self-reads before parsing', () => {
    const root = mkdtempSync(join(tmpdir(), 'project02-plugin-self-read-'));
    const descriptorPath = join(root, 'project02.plugin.json');

    writeFileSync(
      descriptorPath,
      JSON.stringify({
        padding: 'x'.repeat(maxRuntimePluginPackageMetadataBytes),
      }),
      'utf8',
    );

    expect(() =>
      readRuntimePluginPackageDescriptor({
        descriptorUrl: pathToFileURL(descriptorPath),
      }),
    ).toThrow('Runtime plugin package descriptor could not be read.');
  });

  it('completes registration when rerun over its own unregistered scaffold', () => {
    const packagesRoot = mkdtempSync(
      join(tmpdir(), 'project02-plugin-scaffold-resume-'),
    );
    const bundledPath = join(packagesRoot, 'bundled.ts');
    const pristineBundled = readFileSync(
      fileURLToPath(
        new URL('../../src/plugins/package-loader/bundled.ts', import.meta.url),
      ),
      'utf8',
    );

    writeFileSync(bundledPath, pristineBundled, 'utf8');
    scaffoldRuntimePluginPackage({
      id: 'sample.resume-check',
      packagesRoot,
      bundledPath,
    });
    // A crash can leave the descriptor without its siblings or its entry.
    writeFileSync(bundledPath, pristineBundled, 'utf8');
    rmSync(join(packagesRoot, 'sample.resume-check', 'plugin.ts'));

    const {packageRoot} = scaffoldRuntimePluginPackage({
      id: 'sample.resume-check',
      packagesRoot,
      bundledPath,
    });

    expect(readFileSync(bundledPath, 'utf8')).toContain(
      "'../packages/sample.resume-check/index.ts'",
    );
    expect(existsSync(join(packageRoot, 'plugin.ts'))).toBe(true);
  });

  it('refuses a scaffold whose id collides with an existing registration name', () => {
    const packagesRoot = mkdtempSync(
      join(tmpdir(), 'project02-plugin-scaffold-collision-'),
    );
    const bundledPath = join(packagesRoot, 'bundled.ts');

    copyFileSync(
      fileURLToPath(
        new URL('../../src/plugins/package-loader/bundled.ts', import.meta.url),
      ),
      bundledPath,
    );
    const bundledBefore = readFileSync(bundledPath, 'utf8');

    expect(() =>
      scaffoldRuntimePluginPackage({
        id: 'demo.config',
        packagesRoot,
        bundledPath,
      }),
    ).toThrow('derives the registration name "createDemoConfigPlugin"');
    expect(existsSync(join(packagesRoot, 'demo.config'))).toBe(false);
    expect(readFileSync(bundledPath, 'utf8')).toBe(bundledBefore);

    // A leftover colliding scaffold must keep failing, never register.
    mkdirSync(join(packagesRoot, 'demo.config'));
    writeFileSync(
      join(packagesRoot, 'demo.config', 'project02.plugin.json'),
      `${JSON.stringify({manifest: {id: 'demo.config'}})}\n`,
      'utf8',
    );
    expect(() =>
      scaffoldRuntimePluginPackage({
        id: 'demo.config',
        packagesRoot,
        bundledPath,
      }),
    ).toThrow('derives the registration name "createDemoConfigPlugin"');
    expect(readFileSync(bundledPath, 'utf8')).toBe(bundledBefore);
  });

  it('stamps a scaffold whose descriptor passes both validators', () => {
    const packagesRoot = mkdtempSync(
      join(tmpdir(), 'project02-plugin-scaffold-'),
    );
    const bundledPath = join(packagesRoot, 'bundled.ts');

    copyFileSync(
      fileURLToPath(
        new URL('../../src/plugins/package-loader/bundled.ts', import.meta.url),
      ),
      bundledPath,
    );

    const {packageRoot} = scaffoldRuntimePluginPackage({
      id: 'sample.scaffold-check',
      packagesRoot,
      bundledPath,
    });
    const descriptor = JSON.parse(
      readFileSync(join(packageRoot, 'project02.plugin.json'), 'utf8'),
    ) as unknown;

    expect(
      validateAgainstSchema(descriptor),
      JSON.stringify(validateAgainstSchema.errors),
    ).toBe(true);
    expect(parseRuntimePluginPackageDescriptor(descriptor).status).toBe(
      'accepted',
    );
    for (const file of ['package.json', 'index.ts', 'plugin.ts']) {
      expect(existsSync(join(packageRoot, file))).toBe(true);
    }

    // A package the host never imports statically cannot load at runtime.
    const bundled = readFileSync(bundledPath, 'utf8');

    expect(bundled).toContain(
      "import {createProject02Plugin as createSampleScaffoldCheckPlugin} from '../packages/sample.scaffold-check/index.ts';",
    );
    expect(bundled).toContain(
      '      factory: createSampleScaffoldCheckPlugin,',
    );
    expect(() =>
      scaffoldRuntimePluginPackage({
        id: 'sample.scaffold-check',
        packagesRoot,
        bundledPath,
      }),
    ).toThrow('already exists');
    expect(() =>
      scaffoldRuntimePluginPackage({
        id: '9-bad-id',
        packagesRoot,
        bundledPath,
      }),
    ).toThrow('must start with a letter');
  });
});
