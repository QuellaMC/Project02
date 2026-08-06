/**
 * Discovery phase of the runtime plugin package loader: scans package
 * sources, validates descriptors and entry paths, applies the identity
 * policy, and hands accepted packages a load closure.
 */
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  capturePackageFiles,
  PackageCaptureError,
  readCapturedPackageFile,
  readPlannedPackageFile,
} from '../../shared/package-capture.ts';
import {
  packageDirectorySnapshotsEqual,
  parseBoundedPackageJsonSource,
  scanPackageSourceRoot,
  snapshotPackageDirectory,
  compareText,
  snapshotPackageDirectoryFromSource,
  snapshotPackageSourceDirectory,
  type BoundedPackageJsonRejectionReason,
  type PackageDirectorySnapshot,
} from '../../shared/package-metadata.ts';
import {isRecord} from '../api/validation-primitives.ts';
import {
  maxRuntimePluginPackageMetadataBytes,
  parseRuntimePluginPackageDescriptor,
} from '../api/package-descriptor.ts';
import type {RuntimePluginManifest} from '../api/types.ts';
import {
  captureRuntimePluginPackageArtifact,
  RuntimePluginPackageArtifactError,
  type RuntimePluginPackageArtifact,
} from './artifact.ts';
import {
  bundledRuntimePluginPackageRoot,
  type DiscoveredRuntimePluginPackage,
  type RuntimePluginPackageDiagnostic,
  type RuntimePluginPackageDiscovery,
  type RuntimePluginPackageProvenance,
  type RuntimePluginPackageSource,
} from './contract.ts';
import {bundledRuntimePluginFactory} from './bundled.ts';
import {createRuntimePluginPackageLoader} from './load.ts';

const bundledRuntimePluginPackageDirectory =
  requireBundledRuntimePluginPackageDirectory();

type DiscoveredRuntimePluginPackageCandidate = {
  readonly package: DiscoveredRuntimePluginPackage;
  readonly descriptorPath: string;
};

/**
 * The metadata files as descriptor parsing needs them, independent of whether
 * they were read eagerly or are read on demand.
 *
 * The bundled path captures two named files up front; the operator path holds
 * a walk it reads from. Both answer the same two questions, so descriptor
 * parsing does not need to know which it has.
 */
type RuntimePluginPackageMetadataSource = {
  readonly directories: ReadonlySet<string>;
  readonly readFile: (relativePath: string) => Buffer | undefined;
};

type RuntimePluginPackageSnapshot = {
  readonly descriptorPath: string;
  readonly entryRelativePath: string;
  readonly manifest: RuntimePluginManifest;
  readonly source:
    | {
        readonly kind: 'bound';
        readonly factory: NonNullable<
          ReturnType<typeof bundledRuntimePluginFactory>
        >;
      }
    | {
        readonly kind: 'captured';
        readonly artifact: RuntimePluginPackageArtifact;
        readonly entryRelativePath: string;
      };
};

function requireBundledRuntimePluginPackageDirectory(): PackageDirectorySnapshot {
  const directory = snapshotPackageDirectory(bundledRuntimePluginPackageRoot);

  if (directory === undefined) {
    throw new TypeError('Bundled runtime plugin package root is unavailable.');
  }
  return directory;
}

export function discoverRuntimePluginPackages(options: {
  readonly sources: readonly RuntimePluginPackageSource[];
  readonly reservedPluginIds: readonly string[] | ReadonlySet<string>;
}): RuntimePluginPackageDiscovery {
  const candidates: DiscoveredRuntimePluginPackageCandidate[] = [];
  const diagnostics: RuntimePluginPackageDiagnostic[] = [];

  for (const source of options.sources) {
    discoverRuntimePluginPackageSource({source, candidates, diagnostics});
  }

  const packages = applyPackageIdentityPolicy({
    candidates,
    reservedPluginIds: options.reservedPluginIds,
    diagnostics,
  });
  diagnostics.sort(
    (left, right) =>
      compareText(left.path, right.path) || compareText(left.code, right.code),
  );

  return Object.freeze({
    packages: Object.freeze(packages),
    diagnostics: Object.freeze(diagnostics),
  } satisfies RuntimePluginPackageDiscovery);
}

