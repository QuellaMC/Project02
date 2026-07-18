/**
 * Discovery phase of the runtime plugin package loader: scans package
 * sources, validates descriptors and entry paths, applies the identity
 * policy, and hands accepted packages a load closure.
 */
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type {Dirent} from 'node:fs';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import {createRuntimePluginManifest} from '../api/manifest-validation.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {isRecord} from '../api/validation-primitives.ts';
import type {RuntimePluginManifest} from '../api/types.ts';
import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import {
  maxRuntimePluginPackageMetadataBytes,
  runtimePluginPackageDescriptorFormat,
  type DiscoveredRuntimePluginPackage,
  type RuntimePluginPackageDiagnostic,
  type RuntimePluginPackageDiscovery,
  type RuntimePluginPackageProvenance,
  type RuntimePluginPackageSource,
} from './contract.ts';
import {loadRuntimePluginPackage} from './load.ts';

type DiscoveredRuntimePluginPackageCandidate = {
  readonly package: DiscoveredRuntimePluginPackage;
  readonly descriptorPath: string;
};

export function discoverRuntimePluginPackages(options: {
  readonly sources: readonly RuntimePluginPackageSource[];
  readonly reservedPluginIds: readonly string[] | ReadonlySet<string>;
}): RuntimePluginPackageDiscovery {
  const candidates: DiscoveredRuntimePluginPackageCandidate[] = [];
  const diagnostics: RuntimePluginPackageDiagnostic[] = [];

  for (const source of options.sources) {
    let entries: Dirent[];

    try {
      entries = readdirSync(source.root, {withFileTypes: true});
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        continue;
      }

      diagnostics.push(
        packageDiagnostic({
          code: 'package_source_unavailable',
          message: 'Runtime plugin package source is unavailable.',
          path: source.root,
          provenance: source.provenance,
        }),
      );
      continue;
    }

    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const packageRoot = join(source.root, entry.name);

      if (entry.isSymbolicLink()) {
        diagnostics.push(
          packageDiagnostic({
            code: 'invalid_package_directory',
            message:
              'Runtime plugin package directories must not be symbolic links.',
            path: packageRoot,
            provenance: source.provenance,
            pluginId: entry.name,
          }),
        );
        continue;
      }
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        candidates.push(
          discoverRuntimePluginPackage({
            packageRoot,
            provenance: source.provenance,
          }),
        );
      } catch (error: unknown) {
        diagnostics.push(
          error instanceof RuntimePluginPackageDiscoveryError
            ? error.diagnostic
            : packageDiagnostic({
                code: 'invalid_package',
                message: 'Runtime plugin package is invalid.',
                path: packageRoot,
                provenance: source.provenance,
                pluginId: entry.name,
              }),
        );
      }
    }
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

function discoverRuntimePluginPackage(options: {
  readonly packageRoot: string;
  readonly provenance: RuntimePluginPackageProvenance;
}): DiscoveredRuntimePluginPackageCandidate {
  const descriptor = readRuntimePluginPackageDescriptor(options);
  const entryPath = resolveRuntimePluginPackageEntryPath({
    packageRoot: options.packageRoot,
    entry: descriptor.entry,
    descriptorPath: descriptor.descriptorPath,
    provenance: options.provenance,
    pluginId: descriptor.manifest.id,
  });

  return Object.freeze({
    package: Object.freeze({
      catalogKind: 'package',
      manifest: descriptor.manifest,
      provenance: options.provenance,
      load: input =>
        loadRuntimePluginPackage({
          entryPath,
          manifest: descriptor.manifest,
          input,
        }),
    } satisfies DiscoveredRuntimePluginPackage),
    descriptorPath: descriptor.descriptorPath,
  } satisfies DiscoveredRuntimePluginPackageCandidate);
}

