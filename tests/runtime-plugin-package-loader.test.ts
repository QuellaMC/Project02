import {
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRuntimePluginManifest } from '../src/plugins/manifest-validation.ts';
import {
  discoverRuntimePluginPackages,
  maxRuntimePluginPackageMetadataBytes
} from '../src/plugins/package-loader/index.ts';
import type { RuntimePluginManifest } from '../src/plugins/plugin-types.ts';
import { createTestTempRoot } from './support/temp-root.ts';

describe('runtime plugin package loader', () => {
  it('cold-discovers an immutable package without importing its entry', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.cold');

    writeTestPackage({
      root,
      manifest,
      entrySource: "throw new Error('entry imported during discovery');\n"
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.diagnostics).toEqual([]);
    expect(discovery.packages).toHaveLength(1);
    expect(discovery.packages[0]).toMatchObject({
      catalogKind: 'package',
      manifest: { id: manifest.id },
      provenance: 'operator'
    });
    expect(discovery.packages[0]?.load).toBeTypeOf('function');
    expect(Object.isFrozen(discovery)).toBe(true);
    expect(Object.isFrozen(discovery.packages)).toBe(true);
    expect(Object.isFrozen(discovery.packages[0])).toBe(true);
    expect(discovery.packages[0]).not.toHaveProperty('factory');
  });

  it('quarantines an invalid descriptor without hiding valid siblings', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const invalidManifest = testPluginManifest('memory.invalid');
    const validManifest = testPluginManifest('memory.valid');

    writeTestPackage({
      root,
      manifest: invalidManifest,
      entrySource: validEntrySource(),
      descriptorExtras: { unexpected: 'do-not-report-this-value' }
    });
    writeTestPackage({
      root,
      manifest: validManifest,
      entrySource: validEntrySource()
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages.map((item) => item.manifest.id)).toEqual([
      validManifest.id
    ]);
    expect(discovery.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'invalid_descriptor',
        message:
          'Runtime plugin package descriptor contains unknown field "unexpected".',
        path: join(root, invalidManifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: invalidManifest.id
      }
    ]);
    expect(JSON.stringify(discovery.diagnostics)).not.toContain(
      'do-not-report-this-value'
    );
  });

  it('bounds package metadata before parsing it', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.oversized');
    const packageRoot = join(root, manifest.id);

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource()
    });
    writeFileSync(
      join(packageRoot, 'project02.plugin.json'),
      JSON.stringify({ padding: 'x'.repeat(maxRuntimePluginPackageMetadataBytes) }),
      'utf8'
    );

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        message:
          'Runtime plugin package descriptor exceeds the metadata size limit.',
        pluginId: manifest.id
      })
    ]);
    expect(JSON.stringify(discovery.diagnostics)).not.toContain('xxxxx');
  });

  it('rejects non-regular metadata before attempting to read it', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.non-regular-metadata');
    const descriptorPath = join(
      root,
      manifest.id,
      'project02.plugin.json'
    );

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource()
    });
    unlinkSync(descriptorPath);
    mkdirSync(descriptorPath);

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        message:
          'Runtime plugin package descriptor must be a regular file.',
        pluginId: manifest.id
      })
    ]);
  });

  it('requires each package to declare the local ESM contract', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.commonjs');

    writeTestPackage({
      root,
      manifest,
      entry: './index.js',
      entrySource: validEntrySource(),
      packageType: 'commonjs'
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'bundled' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'invalid_package_json',
        message:
          'Runtime plugin package package.json must declare type "module".',
        path: join(root, manifest.id, 'package.json'),
        provenance: 'bundled',
        pluginId: manifest.id
      }
    ]);
  });

  it('accepts only the exact project02.plugin.v1 descriptor format', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.old-format');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
      descriptorFormat: 'project02.plugin.v0'
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        message:
          'Runtime plugin package format must be "project02.plugin.v1".',
        path: join(root, manifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: manifest.id
      })
    ]);
  });

  it('quarantines entries outside the supported package-local module boundary', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const escapingManifest = testPluginManifest('memory.escaping-entry');
    const unsupportedManifest = testPluginManifest('memory.unsupported-entry');

    writeTestPackage({
      root,
      manifest: escapingManifest,
      entry: '../outside.ts',
      entrySource: validEntrySource()
    });
    writeTestPackage({
      root,
      manifest: unsupportedManifest,
      entry: './index.cjs',
      entrySource: validEntrySource()
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_entry',
        message:
          'Runtime plugin package entry must stay inside its package directory.',
        path: join(root, escapingManifest.id, 'project02.plugin.json'),
        pluginId: escapingManifest.id
      }),
      expect.objectContaining({
        code: 'invalid_entry',
        message: 'Runtime plugin package entry must use .ts, .js, or .mjs.',
        path: join(root, unsupportedManifest.id, 'project02.plugin.json'),
        pluginId: unsupportedManifest.id
      })
    ]);
  });

  it.each([
    ['./index.cts', 'entry.cts'],
    ['./index.tsx', 'entry.tsx'],
    ['./index', 'entry.extensionless'],
    ['https://example.invalid/plugin.mjs', 'entry.url']
  ] as const)('rejects unsupported entry contract %s', (entry, pluginId) => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest(pluginId);

    writeTestPackage({
      root,
      manifest,
      entry,
      entrySource: validEntrySource(),
      skipEntryWrite: true
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_entry',
        pluginId
      })
    ]);
  });

  it('quarantines a descriptor whose entry file is missing', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.missing-entry');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
      removeEntryAfterWrite: true
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_entry',
        message:
          'Runtime plugin package entry must reference an existing file.',
        path: join(root, manifest.id, 'project02.plugin.json'),
        pluginId: manifest.id
      })
    ]);
  });

  it('preserves operator claims as metadata but excludes host-reserved ids', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const claimedManifest = testPluginManifest('operator.claims', {
      localTrustLevel: 'first_party',
      defaultEnabled: true
    });
    const reservedManifest = testPluginManifest('runtime.plugin', {
      localTrustLevel: 'first_party',
      defaultEnabled: true
    });

    writeTestPackage({
      root,
      manifest: claimedManifest,
      entrySource: validEntrySource()
    });
    writeTestPackage({
      root,
      manifest: reservedManifest,
      entrySource: validEntrySource()
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: new Set(['runtime.plugin'])
    });

    expect(discovery.packages).toHaveLength(1);
    expect(discovery.packages[0]).toMatchObject({
      provenance: 'operator',
      manifest: {
        id: claimedManifest.id,
        localTrustLevel: 'first_party',
        activation: { defaultEnabled: true }
      }
    });
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'reserved_plugin_id',
        message:
          'Operator runtime plugin package id "runtime.plugin" is reserved by the host.',
        path: join(root, reservedManifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: reservedManifest.id
      })
    ]);
  });

  it('lazily imports the named factory and normalizes its result', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.lazy');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource()
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error('Expected the package to be discovered.');
    }

    const plugin = await discoveredPackage.load({
      pluginId: manifest.id,
      manifest: discoveredPackage.manifest,
      storeRoot: root,
      resolvedConfig: {},
      redactedConfig: {}
    });

    expect(plugin).toMatchObject({
      manifest: { id: manifest.id },
      providedTools: [],
      lifecycleHooks: {}
    });
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.providedTools)).toBe(true);
    expect(Object.isFrozen(plugin.lifecycleHooks)).toBe(true);
  });

  it.each(['.ts', '.js', '.mjs'] as const)(
    'loads %s entries through the same package factory path',
    async (extension) => {
      const root = createTestTempRoot('project02-plugin-entry-format-');
      const manifest = testPluginManifest(
        `entry.${extension.slice(1)}`
      );

      writeTestPackage({
        root,
        manifest,
        entry: `./index${extension}`,
        entrySource: validEntrySource()
      });
      const discovery = discoverRuntimePluginPackages({
        sources: [{ root, provenance: 'operator' }],
        reservedPluginIds: []
      });
      const discoveredPackage = discovery.packages[0];

      expect(discovery.diagnostics).toEqual([]);
      expect(discoveredPackage).toBeDefined();
      if (discoveredPackage === undefined) {
        throw new Error(`Expected ${extension} package discovery.`);
      }

      await expect(
        discoveredPackage.load({
          pluginId: manifest.id,
          manifest: discoveredPackage.manifest,
          storeRoot: root,
          resolvedConfig: {},
          redactedConfig: {}
        })
      ).resolves.toMatchObject({ manifest: { id: manifest.id } });
    }
  );

  it('accepts semantically identical factory input with reordered manifest keys', async () => {
    const root = createTestTempRoot('project02-plugin-manifest-order-');
    const manifest = testPluginManifest('memory.reordered-manifest');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource()
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error('Expected the reordered-manifest package to be discovered.');
    }

    const reorderedManifest = Object.fromEntries(
      Object.entries(discoveredPackage.manifest).reverse()
    ) as RuntimePluginManifest;

    await expect(
      discoveredPackage.load({
        pluginId: manifest.id,
        manifest: reorderedManifest,
        storeRoot: root,
        resolvedConfig: {},
        redactedConfig: {}
      })
    ).resolves.toMatchObject({ manifest: { id: manifest.id } });
  });

  it('keeps one bundled package and quarantines an operator duplicate', () => {
    const parentRoot = createTestTempRoot('project02-plugin-packages-');
    const bundledRoot = join(parentRoot, 'bundled');
    const operatorRoot = join(parentRoot, 'operator');
    const manifest = testPluginManifest('memory.duplicate');

    writeTestPackage({
      root: bundledRoot,
      manifest,
      entrySource: validEntrySource()
    });
    writeTestPackage({
      root: operatorRoot,
      manifest,
      entrySource: validEntrySource()
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [
        { root: operatorRoot, provenance: 'operator' },
        { root: bundledRoot, provenance: 'bundled' }
      ],
      reservedPluginIds: []
    });

    expect(discovery.packages).toHaveLength(1);
    expect(discovery.packages[0]?.provenance).toBe('bundled');
    expect(discovery.packages[0]?.manifest.id).toBe(manifest.id);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'duplicate_plugin_id',
        path: join(operatorRoot, manifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: manifest.id
      })
    ]);
  });

  it('quarantines every conflicting operator duplicate instead of choosing by order', () => {
    const parentRoot = createTestTempRoot('project02-plugin-packages-');
    const firstRoot = join(parentRoot, 'first');
    const secondRoot = join(parentRoot, 'second');
    const manifest = testPluginManifest('memory.operator-duplicate');

    writeTestPackage({
      root: firstRoot,
      manifest,
      entrySource: validEntrySource()
    });
    writeTestPackage({
      root: secondRoot,
      manifest,
      entrySource: validEntrySource()
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [
        { root: firstRoot, provenance: 'operator' },
        { root: secondRoot, provenance: 'operator' }
      ],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toHaveLength(2);
    expect(
      discovery.diagnostics.every(
        (diagnostic) => diagnostic.code === 'duplicate_plugin_id'
      )
    ).toBe(true);
  });

  it('rejects a loaded module without the named package factory export', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.missing-factory');

    writeTestPackage({
      root,
      manifest,
      entrySource: 'export default function createProject02Plugin() {}\n'
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error('Expected the package to be discovered.');
    }

    await expect(
      discoveredPackage.load({
        pluginId: manifest.id,
        manifest: discoveredPackage.manifest,
        storeRoot: root,
        resolvedConfig: {},
        redactedConfig: {}
      })
    ).rejects.toThrow(
      `Runtime plugin package "${manifest.id}" must export exactly one named createProject02Plugin factory.`
    );
  });

  it('rejects extra entry-module exports outside the one factory contract', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.extra-export');

    writeTestPackage({
      root,
      manifest,
      entrySource: `${validEntrySource()}export const extra = true;\n`
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    await expect(instantiateOnlyPackage(discovery, root)).rejects.toThrow(
      `Runtime plugin package "${manifest.id}" must export exactly one named createProject02Plugin factory.`
    );
  });

  it('reports import failures without exposing the entry exception', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.import-failure');

    writeTestPackage({
      root,
      manifest,
      entrySource: "throw new Error('private import detail');\n"
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });
    const error = await instantiateOnlyPackage(discovery, root).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      `Runtime plugin package "${manifest.id}" entry could not be imported.`
    );
    expect(String(error)).not.toContain('private import detail');
  });

  it('reports factory failures without exposing resolved config secrets', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.factory-failure');
    const secret = 'resolved-secret-must-not-escape';

    writeTestPackage({
      root,
      manifest,
      entrySource: [
        'export function createProject02Plugin(input) {',
        "  throw new Error(input.resolvedConfig.apiKey.value);",
        '}',
        ''
      ].join('\n')
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error('Expected the package to be discovered.');
    }

    const error = await Promise.resolve(discoveredPackage.load({
      pluginId: manifest.id,
      manifest: discoveredPackage.manifest,
      storeRoot: root,
      resolvedConfig: {
        apiKey: {
          name: 'apiKey',
          secret: true,
          source: 'env:PLUGIN_SECRET',
          resolved: true,
          value: secret
        }
      },
      redactedConfig: {
        apiKey: {
          name: 'apiKey',
          secret: true,
          source: 'env:PLUGIN_SECRET',
          resolved: true,
          value: '[redacted]'
        }
      }
    })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      `Runtime plugin package "${manifest.id}" factory failed during construction.`
    );
    expect(String(error)).not.toContain(secret);
  });

  it('sanitizes exceptions from factory-output accessors', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.output-accessor-failure');
    const secret = 'accessor-secret-must-not-escape';

    writeTestPackage({
      root,
      manifest,
      entrySource: [
        'export function createProject02Plugin(input) {',
        '  const output = { manifest: input.manifest, lifecycleHooks: {} };',
        "  Object.defineProperty(output, 'providedTools', {",
        "    get() { throw new Error(input.resolvedConfig.apiKey.value); }",
        '  });',
        '  return output;',
        '}',
        ''
      ].join('\n')
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error('Expected the package to be discovered.');
    }

    const error = await Promise.resolve(discoveredPackage.load({
      pluginId: manifest.id,
      manifest: discoveredPackage.manifest,
      storeRoot: root,
      resolvedConfig: {
        apiKey: {
          name: 'apiKey',
          secret: true,
          source: 'env:PLUGIN_SECRET',
          resolved: true,
          value: secret
        }
      },
      redactedConfig: {
        apiKey: {
          name: 'apiKey',
          secret: true,
          source: 'env:PLUGIN_SECRET',
          resolved: true,
          value: '[redacted]'
        }
      }
    })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      `Runtime plugin package "${manifest.id}" factory returned an invalid plugin definition.`
    );
    expect(String(error)).not.toContain(secret);
  });

  it('rejects invalid factory output and cold-manifest drift', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const invalidManifest = testPluginManifest('memory.invalid-output');
    const driftManifest = testPluginManifest('memory.manifest-drift');

    writeTestPackage({
      root,
      manifest: invalidManifest,
      entrySource: [
        'export function createProject02Plugin() {',
        '  return { manifest: {}, providedTools: [] };',
        '}',
        ''
      ].join('\n')
    });
    const invalidDiscovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    await expect(
      instantiatePackageById(invalidDiscovery, invalidManifest.id, root)
    ).rejects.toThrow('factory returned an invalid plugin definition');

    writeTestPackage({
      root,
      manifest: driftManifest,
      entrySource: [
        'export function createProject02Plugin(input) {',
        "  return { manifest: { ...input.manifest, displayName: 'Drifted' }, providedTools: [], lifecycleHooks: {} };",
        '}',
        ''
      ].join('\n')
    });
    const driftDiscovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    await expect(
      instantiatePackageById(driftDiscovery, driftManifest.id, root)
    ).rejects.toThrow('factory returned a different manifest');
  });

  it('diagnoses package-directory and entry symbolic links', () => {
    const parentRoot = createTestTempRoot('project02-plugin-packages-');
    const root = join(parentRoot, 'source');
    const directoryPluginId = 'memory.directory-symlink';
    const directoryTarget = join(parentRoot, 'directory-target');
    const entryManifest = testPluginManifest('memory.entry-symlink');
    const metadataManifest = testPluginManifest('memory.metadata-symlink');
    const metadataTarget = join(parentRoot, 'descriptor-target.json');

    mkdirSync(root, { recursive: true });
    mkdirSync(directoryTarget, { recursive: true });
    symlinkSync(directoryTarget, join(root, directoryPluginId), 'dir');
    writeTestPackage({
      root,
      manifest: entryManifest,
      entrySource: validEntrySource()
    });
    const entryPackageRoot = join(root, entryManifest.id);

    writeFileSync(
      join(entryPackageRoot, 'target.ts'),
      validEntrySource(),
      'utf8'
    );
    unlinkSync(join(entryPackageRoot, 'index.ts'));
    symlinkSync('target.ts', join(entryPackageRoot, 'index.ts'));
    writeTestPackage({
      root,
      manifest: metadataManifest,
      entrySource: validEntrySource()
    });
    writeFileSync(metadataTarget, '{}\n', 'utf8');
    const metadataPath = join(
      root,
      metadataManifest.id,
      'project02.plugin.json'
    );

    unlinkSync(metadataPath);
    symlinkSync(metadataTarget, metadataPath);

    const discovery = discoverRuntimePluginPackages({
      sources: [{ root, provenance: 'operator' }],
      reservedPluginIds: []
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_package_directory',
        message:
          'Runtime plugin package directories must not be symbolic links.',
        path: join(root, directoryPluginId),
        pluginId: directoryPluginId
      }),
      expect.objectContaining({
        code: 'invalid_entry',
        message: 'Runtime plugin package entry must not be a symbolic link.',
        path: join(root, entryManifest.id, 'project02.plugin.json'),
        pluginId: entryManifest.id
      }),
      expect.objectContaining({
        code: 'invalid_descriptor',
        message:
          'Runtime plugin package descriptor must not be a symbolic link.',
        path: metadataPath,
        pluginId: metadataManifest.id
      })
    ]);
  });
});