function discoverRuntimePluginPackageSource(options: {
  readonly source: RuntimePluginPackageSource;
  readonly candidates: DiscoveredRuntimePluginPackageCandidate[];
  readonly diagnostics: RuntimePluginPackageDiagnostic[];
}): void {
  const sourceDirectory = snapshotPackageSourceDirectory(options.source.root);
  const scan = scanPackageSourceRoot(options.source.root);

  if (scan.status === 'unavailable') {
    if (isNodeErrorWithCode(scan.error, 'ENOENT')) {
      return;
    }
    options.diagnostics.push(packageSourceUnavailable(options.source));
    return;
  }
  if (sourceDirectory === undefined) {
    options.diagnostics.push(packageSourceUnavailable(options.source));
    return;
  }
  const provenance = authenticatedPackageProvenance(sourceDirectory);

  const sourceCandidates: DiscoveredRuntimePluginPackageCandidate[] = [];
  const sourceDiagnostics: RuntimePluginPackageDiagnostic[] = [];

  for (const candidate of scan.candidates) {
    const packageRoot = join(options.source.root, candidate.name);
    const packageDirectory = snapshotPackageDirectoryFromSource({
      sourceDirectory,
      packageName: candidate.name,
    });

    try {
      if (packageDirectory === undefined) {
        throw invalidPackageDirectory(
          {
            packageRoot,
            provenance,
          },
          candidate.name,
        );
      }
      sourceCandidates.push(
        discoverRuntimePluginPackage({
          packageDirectory,
          provenance,
        }),
      );
    } catch (error: unknown) {
      sourceDiagnostics.push(
        error instanceof RuntimePluginPackageDiscoveryError
          ? error.diagnostic
          : packageDiagnostic({
              code: 'invalid_package',
              message: 'Runtime plugin package is invalid.',
              path: packageRoot,
              provenance,
              pluginId: candidate.name,
            }),
      );
    }
  }

  if (
    !packageDirectorySnapshotsEqual(
      sourceDirectory,
      snapshotPackageSourceDirectory(options.source.root),
    )
  ) {
    options.diagnostics.push(
      packageDiagnostic({
        code: 'package_source_changed',
        message: 'Runtime plugin package source changed during discovery.',
        path: options.source.root,
        provenance,
      }),
    );
    return;
  }

  options.candidates.push(...sourceCandidates);
  options.diagnostics.push(...sourceDiagnostics);
}

function packageSourceUnavailable(
  source: RuntimePluginPackageSource,
): RuntimePluginPackageDiagnostic {
  return packageDiagnostic({
    code: 'package_source_unavailable',
    message: 'Runtime plugin package source is unavailable.',
    path: source.root,
    provenance:
      resolve(source.root) === resolve(bundledRuntimePluginPackageRoot)
        ? 'bundled'
        : 'operator',
  });
}

function authenticatedPackageProvenance(
  sourceDirectory: PackageDirectorySnapshot,
): RuntimePluginPackageProvenance {
  return packageDirectorySnapshotsEqual(
    bundledRuntimePluginPackageDirectory,
    sourceDirectory,
  )
    ? 'bundled'
    : 'operator';
}

function discoverRuntimePluginPackage(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly provenance: RuntimePluginPackageProvenance;
}): DiscoveredRuntimePluginPackageCandidate {
  const snapshot = readRuntimePluginPackageSnapshot(options);

  return Object.freeze({
    package: Object.freeze({
      catalogKind: 'package',
      manifest: snapshot.manifest,
      provenance: options.provenance,
      load: createRuntimePluginPackageLoader({
        manifest: snapshot.manifest,
        source: snapshot.source,
      }),
    } satisfies DiscoveredRuntimePluginPackage),
    descriptorPath: snapshot.descriptorPath,
  } satisfies DiscoveredRuntimePluginPackageCandidate);
}

function bundledRuntimePluginLoaderSource(
  snapshot: Pick<
    RuntimePluginPackageSnapshot,
    'entryRelativePath' | 'manifest'
  >,
): {
  readonly kind: 'bound';
  readonly factory: NonNullable<ReturnType<typeof bundledRuntimePluginFactory>>;
} {
  const factory = bundledRuntimePluginFactory({
    pluginId: snapshot.manifest.id,
    entryRelativePath: snapshot.entryRelativePath,
  });

  if (factory === undefined) {
    throw new TypeError(
      `Bundled runtime plugin package "${snapshot.manifest.id}" has no host-bound factory.`,
    );
  }

  return Object.freeze({kind: 'bound', factory});
}