function readRuntimePluginPackageDescriptor(options: {
  readonly packageRoot: string;
  readonly provenance: RuntimePluginPackageProvenance;
}): {
  readonly descriptorPath: string;
  readonly entry: string;
  readonly manifest: RuntimePluginManifest;
} {
  const packageJsonPath = join(options.packageRoot, 'package.json');
  const pluginId = basename(options.packageRoot);
  const packageJson = parsePackageJsonFile({
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

  const descriptorPath = join(options.packageRoot, 'project02.plugin.json');
  const descriptor = parsePackageJsonFile({
    path: descriptorPath,
    code: 'invalid_descriptor',
    label: 'descriptor',
    provenance: options.provenance,
    pluginId,
  });

  if (!isRecord(descriptor)) {
    throw packageDiscoveryError({
      code: 'invalid_descriptor',
      message: 'Runtime plugin package descriptor must be an object.',
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }

  const descriptorFields = new Set(['format', 'entry', 'manifest']);
  const unknownDescriptorField = Object.keys(descriptor)
    .sort(compareText)
    .find(field => !descriptorFields.has(field));

  if (unknownDescriptorField !== undefined) {
    throw packageDiscoveryError({
      code: 'invalid_descriptor',
      message: `Runtime plugin package descriptor contains unknown field "${unknownDescriptorField}".`,
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }

  let manifest: RuntimePluginManifest;

  try {
    manifest = createRuntimePluginManifest(descriptor['manifest']);
  } catch (error: unknown) {
    throw packageDiscoveryError({
      code: 'invalid_manifest',
      message:
        error instanceof Error
          ? error.message
          : 'Runtime plugin package manifest is invalid.',
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }
  const entry = descriptor['entry'];

  if (descriptor['format'] !== runtimePluginPackageDescriptorFormat) {
    throw packageDiscoveryError({
      code: 'invalid_descriptor',
      message: `Runtime plugin package format must be "${runtimePluginPackageDescriptorFormat}".`,
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }
  if (typeof entry !== 'string') {
    throw packageDiscoveryError({
      code: 'invalid_entry',
      message: 'Runtime plugin package entry must be a string.',
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }
  if (!entry.startsWith('./')) {
    throw packageDiscoveryError({
      code: 'invalid_entry',
      message:
        'Runtime plugin package entry must stay inside its package directory.',
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }
  if (!['.ts', '.js', '.mjs'].includes(extname(entry))) {
    throw packageDiscoveryError({
      code: 'invalid_entry',
      message: 'Runtime plugin package entry must use .ts, .js, or .mjs.',
      path: descriptorPath,
      provenance: options.provenance,
      pluginId,
    });
  }
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

  return Object.freeze({descriptorPath, entry, manifest});
}

function resolveRuntimePluginPackageEntryPath(options: {
  readonly packageRoot: string;
  readonly entry: string;
  readonly descriptorPath: string;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly pluginId: string;
}): string {
  const packageRoot = resolve(options.packageRoot);
  const unresolvedEntryPath = resolve(packageRoot, options.entry);
  const relativeEntryPath = relative(packageRoot, unresolvedEntryPath);

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
  try {
    if (lstatSync(unresolvedEntryPath).isSymbolicLink()) {
      throw packageDiscoveryError({
        code: 'invalid_entry',
        message: 'Runtime plugin package entry must not be a symbolic link.',
        path: options.descriptorPath,
        provenance: options.provenance,
        pluginId: options.pluginId,
      });
    }
    if (!statSync(unresolvedEntryPath).isFile()) {
      throw new TypeError('Entry is not a file.');
    }
  } catch (error: unknown) {
    if (error instanceof RuntimePluginPackageDiscoveryError) {
      throw error;
    }

    throw packageDiscoveryError({
      code: 'invalid_entry',
      message: 'Runtime plugin package entry must reference an existing file.',
      path: options.descriptorPath,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }

  const realPackageRoot = realpathSync(packageRoot);
  const entryPath = realpathSync(unresolvedEntryPath);
  const realRelativeEntryPath = relative(realPackageRoot, entryPath);

  if (
    realRelativeEntryPath === '..' ||
    realRelativeEntryPath.startsWith(`..${sep}`) ||
    isAbsolute(realRelativeEntryPath)
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

  return entryPath;
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

function parsePackageJsonFile(options: {
  readonly path: string;
  readonly code: string;
  readonly label: string;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly pluginId: string;
}): unknown {
  let metadataStat: ReturnType<typeof lstatSync>;
  let source: string;

  try {
    metadataStat = lstatSync(options.path);
  } catch {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} is unreadable.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }

  if (metadataStat.isSymbolicLink()) {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} must not be a symbolic link.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }
  if (!metadataStat.isFile()) {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} must be a regular file.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }
  if (metadataStat.size > maxRuntimePluginPackageMetadataBytes) {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} exceeds the metadata size limit.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }

  try {
    source = readFileSync(options.path, 'utf8');
  } catch {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} is unreadable.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }

  if (
    Buffer.byteLength(source, 'utf8') > maxRuntimePluginPackageMetadataBytes
  ) {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} exceeds the metadata size limit.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} must contain valid JSON.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
  }

  try {
    return createJsonBoundarySnapshot(parsed, {
      field: `Runtime plugin package ${options.label}`,
    });
  } catch {
    throw packageDiscoveryError({
      code: options.code,
      message: `Runtime plugin package ${options.label} exceeds safe JSON metadata limits.`,
      path: options.path,
      provenance: options.provenance,
      pluginId: options.pluginId,
    });
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
