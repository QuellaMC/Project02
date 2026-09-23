import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeCrypto from 'node:crypto';
import type * as NodeFs from 'node:fs';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {createRuntimePluginManifest} from '../../src/plugins/api/manifest-validation.ts';
import {
  bundledRuntimePluginPackageRoot,
  discoverRuntimePluginPackages,
  maxRuntimePluginPackageMetadataBytes,
} from '../../src/plugins/package-loader/index.ts';
import {
  activateRuntimePluginPackageArtifact,
  captureRuntimePluginPackageArtifact,
} from '../../src/plugins/package-loader/artifact.ts';
import {
  PackageCaptureError,
  planPackageDirectoryCapture,
  readPlannedPackageFile,
} from '../../src/shared/package-capture.ts';
import {snapshotPackageDirectory} from '../../src/shared/package-metadata.ts';
import {createDemoConfigPluginManifest} from '../../src/plugins/packages/demo-config/plugin.ts';
import type {
  RuntimePlugin,
  RuntimePluginManifest,
} from '../../src/plugins/api/types.ts';
import {agePackageSourceRoot} from '../support/package-source-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:crypto');
  vi.resetModules();
});

describe('runtime plugin package loader', () => {
  it('discovers a package without reading its module bytes', async () => {
    const root = createTestTempRoot('project02-plugin-lazy-bytes-');
    const manifest = testPluginManifest('memory.lazy-bytes');

    writeTestPackage({
      root,
      manifest,
      entry: './index.mjs',
      entrySource: 'export const createProject02Plugin = () => {};\n',
    });
    const packageRoot = join(root, manifest.id);
    const opened: string[] = [];

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        openSync(path: NodeFs.PathLike, ...rest: readonly unknown[]): number {
          opened.push(String(path));

          return Reflect.apply(actual.openSync, actual, [
            path,
            ...rest,
          ]) as number;
        },
      };
    });
    const {discoverRuntimePluginPackages: discover} =
      await import('../../src/plugins/package-loader/index.ts');
    const discovery = discover({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.diagnostics).toEqual([]);
    // Module bytes wait for an import that may never happen.
    expect(opened.filter(path => path.startsWith(packageRoot)).sort()).toEqual([
      join(packageRoot, 'package.json'),
      join(packageRoot, 'project02.plugin.json'),
    ]);
  });

  it('frames artifact paths and bytes without NUL-delimiter collisions', () => {
    const root = createTestTempRoot('project02-plugin-artifact-id-');
    const packageRoot = join(root, 'collision');
    const firstPath = join(packageRoot, 'a');

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(firstPath, Buffer.from('x\0b\0y'));
    const firstDirectory = snapshotPackageDirectory(packageRoot);

    if (firstDirectory === undefined) {
      throw new Error('Expected first package directory snapshot.');
    }
    const first = captureRuntimePluginPackageArtifact({
      packageDirectory: firstDirectory,
      provenance: 'operator',
    });

    writeFileSync(firstPath, 'x');
    writeFileSync(join(packageRoot, 'b'), 'y');
    const secondDirectory = snapshotPackageDirectory(packageRoot);

    if (secondDirectory === undefined) {
      throw new Error('Expected second package directory snapshot.');
    }
    const second = captureRuntimePluginPackageArtifact({
      packageDirectory: secondDirectory,
      provenance: 'operator',
    });

    expect(second.id).not.toBe(first.id);
    activateRuntimePluginPackageArtifact({
      artifact: first,
      entryRelativePath: 'a',
    });
    expect(() =>
      activateRuntimePluginPackageArtifact({
        artifact: Object.freeze({...second, id: first.id}),
        entryRelativePath: 'a',
      }),
    ).toThrow('identifier collision');
  });

  it('includes empty directories in the framed artifact identity', () => {
    const root = createTestTempRoot('project02-plugin-artifact-directory-');
    const packageRoot = join(root, 'directory-identity');

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(join(packageRoot, 'index.mjs'), 'export {};\n');
    const firstDirectory = snapshotPackageDirectory(packageRoot);

    if (firstDirectory === undefined) {
      throw new Error('Expected first package directory snapshot.');
    }
    const first = captureRuntimePluginPackageArtifact({
      packageDirectory: firstDirectory,
      provenance: 'operator',
    });

    mkdirSync(join(packageRoot, 'empty'));
    const secondDirectory = snapshotPackageDirectory(packageRoot);

    if (secondDirectory === undefined) {
      throw new Error('Expected second package directory snapshot.');
    }
    const second = captureRuntimePluginPackageArtifact({
      packageDirectory: secondDirectory,
      provenance: 'operator',
    });

    expect(second.id).not.toBe(first.id);
  });

  it('enforces descriptor byte limits at the physical capture boundary', () => {
    const root = createTestTempRoot('project02-plugin-artifact-limit-');
    const packageRoot = join(root, 'bounded');
    const descriptorRelativePath = 'project02.plugin.json';

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(join(packageRoot, descriptorRelativePath), Buffer.alloc(33));
    const packageDirectory = snapshotPackageDirectory(packageRoot);

    if (packageDirectory === undefined) {
      throw new Error('Expected package directory snapshot.');
    }

    expect(() =>
      planPackageDirectoryCapture({
        packageDirectory,
        maxFiles: 10,
        maxBytes: 1_024,
        fileByteLimits: new Map([[descriptorRelativePath, 32]]),
      }),
    ).toThrow(
      expect.objectContaining({
        name: PackageCaptureError.name,
        reason: 'too_large',
      }),
    );
  });

  it('counts directories against the capture budget', () => {
    const root = createTestTempRoot('project02-plugin-artifact-dirs-');
    const packageRoot = join(root, 'wide');

    mkdirSync(packageRoot, {recursive: true});
    // Empty directories are neither bytes nor files, so counting only files let
    // a package traverse without limit.
    for (let index = 0; index < 6; index += 1) {
      mkdirSync(join(packageRoot, `d${String(index)}`));
    }
    const packageDirectory = snapshotPackageDirectory(packageRoot);

    if (packageDirectory === undefined) {
      throw new Error('Expected package directory snapshot.');
    }

    expect(() =>
      planPackageDirectoryCapture({
        packageDirectory,
        maxFiles: 4,
        maxBytes: 1_024,
      }),
    ).toThrow(
      expect.objectContaining({
        name: PackageCaptureError.name,
        reason: 'too_large',
      }),
    );
  });

  it('bounds a deferred read by the limit its walk resolved', () => {
    const root = createTestTempRoot('project02-plugin-lazy-limit-');
    const packageRoot = join(root, 'bounded');
    const descriptorRelativePath = 'project02.plugin.json';
    const descriptorPath = join(packageRoot, descriptorRelativePath);

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(descriptorPath, Buffer.alloc(16));
    const packageDirectory = snapshotPackageDirectory(packageRoot);

    if (packageDirectory === undefined) {
      throw new Error('Expected package directory snapshot.');
    }
    const planned = planPackageDirectoryCapture({
      packageDirectory,
      maxFiles: 10,
      maxBytes: 1_024,
      fileByteLimits: new Map([[descriptorRelativePath, 32]]),
    });
    const file = planned.files.get(descriptorRelativePath);

    if (file === undefined) {
      throw new Error('Expected the descriptor to be planned.');
    }
    // Growing past the limit after the walk leaves the plan's bound as the only
    // thing that can refuse the read.
    writeFileSync(descriptorPath, Buffer.alloc(64));

    expect(() => readPlannedPackageFile({packageDirectory, file})).toThrow(
      expect.objectContaining({
        name: PackageCaptureError.name,
        reason: 'too_large',
      }),
    );
    writeFileSync(descriptorPath, Buffer.alloc(24));
    expect(readPlannedPackageFile({packageDirectory, file})).toHaveLength(24);
  });

  it('bounds how deep a captured package may nest', () => {
    const root = createTestTempRoot('project02-plugin-artifact-deep-');
    const packageRoot = join(root, 'deep');
    // Some filesystems reject a long path first, and the bound must not depend
    // on that.
    const nested = join(packageRoot, ...Array.from({length: 70}, () => 'n'));

    mkdirSync(nested, {recursive: true});
    const packageDirectory = snapshotPackageDirectory(packageRoot);

    if (packageDirectory === undefined) {
      throw new Error('Expected package directory snapshot.');
    }

    expect(() =>
      planPackageDirectoryCapture({
        packageDirectory,
        maxFiles: 2_048,
        maxBytes: 1_024,
      }),
    ).toThrow(
      expect.objectContaining({
        name: PackageCaptureError.name,
        reason: 'too_large',
      }),
    );
  });

  it('cold-discovers an immutable package without importing its entry', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.cold');

    writeTestPackage({
      root,
      manifest,
      entrySource: "throw new Error('entry imported during discovery');\n",
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.diagnostics).toEqual([]);
    expect(discovery.packages).toHaveLength(1);
    expect(discovery.packages[0]).toMatchObject({
      catalogKind: 'package',
      manifest: {id: manifest.id},
      provenance: 'operator',
    });
    expect(discovery.packages[0]?.load).toBeTypeOf('function');
    expect(Object.isFrozen(discovery)).toBe(true);
    expect(Object.isFrozen(discovery.packages)).toBe(true);
    expect(Object.isFrozen(discovery.packages[0])).toBe(true);
    expect(discovery.packages[0]).not.toHaveProperty('factory');
  });

  it('rejects a package replaced by a symbolic link after source enumeration', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-root-swap-');
    const sourceRoot = join(parentRoot, 'source');
    const externalRoot = join(parentRoot, 'external');
    const manifest = testPluginManifest('memory.root-swap');

    writeTestPackage({
      root: sourceRoot,
      manifest,
      entrySource: validEntrySource(),
    });
    writeTestPackage({
      root: externalRoot,
      manifest,
      entrySource: validEntrySource(),
    });
    const packageRoot = join(sourceRoot, manifest.id);
    const externalPackageRoot = join(externalRoot, manifest.id);
    const parkedPackageRoot = join(parentRoot, 'parked');
    let swapped = false;

    agePackageSourceRoot(sourceRoot);

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
            symlinkSync(externalPackageRoot, packageRoot, 'dir');
          }

          return entries;
        },
      };
    });
    const {discoverRuntimePluginPackages: discoverAfterEnumeration} =
      await import('../../src/plugins/package-loader/index.ts');

    const discovery = discoverAfterEnumeration({
      sources: [{root: sourceRoot}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'package_source_changed',
        path: sourceRoot,
      }),
    ]);
  });

  it('rejects a source root replaced after enumeration', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-source-swap-');
    const sourceRoot = join(parentRoot, 'source');
    const externalRoot = join(parentRoot, 'external');
    const parkedSourceRoot = join(parentRoot, 'parked-source');
    const manifest = testPluginManifest('memory.source-swap');

    writeTestPackage({
      root: sourceRoot,
      manifest,
      entrySource: validEntrySource(),
    });
    writeTestPackage({
      root: externalRoot,
      manifest,
      entrySource: validEntrySource(),
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
            symlinkSync(externalRoot, sourceRoot, 'dir');
          }

          return entries;
        },
      };
    });
    const {discoverRuntimePluginPackages: discoverAfterEnumeration} =
      await import('../../src/plugins/package-loader/index.ts');

    const discovery = discoverAfterEnumeration({
      sources: [{root: sourceRoot}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'package_source_changed',
        path: sourceRoot,
      }),
    ]);
  });

  it('rejects an outside artifact captured through an ancestor ABA swap', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-ancestor-aba-');
    const boundAncestor = join(parentRoot, 'bound');
    const externalAncestor = join(parentRoot, 'external');
    const parkedAncestor = join(parentRoot, 'parked');
    const sourceRoot = join(boundAncestor, 'source');
    const externalSourceRoot = join(externalAncestor, 'source');
    const manifest = testPluginManifest('memory.ancestor-aba');

    writeTestPackage({
      root: sourceRoot,
      manifest,
      entrySource: validEntrySource(),
    });
    writeTestPackage({
      root: externalSourceRoot,
      manifest,
      entrySource: validEntrySource(),
    });
    let swapped = false;
    let restored = false;

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
      };
    });
    vi.doMock('node:crypto', async () => {
      const actual = await vi.importActual<typeof NodeCrypto>('node:crypto');

      return {
        ...actual,
        createHash(
          algorithm: string,
          options?: NodeCrypto.HashOptions,
        ): NodeCrypto.Hash {
          const hash = actual.createHash(algorithm, options);
          const digestBuffer: () => Buffer = hash.digest.bind(hash);
          const digestText: (
            encoding: NodeCrypto.BinaryToTextEncoding,
          ) => string = hash.digest.bind(hash);

          Object.defineProperty(hash, 'digest', {
            value(encoding?: NodeCrypto.BinaryToTextEncoding): Buffer | string {
              if (swapped && !restored) {
                renameSync(boundAncestor, externalAncestor);
                renameSync(parkedAncestor, boundAncestor);
                restored = true;
              }
              return encoding === undefined
                ? digestBuffer()
                : digestText(encoding);
            },
          });
          return hash;
        },
      };
    });
    const {discoverRuntimePluginPackages: discoverDuringAncestorSwap} =
      await import('../../src/plugins/package-loader/index.ts');

    const discovery = discoverDuringAncestorSwap({
      sources: [{root: sourceRoot}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'package_source_changed',
        path: sourceRoot,
      }),
    ]);
  });

  it('quarantines an invalid descriptor without hiding valid siblings', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const invalidManifest = testPluginManifest('memory.invalid');
    const validManifest = testPluginManifest('memory.valid');

    writeTestPackage({
      root,
      manifest: invalidManifest,
      entrySource: validEntrySource(),
      descriptorExtras: {unexpected: 'do-not-report-this-value'},
    });
    writeTestPackage({
      root,
      manifest: validManifest,
      entrySource: validEntrySource(),
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages.map(item => item.manifest.id)).toEqual([
      validManifest.id,
    ]);
    expect(discovery.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'invalid_descriptor',
        message:
          'Runtime plugin package descriptor contains unknown field "unexpected".',
        path: join(root, invalidManifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: invalidManifest.id,
      },
    ]);
    expect(JSON.stringify(discovery.diagnostics)).not.toContain(
      'do-not-report-this-value',
    );
  });

  it('bounds package metadata before parsing it', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.oversized');
    const packageRoot = join(root, manifest.id);

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    writeFileSync(
      join(packageRoot, 'project02.plugin.json'),
      JSON.stringify({
        padding: 'x'.repeat(maxRuntimePluginPackageMetadataBytes),
      }),
      'utf8',
    );

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        message:
          'Runtime plugin package descriptor exceeds the metadata size limit.',
        pluginId: manifest.id,
      }),
    ]);
    expect(JSON.stringify(discovery.diagnostics)).not.toContain('xxxxx');
  });

  it('keeps an opened descriptor read bounded if the file grows', async () => {
    const root = createTestTempRoot('project02-plugin-metadata-growth-');
    const manifest = testPluginManifest('memory.metadata-growth');
    const descriptorPath = join(root, manifest.id, 'project02.plugin.json');
    let descriptor: number | undefined;
    let descriptorGrew = false;
    const descriptorReadLengths: number[] = [];

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    const canonicalDescriptorPath = realpathSync(descriptorPath);

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        openSync(
          path: NodeFs.PathLike,
          flags: string | number,
          mode?: NodeFs.Mode,
        ) {
          const opened =
            mode === undefined
              ? actual.openSync(path, flags)
              : actual.openSync(path, flags, mode);

          if (path === canonicalDescriptorPath) {
            descriptor = opened;
          }
          return opened;
        },
        fstatSync(fileDescriptor: number, ...args: unknown[]) {
          const stat = Reflect.apply(actual.fstatSync, actual, [
            fileDescriptor,
            ...args,
          ]) as unknown;

          if (fileDescriptor === descriptor && !descriptorGrew) {
            descriptorGrew = true;
            actual.writeFileSync(
              canonicalDescriptorPath,
              'x'.repeat(maxRuntimePluginPackageMetadataBytes + 1),
            );
          }
          return stat;
        },
        readSync(
          fileDescriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: NodeFs.ReadPosition | null,
        ) {
          if (fileDescriptor === descriptor) {
            descriptorReadLengths.push(length);
          }
          return Reflect.apply(actual.readSync, actual, [
            fileDescriptor,
            buffer,
            offset,
            length,
            position,
          ]) as number;
        },
      };
    });
    const {discoverRuntimePluginPackages: discoverAfterGrowth} =
      await import('../../src/plugins/package-loader/index.ts');

    const discovery = discoverAfterGrowth({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(descriptorReadLengths.length).toBeGreaterThan(0);
    expect(
      descriptorReadLengths.every(
        length => length <= maxRuntimePluginPackageMetadataBytes,
      ),
    ).toBe(true);
  });

  it('rejects non-regular metadata before attempting to read it', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.non-regular-metadata');
    const descriptorPath = join(root, manifest.id, 'project02.plugin.json');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    unlinkSync(descriptorPath);
    mkdirSync(descriptorPath);

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        message: 'Runtime plugin package descriptor must be a regular file.',
        pluginId: manifest.id,
      }),
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
      packageType: 'commonjs',
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'invalid_package_json',
        message:
          'Runtime plugin package package.json must declare type "module".',
        path: join(root, manifest.id, 'package.json'),
        provenance: 'operator',
        pluginId: manifest.id,
      },
    ]);
  });

  it('accepts only the exact project02.plugin.v1 descriptor format', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.old-format');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
      descriptorFormat: 'project02.plugin.v0',
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_descriptor',
        message: 'Runtime plugin package format must be "project02.plugin.v1".',
        path: join(root, manifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: manifest.id,
      }),
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
      entrySource: validEntrySource(),
    });
    writeTestPackage({
      root,
      manifest: unsupportedManifest,
      entry: './index.cjs',
      entrySource: validEntrySource(),
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_entry',
        message:
          'Runtime plugin package entry must stay inside its package directory.',
        path: join(root, escapingManifest.id, 'project02.plugin.json'),
        pluginId: escapingManifest.id,
      }),
      expect.objectContaining({
        code: 'invalid_entry',
        message: 'Runtime plugin package entry must use .ts, .js, or .mjs.',
        path: join(root, unsupportedManifest.id, 'project02.plugin.json'),
        pluginId: unsupportedManifest.id,
      }),
    ]);
  });

  it.each([
    ['./index.cts', 'entry.cts'],
    ['./index.tsx', 'entry.tsx'],
    ['./index', 'entry.extensionless'],
    ['https://example.invalid/plugin.mjs', 'entry.url'],
  ] as const)('rejects unsupported entry contract %s', (entry, pluginId) => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest(pluginId);

    writeTestPackage({
      root,
      manifest,
      entry,
      entrySource: validEntrySource(),
      skipEntryWrite: true,
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_entry',
        pluginId,
      }),
    ]);
  });

  it('quarantines a descriptor whose entry file is missing', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.missing-entry');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
      removeEntryAfterWrite: true,
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_entry',
        message:
          'Runtime plugin package entry must reference an existing file.',
        path: join(root, manifest.id, 'project02.plugin.json'),
        pluginId: manifest.id,
      }),
    ]);
  });

  it('preserves operator claims as metadata but excludes host-reserved ids', () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const claimedManifest = testPluginManifest('operator.claims', {
      firstParty: true,
      defaultEnabled: true,
    });
    const reservedManifest = testPluginManifest('runtime.plugin', {
      firstParty: true,
      defaultEnabled: true,
    });

    writeTestPackage({
      root,
      manifest: claimedManifest,
      entrySource: validEntrySource(),
    });
    writeTestPackage({
      root,
      manifest: reservedManifest,
      entrySource: validEntrySource(),
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: new Set(['runtime.plugin']),
    });

    expect(discovery.packages).toHaveLength(1);
    expect(discovery.packages[0]).toMatchObject({
      provenance: 'operator',
      manifest: {
        id: claimedManifest.id,
        firstParty: true,
        activation: {defaultEnabled: true},
      },
    });
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'reserved_plugin_id',
        message:
          'Operator runtime plugin package id "runtime.plugin" is reserved by the host.',
        path: join(root, reservedManifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: reservedManifest.id,
      }),
    ]);
  });

  it('lazily imports the named factory and normalizes its result', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.lazy');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
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
      redactedConfig: {},
    });

    expect(plugin).toMatchObject({
      manifest: {id: manifest.id},
      providedTools: [],
      lifecycleHooks: {},
    });
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.providedTools)).toBe(true);
    expect(Object.isFrozen(plugin.lifecycleHooks)).toBe(true);
  });

  it('refuses an entry repointed outside its package after discovery', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-entry-swap-');
    const root = join(parentRoot, 'source');
    const manifest = testPluginManifest('memory.entry-swap');
    const markerPath = join(parentRoot, 'outside-imported');
    const outsideEntryPath = join(parentRoot, 'outside.ts');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });
    const entryPath = join(root, manifest.id, 'index.ts');

    writeFileSync(
      outsideEntryPath,
      [
        "import {writeFileSync} from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'executed\\n', 'utf8');`,
        validEntrySource(),
      ].join('\n'),
      'utf8',
    );
    unlinkSync(entryPath);
    symlinkSync(outsideEntryPath, entryPath);

    await expect(instantiateOnlyPackage(discovery, root)).rejects.toThrow(
      'entry could not be imported',
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it('loads the discovered artifact after its package directory is replaced', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-package-swap-');
    const root = join(parentRoot, 'source');
    const manifest = testPluginManifest('memory.package-swap');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });
    const packageRoot = join(root, manifest.id);

    renameSync(packageRoot, join(parentRoot, 'parked'));
    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });

    await expect(
      instantiateOnlyPackage(discovery, root),
    ).resolves.toMatchObject({
      manifest: {id: manifest.id},
    });
  });

  it('loads the discovered artifact after descriptor source drift', async () => {
    const root = createTestTempRoot('project02-plugin-descriptor-drift-');
    const manifest = testPluginManifest('memory.descriptor-drift');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    writeFileSync(
      join(root, manifest.id, 'project02.plugin.json'),
      `${JSON.stringify({
        format: 'project02.plugin.v1',
        entry: './index.ts',
        manifest: {...manifest, displayName: 'Changed after discovery'},
      })}\n`,
      'utf8',
    );

    await expect(
      instantiateOnlyPackage(discovery, root),
    ).resolves.toMatchObject({
      manifest: {id: manifest.id},
    });
  });

  it('loads transitive modules from the discovered artifact', async () => {
    const root = createTestTempRoot('project02-plugin-module-graph-');
    const manifest = testPluginManifest('memory.module-graph');

    writeTestPackage({
      root,
      manifest,
      entry: './index.mjs',
      entrySource: [
        "import {createPlugin} from './helper.mjs';",
        'export const createProject02Plugin = createPlugin;',
        '',
      ].join('\n'),
    });
    writeFileSync(
      join(root, manifest.id, 'helper.mjs'),
      [
        'export function createPlugin(input) {',
        '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    await expect(
      instantiateOnlyPackage(discovery, root),
    ).resolves.toMatchObject({
      manifest: {id: manifest.id},
    });
  });

  it('loads module bytes as they are on disk at load', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-module-edit-');
    const root = join(parentRoot, 'source');
    const manifest = testPluginManifest('memory.module-edit');
    const markerPath = join(parentRoot, 'changed-helper-imported');

    writeTestPackage({
      root,
      manifest,
      entry: './index.mjs',
      entrySource: [
        "import {createPlugin} from './helper.mjs';",
        'export const createProject02Plugin = createPlugin;',
        '',
      ].join('\n'),
    });
    const helperPath = join(root, manifest.id, 'helper.mjs');

    writeFileSync(
      helperPath,
      [
        'export function createPlugin(input) {',
        '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    writeFileSync(
      helperPath,
      [
        "import {writeFileSync} from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'executed\\n', 'utf8');`,
        'export function createPlugin(input) {',
        '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(
      instantiateOnlyPackage(discovery, root),
    ).resolves.toMatchObject({
      manifest: {id: manifest.id},
    });
    expect(existsSync(markerPath)).toBe(true);
  });

  it('rejects a transitive module format outside the package contract', async () => {
    const root = createTestTempRoot('project02-plugin-module-format-');
    const manifest = testPluginManifest('memory.module-format');

    writeTestPackage({
      root,
      manifest,
      entry: './index.mjs',
      entrySource: [
        "import {createPlugin} from './helper.mts';",
        'export const createProject02Plugin = createPlugin;',
        '',
      ].join('\n'),
    });
    writeFileSync(
      join(root, manifest.id, 'helper.mts'),
      [
        'export const createPlugin = input => ({',
        '  manifest: input.manifest, providedTools: [], lifecycleHooks: {}',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    await expect(instantiateOnlyPackage(discovery, root)).rejects.toThrow(
      `Runtime plugin package "${manifest.id}" entry could not be imported.`,
    );
  });

  it('rejects absolute imports even when they point inside the package', async () => {
    const root = createTestTempRoot('project02-plugin-module-absolute-');
    const manifest = testPluginManifest('memory.module-absolute');
    const helperPath = join(root, manifest.id, 'helper.mjs');

    writeTestPackage({
      root,
      manifest,
      entry: './index.mjs',
      entrySource: [
        `import {createPlugin} from ${JSON.stringify(helperPath)};`,
        'export const createProject02Plugin = createPlugin;',
        '',
      ].join('\n'),
    });
    writeFileSync(
      helperPath,
      [
        'export const createPlugin = input => ({',
        '  manifest: input.manifest, providedTools: [], lifecycleHooks: {}',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    await expect(instantiateOnlyPackage(discovery, root)).rejects.toThrow(
      `Runtime plugin package "${manifest.id}" entry could not be imported.`,
    );
  });

  it('does not let caller-spoofed bundled provenance escape the artifact', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-module-escape-');
    const root = join(parentRoot, 'source');
    const manifest = testPluginManifest('memory.module-escape');
    const outsidePath = join(root, 'outside.mjs');
    const markerPath = join(parentRoot, 'outside-module-imported');

    mkdirSync(root, {recursive: true});
    writeFileSync(
      outsidePath,
      [
        "import {writeFileSync} from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'executed\\n', 'utf8');`,
        'export const createPlugin = input => ({',
        '  manifest: input.manifest, providedTools: [], lifecycleHooks: {}',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    writeTestPackage({
      root,
      manifest,
      entry: './index.mjs',
      entrySource: [
        "import {createPlugin} from '../outside.mjs';",
        'export const createProject02Plugin = createPlugin;',
        '',
      ].join('\n'),
    });
    const spoofedSource = {root, provenance: 'bundled'} as const;
    const discovery = discoverRuntimePluginPackages({
      sources: [spoofedSource],
      reservedPluginIds: [],
    });

    expect(discovery.packages[0]?.provenance).toBe('operator');
    await expect(instantiateOnlyPackage(discovery, root)).rejects.toThrow(
      `Runtime plugin package "${manifest.id}" entry could not be imported.`,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it('reuses one accepted factory without revalidating on later loads', async () => {
    const parentRoot = createTestTempRoot('project02-plugin-load-cache-');
    const root = join(parentRoot, 'source');
    const manifest = testPluginManifest('memory.load-cache');
    const importMarker = join(parentRoot, 'imports');
    const factoryMarker = join(parentRoot, 'factory-calls');

    writeTestPackage({
      root,
      manifest,
      entrySource: [
        "import {appendFileSync} from 'node:fs';",
        `appendFileSync(${JSON.stringify(importMarker)}, 'import\\n', 'utf8');`,
        'export function createProject02Plugin(input) {',
        `  appendFileSync(${JSON.stringify(factoryMarker)}, 'factory\\n', 'utf8');`,
        '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
        '}',
        '',
      ].join('\n'),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    await instantiateOnlyPackage(discovery, root);
    writeFileSync(
      join(root, manifest.id, 'project02.plugin.json'),
      '{changed after accepted import\n',
      'utf8',
    );
    await instantiateOnlyPackage(discovery, root);

    expect(readFileSync(importMarker, 'utf8')).toBe('import\n');
    expect(readFileSync(factoryMarker, 'utf8')).toBe('factory\nfactory\n');
  });

  it.each(['.ts', '.js', '.mjs'] as const)(
    'loads %s entries through the same package factory path',
    async extension => {
      const root = createTestTempRoot('project02-plugin-entry-format-');
      const manifest = testPluginManifest(`entry.${extension.slice(1)}`);

      writeTestPackage({
        root,
        manifest,
        entry: `./index${extension}`,
        entrySource: validEntrySource(),
      });
      const discovery = discoverRuntimePluginPackages({
        sources: [{root}],
        reservedPluginIds: [],
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
          redactedConfig: {},
        }),
      ).resolves.toMatchObject({manifest: {id: manifest.id}});
    },
  );

  it('accepts semantically identical factory input with reordered manifest keys', async () => {
    const root = createTestTempRoot('project02-plugin-manifest-order-');
    const manifest = testPluginManifest('memory.reordered-manifest');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error(
        'Expected the reordered-manifest package to be discovered.',
      );
    }

    const reorderedManifest = Object.fromEntries(
      Object.entries(discoveredPackage.manifest).reverse(),
    ) as RuntimePluginManifest;

    await expect(
      discoveredPackage.load({
        pluginId: manifest.id,
        manifest: reorderedManifest,
        storeRoot: root,
        resolvedConfig: {},
        redactedConfig: {},
      }),
    ).resolves.toMatchObject({manifest: {id: manifest.id}});
  });

  it('keeps one bundled package and quarantines an operator duplicate', () => {
    const parentRoot = createTestTempRoot('project02-plugin-packages-');
    const operatorRoot = join(parentRoot, 'operator');
    const manifest = createDemoConfigPluginManifest();

    writeTestPackage({
      root: operatorRoot,
      manifest,
      entrySource: validEntrySource(),
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root: operatorRoot}, {root: bundledRuntimePluginPackageRoot}],
      reservedPluginIds: [],
    });

    expect(
      discovery.packages.find(item => item.manifest.id === manifest.id),
    ).toMatchObject({provenance: 'bundled'});
    expect(discovery.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_plugin_id',
        path: join(operatorRoot, manifest.id, 'project02.plugin.json'),
        provenance: 'operator',
        pluginId: manifest.id,
      }),
    );
  });

  it('quarantines every conflicting operator duplicate instead of choosing by order', () => {
    const parentRoot = createTestTempRoot('project02-plugin-packages-');
    const firstRoot = join(parentRoot, 'first');
    const secondRoot = join(parentRoot, 'second');
    const manifest = testPluginManifest('memory.operator-duplicate');

    writeTestPackage({
      root: firstRoot,
      manifest,
      entrySource: validEntrySource(),
    });
    writeTestPackage({
      root: secondRoot,
      manifest,
      entrySource: validEntrySource(),
    });

    const discovery = discoverRuntimePluginPackages({
      sources: [{root: firstRoot}, {root: secondRoot}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toHaveLength(2);
    expect(
      discovery.diagnostics.every(
        diagnostic => diagnostic.code === 'duplicate_plugin_id',
      ),
    ).toBe(true);
  });

  it('rejects a loaded module without the named package factory export', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.missing-factory');

    writeTestPackage({
      root,
      manifest,
      entrySource: 'export default function createProject02Plugin() {}\n',
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
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
        redactedConfig: {},
      }),
    ).rejects.toThrow(
      `Runtime plugin package "${manifest.id}" must export exactly one named createProject02Plugin factory.`,
    );
  });

  it('rejects extra entry-module exports outside the one factory contract', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.extra-export');

    writeTestPackage({
      root,
      manifest,
      entrySource: `${validEntrySource()}export const extra = true;\n`,
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    await expect(instantiateOnlyPackage(discovery, root)).rejects.toThrow(
      `Runtime plugin package "${manifest.id}" must export exactly one named createProject02Plugin factory.`,
    );
  });

  it('reports import failures without exposing the entry exception', async () => {
    const root = createTestTempRoot('project02-plugin-packages-');
    const manifest = testPluginManifest('memory.import-failure');

    writeTestPackage({
      root,
      manifest,
      entrySource: "throw new Error('private import detail');\n",
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });
    const error = await instantiateOnlyPackage(discovery, root).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      `Runtime plugin package "${manifest.id}" entry could not be imported.`,
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
        '  throw new Error(input.resolvedConfig.apiKey.value);',
        '}',
        '',
      ].join('\n'),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error('Expected the package to be discovered.');
    }

    const error = await Promise.resolve(
      discoveredPackage.load({
        pluginId: manifest.id,
        manifest: discoveredPackage.manifest,
        storeRoot: root,
        resolvedConfig: {
          apiKey: {
            name: 'apiKey',
            secret: true,
            source: 'config',
            resolved: true,
            value: secret,
          },
        },
        redactedConfig: {
          apiKey: {
            name: 'apiKey',
            secret: true,
            source: 'config',
            resolved: true,
            value: '[redacted]',
          },
        },
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      `Runtime plugin package "${manifest.id}" factory failed during construction.`,
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
        '    get() { throw new Error(input.resolvedConfig.apiKey.value); }',
        '  });',
        '  return output;',
        '}',
        '',
      ].join('\n'),
    });
    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });
    const discoveredPackage = discovery.packages[0];

    expect(discoveredPackage).toBeDefined();
    if (discoveredPackage === undefined) {
      throw new Error('Expected the package to be discovered.');
    }

    const error = await Promise.resolve(
      discoveredPackage.load({
        pluginId: manifest.id,
        manifest: discoveredPackage.manifest,
        storeRoot: root,
        resolvedConfig: {
          apiKey: {
            name: 'apiKey',
            secret: true,
            source: 'config',
            resolved: true,
            value: secret,
          },
        },
        redactedConfig: {
          apiKey: {
            name: 'apiKey',
            secret: true,
            source: 'config',
            resolved: true,
            value: '[redacted]',
          },
        },
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      `Runtime plugin package "${manifest.id}" factory returned an invalid plugin definition.`,
    );
    expect(String(error)).not.toContain(secret);
  });

  it('rejects invalid and manifest-drifted output while returning constructed candidates to the lifecycle owner', async () => {
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
        '',
      ].join('\n'),
    });
    const invalidDiscovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    await expect(
      instantiatePackageById(invalidDiscovery, invalidManifest.id, root),
    ).rejects.toThrow('factory returned an invalid plugin definition');

    writeTestPackage({
      root,
      manifest: driftManifest,
      entrySource: [
        'export function createProject02Plugin(input) {',
        "  return { manifest: { ...input.manifest, displayName: 'Drifted' }, providedTools: [], lifecycleHooks: {} };",
        '}',
        '',
      ].join('\n'),
    });
    const driftDiscovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    const driftPackage = driftDiscovery.packages.find(
      item => item.manifest.id === driftManifest.id,
    );
    const retained: RuntimePlugin[] = [];

    expect(driftPackage).toBeDefined();
    if (driftPackage === undefined) {
      throw new Error('Expected the drift package to be discovered.');
    }

    await expect(
      driftPackage.load(
        {
          pluginId: driftPackage.manifest.id,
          manifest: driftPackage.manifest,
          storeRoot: root,
          resolvedConfig: {},
          redactedConfig: {},
        },
        {
          retainRejectedCandidate: plugin => retained.push(plugin),
        },
      ),
    ).rejects.toThrow('factory returned a different manifest');
    expect(retained).toHaveLength(1);
    expect(retained[0]?.manifest).toEqual({
      ...driftManifest,
      displayName: 'Drifted',
    });
  });

  it('diagnoses links that leave the package', () => {
    const parentRoot = createTestTempRoot('project02-plugin-packages-');
    const root = join(parentRoot, 'source');
    const directoryPluginId = 'memory.directory-symlink';
    const directoryTarget = join(parentRoot, 'directory-target');
    const sourceManifest = testPluginManifest('memory.outside-source-symlink');
    const sourceTarget = join(parentRoot, 'source-target.ts');
    const metadataManifest = testPluginManifest('memory.metadata-symlink');
    const metadataTarget = join(parentRoot, 'descriptor-target.json');

    mkdirSync(root, {recursive: true});
    mkdirSync(directoryTarget, {recursive: true});
    symlinkSync(directoryTarget, join(root, directoryPluginId), 'dir');
    writeTestPackage({
      root,
      manifest: sourceManifest,
      entrySource: validEntrySource(),
    });
    writeFileSync(sourceTarget, validEntrySource(), 'utf8');
    const outsideSourcePath = join(root, sourceManifest.id, 'index.ts');

    unlinkSync(outsideSourcePath);
    symlinkSync(sourceTarget, outsideSourcePath);
    writeTestPackage({
      root,
      manifest: metadataManifest,
      entrySource: validEntrySource(),
    });
    writeFileSync(metadataTarget, '{}\n', 'utf8');
    const metadataPath = join(
      root,
      metadataManifest.id,
      'project02.plugin.json',
    );

    unlinkSync(metadataPath);
    symlinkSync(metadataTarget, metadataPath);

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.packages).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_package_directory',
        message: 'Runtime plugin package directories must be real directories.',
        path: join(root, directoryPluginId),
        pluginId: directoryPluginId,
      }),
      expect.objectContaining({
        code: 'invalid_descriptor',
        message: 'Runtime plugin package descriptor must be a regular file.',
        path: metadataPath,
        pluginId: metadataManifest.id,
      }),
      expect.objectContaining({
        code: 'invalid_package',
        message:
          'Runtime plugin packages must contain only stable regular files and directories.',
        path: outsideSourcePath,
        pluginId: sourceManifest.id,
      }),
    ]);
  });

  it('loads an entry reached through a link inside the package', async () => {
    const root = createTestTempRoot('project02-plugin-inside-symlink-');
    const manifest = testPluginManifest('memory.inside-symlink');

    writeTestPackage({
      root,
      manifest,
      entrySource: validEntrySource(),
    });
    const packageRoot = join(root, manifest.id);
    const entryPath = join(packageRoot, 'index.ts');

    writeFileSync(join(packageRoot, 'target.ts'), validEntrySource(), 'utf8');
    unlinkSync(entryPath);
    symlinkSync('target.ts', entryPath);

    const discovery = discoverRuntimePluginPackages({
      sources: [{root}],
      reservedPluginIds: [],
    });

    expect(discovery.diagnostics).toEqual([]);
    await expect(
      instantiateOnlyPackage(discovery, root),
    ).resolves.toMatchObject({
      manifest: {id: manifest.id},
    });
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

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({type: options.packageType ?? 'module'})}\n`,
    'utf8',
  );
  writeFileSync(
    join(packageRoot, 'project02.plugin.json'),
    `${JSON.stringify({
      format: options.descriptorFormat ?? 'project02.plugin.v1',
      entry,
      manifest: options.manifest,
      ...options.descriptorExtras,
    })}\n`,
    'utf8',
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
    '',
  ].join('\n');
}

function instantiateOnlyPackage(
  discovery: ReturnType<typeof discoverRuntimePluginPackages>,
  storeRoot: string,
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
  storeRoot: string,
) {
  const discoveredPackage = discovery.packages.find(
    item => item.manifest.id === pluginId,
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
  storeRoot: string,
) {
  return await discoveredPackage.load({
    pluginId: discoveredPackage.manifest.id,
    manifest: discoveredPackage.manifest,
    storeRoot,
    resolvedConfig: {},
    redactedConfig: {},
  });
}

function testPluginManifest(
  id: string,
  options: {
    readonly firstParty?: RuntimePluginManifest['firstParty'];
    readonly defaultEnabled?: boolean;
  } = {},
): RuntimePluginManifest {
  return createRuntimePluginManifest({
    id,
    displayName: `Test ${id}`,
    version: '1.0.0',
    kind: 'memory_provider',
    description: 'Test runtime plugin package.',
    contractVersion: 'mvp-008.runtime_plugin.v2',
    compatibility: {
      hostContractVersions: ['mvp-008.runtime_plugin.v2'],
    },
    declaredPlugins: ['plugin_discovery'],
    config: {scope: 'global_with_character_overrides', fields: []},
    firstParty: options.firstParty ?? false,
    runtimePolicy: {
      timeoutMs: 1000,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: options.defaultEnabled ?? false,
      reasons: ['test_package'],
    },
    requestedAccess: {},
  });
}