function readRuntimePluginPackageSnapshot(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly provenance: RuntimePluginPackageProvenance;
}): RuntimePluginPackageSnapshot {
  if (options.provenance === 'bundled') {
    return readBundledRuntimePluginPackageSnapshot(options.packageDirectory);
  }

  const packageDirectory = options.packageDirectory;
  const pluginId = basename(packageDirectory.packageRoot);
  const artifact = capturePackageArtifact({
    packageDirectory,
    pluginId,
    provenance: 'operator',
  });
  const metadata = readRuntimePluginPackageMetadata({
    packageDirectory,
    provenance: 'operator',
    metadataSource: plannedArtifactMetadataSource(artifact),
  });

  if (!artifact.files.has(metadata.entryRelativePath)) {
    throw invalidRuntimePluginEntry({
      descriptorPath: metadata.descriptorPath,
      provenance: 'operator',
      pluginId: metadata.manifest.id,
    });
  }

  return Object.freeze({
    ...metadata,
    source: Object.freeze({
      kind: 'captured',
      artifact,
      entryRelativePath: metadata.entryRelativePath,
    }),
  } satisfies RuntimePluginPackageSnapshot);
}

/**
 * Reads the operator package's metadata from its walk.
 *
 * A metadata file that no longer matches the walk reads as absent, which the
 * descriptor parser already reports as unreadable — the same outcome as a
 * package whose metadata could not be captured at all.
 */
function plannedArtifactMetadataSource(
  artifact: RuntimePluginPackageArtifact,
): RuntimePluginPackageMetadataSource {
  return Object.freeze({
    directories: artifact.directories,
    readFile: relativePath => {
      const file = artifact.files.get(relativePath);

      if (file === undefined) {
        return undefined;
      }
      try {
        return readPlannedPackageFile({
          packageDirectory: artifact.packageDirectory,
          file,
        });
      } catch (error: unknown) {
        if (error instanceof PackageCaptureError) {
          return undefined;
        }
        throw error;
      }
    },
  });
}

function readBundledRuntimePluginPackageSnapshot(
  packageDirectory: PackageDirectorySnapshot,
): RuntimePluginPackageSnapshot {
  const pluginId = basename(packageDirectory.packageRoot);
  let artifact: ReturnType<typeof capturePackageFiles>;

  try {
    artifact = capturePackageFiles({
      packageDirectory,
      relativePaths: ['package.json', 'project02.plugin.json'],
      maxBytes: maxRuntimePluginPackageMetadataBytes * 2,
    });
  } catch (error: unknown) {
    if (!(error instanceof PackageCaptureError)) {
      throw error;
    }
    throw artifactMetadataDiscoveryError({
      error,
      code:
        basename(error.path) === 'package.json'
          ? 'invalid_package_json'
          : 'invalid_descriptor',
      label:
        basename(error.path) === 'package.json' ? 'package.json' : 'descriptor',
      pluginId,
      provenance: 'bundled',
    });
  }
  const metadata = readRuntimePluginPackageMetadata({
    packageDirectory,
    provenance: 'bundled',
    metadataSource: Object.freeze({
      directories: artifact.directories,
      readFile: relativePath => readCapturedPackageFile(artifact, relativePath),
    }),
  });

  return Object.freeze({
    ...metadata,
    source: bundledRuntimePluginLoaderSource(metadata),
  } satisfies RuntimePluginPackageSnapshot);
}