function writeTestPackage(options: {
  readonly root: string;
  readonly manifest: RuntimePluginManifest;
  readonly entry?: string;
  readonly entrySource: string;
  readonly descriptorExtras?: Readonly<Record<string, unknown>>;
  readonly descriptorFormat?: string;
  readonly packageType?: string;
  readonly removeEntryAfterWrite?: boolean;
  readonly skipEntryWrite?: boolean;
}): void {
  const packageRoot = join(options.root, options.manifest.id);
  const entry = options.entry ?? './index.ts';

  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ type: options.packageType ?? 'module' })}\n`,
    'utf8'
  );
  writeFileSync(
    join(packageRoot, 'project02.plugin.json'),
    `${JSON.stringify({
      format: options.descriptorFormat ?? 'project02.plugin.v1',
      entry,
      manifest: options.manifest,
      ...options.descriptorExtras
    })}\n`,
    'utf8'
  );
  if (options.skipEntryWrite === true) {
    return;
  }

  const entryPath = resolvePackageEntry(packageRoot, entry);

  writeFileSync(entryPath, options.entrySource, 'utf8');
  if (options.removeEntryAfterWrite === true) {
    unlinkSync(entryPath);
  }
}

function resolvePackageEntry(packageRoot: string, entry: string): string {
  return join(packageRoot, entry);
}

function validEntrySource(): string {
  return [
    'export function createProject02Plugin(input) {',
    '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
    '}',
    ''
  ].join('\n');
}

function instantiateOnlyPackage(
  discovery: ReturnType<typeof discoverRuntimePluginPackages>,
  storeRoot: string
) {
  const discoveredPackage = discovery.packages[0];

  if (discoveredPackage === undefined) {
    throw new Error('Expected one discovered package.');
  }

  return instantiatePackage(discoveredPackage, storeRoot);
}

function instantiatePackageById(
  discovery: ReturnType<typeof discoverRuntimePluginPackages>,
  pluginId: string,
  storeRoot: string
) {
  const discoveredPackage = discovery.packages.find(
    (item) => item.manifest.id === pluginId
  );

  if (discoveredPackage === undefined) {
    throw new Error(`Expected discovered package "${pluginId}".`);
  }

  return instantiatePackage(discoveredPackage, storeRoot);
}

async function instantiatePackage(
  discoveredPackage: ReturnType<
    typeof discoverRuntimePluginPackages
  >['packages'][number],
  storeRoot: string
) {
  return await discoveredPackage.load({
    pluginId: discoveredPackage.manifest.id,
    manifest: discoveredPackage.manifest,
    storeRoot,
    resolvedConfig: {},
    redactedConfig: {}
  });
}

function testPluginManifest(
  id: string,
  options: {
    readonly localTrustLevel?: RuntimePluginManifest['localTrustLevel'];
    readonly defaultEnabled?: boolean;
  } = {}
): RuntimePluginManifest {
  return createRuntimePluginManifest({
    id,
    displayName: `Test ${id}`,
    version: '1.0.0',
    kind: 'memory_provider',
    description: 'Test runtime plugin package.',
    contractVersion: 'mvp-008.runtime_plugin.v2',
    compatibility: {
      hostContractVersions: ['mvp-008.runtime_plugin.v2']
    },
    declaredPlugins: ['plugin_discovery'],
    config: { fields: [] },
    localTrustLevel: options.localTrustLevel ?? 'trusted_adapter',
    runtimePolicy: {
      requiredForTurn: false,
      sideEffectLevel: 'none',
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: false,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        afterTurnCommitted: 'log_failure',
        health: 'degrade'
      }
    },
    activation: {
      defaultEnabled: options.defaultEnabled ?? false,
      reasons: ['test_package']
    },
    requestedAccess: {}
  });
}
