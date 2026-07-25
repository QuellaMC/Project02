import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {Ajv} from 'ajv';
import {describe, expect, it} from 'vitest';

import {scaffoldRuntimePluginPackage} from '../../scripts/create-plugin.mjs';

import {
  parseRuntimePluginPackageDescriptor,
  readRuntimePluginPackageDescriptor,
} from '../../src/plugins/api/package-descriptor.ts';
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

  it('accepts a legacy descriptor without a config scope', () => {
    const descriptor = validDescriptor();
    const manifest = descriptor['manifest'] as Record<string, unknown>;
    const config = {...(manifest['config'] as Record<string, unknown>)};

    delete config['scope'];

    const legacy = {...descriptor, manifest: {...manifest, config}};

    // New descriptors must state the field, so the published schema still
    // requires it...
    expect(validateAgainstSchema(legacy)).toBe(false);

    // ...but a package authored before the field existed is already installed,
    // and its previous semantics were global with per-character overrides. It
    // has to keep loading rather than blocking startup.
    const parsed = parseRuntimePluginPackageDescriptor(legacy);

    expect(parsed.status).toBe('accepted');
    expect(
      parsed.status === 'accepted'
        ? parsed.descriptor.manifest.config.scope
        : undefined,
    ).toBe('global_with_character_overrides');
  });

  it('allows and ignores the $schema key in both validators', () => {
    const descriptor = validDescriptor();

    expect(typeof descriptor['$schema']).toBe('string');
    const parsed = parseRuntimePluginPackageDescriptor(descriptor);

    expect(parsed.status).toBe('accepted');
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

  it('stamps a scaffold whose descriptor passes both validators', () => {
    const packagesRoot = mkdtempSync(
      join(tmpdir(), 'project02-plugin-scaffold-'),
    );
    const {packageRoot} = scaffoldRuntimePluginPackage({
      id: 'sample.scaffold-check',
      packagesRoot,
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
    expect(() =>
      scaffoldRuntimePluginPackage({id: 'sample.scaffold-check', packagesRoot}),
    ).toThrow('already exists');
    expect(() =>
      scaffoldRuntimePluginPackage({id: '9-bad-id', packagesRoot}),
    ).toThrow('must start with a letter');
  });
});