function readRuntimePluginPackageMetadata(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly metadataSource: RuntimePluginPackageMetadataSource;
}): Omit<RuntimePluginPackageSnapshot, 'source'> {
  const packageDirectory = options.packageDirectory;
  const packageJsonPath = join(packageDirectory.packageRoot, 'package.json');
  const pluginId = basename(packageDirectory.packageRoot);
  const packageJson = parsePackageArtifactJson({
    metadataSource: options.metadataSource,
    relativePath: 'package.json',
    path: packageJsonPath,
    code: 'invalid_package_json',
    label: 'package.json',
    provenance: options.provenance,
    pluginId,
  });

  if (!isRecord(packageJson) || packageJson['type'] !== 'module') {
    throw packageDiscoveryError({
      code: 'invalid_package_json',
      message:
        'Runtime plugin package package.json must declare type "module".',
      path: packageJsonPath,
      provenance: options.provenance,
      pluginId,
    });
  }

  const descriptorPath = join(
    packageDirectory.packageRoot,
    'project02.plugin.json',
  );
  const descriptor = parsePackageArtifactJson({
    metadataSource: options.metadataSource,
    relativePath: 'project02.plugin.json',
    path: descriptorPath,
    code: 'invalid_descriptor',
    label: 'descriptor',
    provenance: options.provenance,
    pluginId,
  });

  const parsed = parseRuntimePluginPackageDescriptor(descriptor);

  if (parsed.status === 'rejected') {
    throw packageDiscoveryError({
      code: parsed.issue.code,
      message: parsed.issue.message,
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }

  const {entry, manifest} = parsed.descriptor;

  if (pluginId !== manifest.id) {
    throw packageDiscoveryError({
      code: 'package_id_mismatch',
      message: 'Runtime plugin package folder must match its manifest id.',
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
      claimedPluginId: manifest.id,
    });
  }

  const entryRelativePath = resolveRuntimePluginPackageEntry({
    packageRoot: packageDirectory.packageRoot,
    entry,
    descriptorPath,
    provenance: options.provenance,
    pluginId: manifest.id,
  });
  return Object.freeze({
    descriptorPath,
    entryRelativePath,
    manifest,
  });
}

function resolveRuntimePluginPackageEntry(options: {
  readonly packageRoot: string;
  readonly entry: string;
  readonly descriptorPath: string;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly pluginId: string;
}): string {
  const unresolvedEntryPath = resolve(options.packageRoot, options.entry);
  const relativeEntryPath = relative(options.packageRoot, unresolvedEntryPath);

  if (
    relativeEntryPath === '' ||
    relativeEntryPath === '..' ||
    relativeEntryPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeEntryPath)
  ) {
    throw packageDiscoveryError({
      code: 'invalid_entry',
      message:
        'Runtime plugin package entry must stay inside its package directory.',
      path: options.descriptorPath,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }
  const normalizedRelativePath = relativeEntryPath.split(sep).join('/');

  return normalizedRelativePath;
}

function capturePackageArtifact(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly pluginId: string;
  readonly provenance: RuntimePluginPackageProvenance;
}): RuntimePluginPackageArtifact {
  try {
    return captureRuntimePluginPackageArtifact({
      packageDirectory: options.packageDirectory,
      provenance: options.provenance,
    });
  } catch (error: unknown) {
    if (!(error instanceof RuntimePluginPackageArtifactError)) {
      throw error;
    }

    const fileName = basename(error.path);

    if (fileName === 'package.json') {
      throw artifactMetadataDiscoveryError({
        error,
        code: 'invalid_package_json',
        label: 'package.json',
        pluginId: options.pluginId,
        provenance: options.provenance,
      });
    }
    if (fileName === 'project02.plugin.json') {
      throw artifactMetadataDiscoveryError({
        error,
        code: 'invalid_descriptor',
        label: 'descriptor',
        pluginId: options.pluginId,
        provenance: options.provenance,
      });
    }
    throw packageDiscoveryError({
      code: 'invalid_package',
      message:
        'Runtime plugin packages must contain only stable regular files and directories.',
      path: error.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }
}

function artifactMetadataDiscoveryError(options: {
  readonly error: Pick<
    RuntimePluginPackageArtifactError | PackageCaptureError,
    'path' | 'reason'
  >;
  readonly code: string;
  readonly label: string;
  readonly pluginId: string;
  readonly provenance: RuntimePluginPackageProvenance;
}): RuntimePluginPackageDiscoveryError {
  const reason: BoundedPackageJsonRejectionReason =
    options.error.reason === 'not_regular'
      ? 'not_file'
      : options.error.reason === 'too_large'
        ? 'too_large'
        : 'unreadable';

  return packageDiscoveryError({
    code: options.code,
    message: runtimePluginMetadataReadMessage(options.label, reason),
    path: options.error.path,
    provenance: options.provenance,
    pluginId: options.pluginId,
  });
}

function invalidPackageDirectory(
  options: {
    readonly packageRoot: string;
    readonly provenance: RuntimePluginPackageProvenance;
  },
  pluginId: string,
): RuntimePluginPackageDiscoveryError {
  return packageDiscoveryError({
    code: 'invalid_package_directory',
    message: 'Runtime plugin package directories must be real directories.',
    path: options.packageRoot,
    provenance: options.provenance,
    pluginId,
  });
}

function invalidRuntimePluginEntry(options: {
  readonly descriptorPath: string;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly pluginId: string;
}): RuntimePluginPackageDiscoveryError {
  return packageDiscoveryError({
    code: 'invalid_entry',
    message: 'Runtime plugin package entry must reference an existing file.',
    path: options.descriptorPath,
    provenance: options.provenance,
    pluginId: options.pluginId,
  });
}

function applyPackageIdentityPolicy(options: {
  readonly candidates: readonly DiscoveredRuntimePluginPackageCandidate[];
  readonly reservedPluginIds: readonly string[] | ReadonlySet<string>;
  readonly diagnostics: RuntimePluginPackageDiagnostic[];
}): DiscoveredRuntimePluginPackage[] {
  const reservedPluginIds = new Set(options.reservedPluginIds);
  const candidatesByPluginId = new Map<
    string,
    DiscoveredRuntimePluginPackageCandidate[]
  >();
  const packages: DiscoveredRuntimePluginPackage[] = [];

  for (const candidate of options.candidates) {
    const pluginId = candidate.package.manifest.id;
    const matchingCandidates = candidatesByPluginId.get(pluginId) ?? [];

    matchingCandidates.push(candidate);
    candidatesByPluginId.set(pluginId, matchingCandidates);
  }

  for (const [pluginId, matchingCandidates] of [...candidatesByPluginId].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    const eligibleCandidates = matchingCandidates.filter(candidate => {
      if (
        candidate.package.provenance === 'operator' &&
        reservedPluginIds.has(pluginId)
      ) {
        options.diagnostics.push(
          packageDiagnostic({
            code: 'reserved_plugin_id',
            message: `Operator runtime plugin package id "${pluginId}" is reserved by the host.`,
            path: candidate.descriptorPath,
            provenance: 'operator',
            pluginId,
          }),
        );
        return false;
      }

      return true;
    });

    if (eligibleCandidates.length === 1) {
      const candidate = eligibleCandidates[0];

      if (candidate !== undefined) {
        packages.push(candidate.package);
      }
      continue;
    }
    if (eligibleCandidates.length === 0) {
      continue;
    }

    const bundledCandidates = eligibleCandidates.filter(
      candidate => candidate.package.provenance === 'bundled',
    );
    const winner =
      bundledCandidates.length === 1 ? bundledCandidates[0] : undefined;

    if (winner !== undefined) {
      packages.push(winner.package);
    }

    for (const candidate of eligibleCandidates) {
      if (candidate === winner) {
        continue;
      }

      options.diagnostics.push(
        packageDiagnostic({
          code: 'duplicate_plugin_id',
          message: `Runtime plugin package id "${pluginId}" conflicts with another discovered package.`,
          path: candidate.descriptorPath,
          provenance: candidate.package.provenance,
          pluginId,
        }),
      );
    }
  }

  return packages;
}

function parsePackageArtifactJson(options: {
  readonly metadataSource: RuntimePluginPackageMetadataSource;
  readonly relativePath: string;
  readonly path: string;
  readonly code: string;
  readonly label: string;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly pluginId: string;
}) {
  const source = options.metadataSource.readFile(options.relativePath);
  const metadata =
    source === undefined
      ? ({
          status: 'rejected',
          reason: options.metadataSource.directories.has(options.relativePath)
            ? 'not_file'
            : 'unreadable',
        } as const)
      : parseBoundedPackageJsonSource({
          source,
          maxBytes: maxRuntimePluginPackageMetadataBytes,
          boundaryField: `Runtime plugin package ${options.label}`,
        });

  if (metadata.status === 'rejected') {
    throw packageDiscoveryError({
      code: options.code,
      message: runtimePluginMetadataReadMessage(options.label, metadata.reason),
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }

  return metadata.value;
}

function runtimePluginMetadataReadMessage(
  label: string,
  reason: BoundedPackageJsonRejectionReason,
): string {
  switch (reason) {
    case 'unreadable':
      return `Runtime plugin package ${label} is unreadable.`;
    case 'not_file':
      return `Runtime plugin package ${label} must be a regular file.`;
    case 'too_large':
      return `Runtime plugin package ${label} exceeds the metadata size limit.`;
    case 'invalid_json':
      return `Runtime plugin package ${label} must contain valid JSON.`;
    case 'unsafe_json':
      return `Runtime plugin package ${label} exceeds safe JSON metadata limits.`;
  }
}

class RuntimePluginPackageDiscoveryError extends Error {
  readonly diagnostic: RuntimePluginPackageDiagnostic;

  constructor(diagnostic: RuntimePluginPackageDiagnostic) {
    super(diagnostic.message);
    this.name = 'RuntimePluginPackageDiscoveryError';
    this.diagnostic = diagnostic;
  }
}

function packageDiscoveryError(
  options: Omit<RuntimePluginPackageDiagnostic, 'severity'>,
): RuntimePluginPackageDiscoveryError {
  return new RuntimePluginPackageDiscoveryError(packageDiagnostic(options));
}

function packageDiagnostic(
  options: Omit<RuntimePluginPackageDiagnostic, 'severity'>,
): RuntimePluginPackageDiagnostic {
  return Object.freeze({
    severity: 'error',
    code: options.code,
    message: options.message,
    path: options.path,
    provenance: options.provenance,
    ...(options.pluginId === undefined ? {} : {pluginId: options.pluginId}),
    ...(options.claimedPluginId === undefined
      ? {}
      : {claimedPluginId: options.claimedPluginId}),
  } satisfies RuntimePluginPackageDiagnostic);
}
