/**
 * Immutable executable artifact boundary for runtime plugin packages.
 *
 * Discovery captures every regular file while the package identities are
 * stable. Loading later evaluates only those captured bytes through a private
 * module URL, so neither the entry path nor a transitive relative import can
 * follow a changed source tree.
 */
import {createHash} from 'node:crypto';
import {
  isBuiltin,
  registerHooks,
  type ResolveFnOutput,
  type ResolveHookContext,
} from 'node:module';
import {extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  capturePackageDirectoryArtifact,
  PackageCaptureError,
  type CapturedPackageFile,
} from '../../shared/package-capture.ts';
import type {PackageDirectorySnapshot} from '../../shared/package-metadata.ts';
import {maxRuntimePluginPackageMetadataBytes} from '../api/package-descriptor.ts';
import type {RuntimePluginPackageProvenance} from './contract.ts';

const runtimePluginArtifactProtocol = 'project02-plugin:';
const maxRuntimePluginArtifactFiles = 2_048;
const maxRuntimePluginArtifactBytes = 64 * 1024 * 1024;
const runtimePluginArtifactIdVersion = 'project02.plugin-artifact.v1';
const runtimePluginMetadataFileByteLimits: ReadonlyMap<string, number> =
  new Map([
    ['package.json', maxRuntimePluginPackageMetadataBytes],
    ['project02.plugin.json', maxRuntimePluginPackageMetadataBytes],
  ]);

export type RuntimePluginPackageArtifact = {
  readonly id: string;
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly directories: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, CapturedPackageFile>;
};

type RuntimePluginArtifactAddress = {
  readonly artifact: RuntimePluginPackageArtifact;
  readonly relativePath: string;
  readonly search: string;
  readonly hash: string;
};

type RuntimePluginArtifactNextResolve = (
  specifier: string,
  context?: Partial<ResolveHookContext>,
) => ResolveFnOutput;

export class RuntimePluginPackageArtifactError extends Error {
  readonly path: string;
  readonly reason:
    'changed' | 'symbolic_link' | 'not_regular' | 'too_large' | 'unreadable';

  constructor(options: {
    readonly path: string;
    readonly reason:
      'changed' | 'symbolic_link' | 'not_regular' | 'too_large' | 'unreadable';
  }) {
    super('Runtime plugin package could not be captured.');
    this.name = 'RuntimePluginPackageArtifactError';
    this.path = options.path;
    this.reason = options.reason;
  }
}

const activatedArtifacts = new Map<string, RuntimePluginPackageArtifact>();
let artifactHooksRegistered = false;

export function captureRuntimePluginPackageArtifact(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly provenance: RuntimePluginPackageProvenance;
}): RuntimePluginPackageArtifact {
  let captured: ReturnType<typeof capturePackageDirectoryArtifact>;

  try {
    captured = capturePackageDirectoryArtifact({
      packageDirectory: options.packageDirectory,
      maxFiles: maxRuntimePluginArtifactFiles,
      maxBytes: maxRuntimePluginArtifactBytes,
      fileByteLimits: runtimePluginMetadataFileByteLimits,
    });
  } catch (error: unknown) {
    if (error instanceof PackageCaptureError) {
      const relativePath = artifactRelativePathIfContained(
        options.packageDirectory.realPackageRoot,
        error.path,
      );

      throw artifactError(
        relativePath === undefined
          ? error.path
          : resolve(options.packageDirectory.packageRoot, relativePath),
        error.reason,
      );
    }
    throw error;
  }

  const id = createArtifactId({
    directories: captured.directories,
    files: captured.files,
    packageDirectory: options.packageDirectory,
    provenance: options.provenance,
  });

  return Object.freeze({
    id,
    packageDirectory: options.packageDirectory,
    provenance: options.provenance,
    directories: captured.directories,
    files: captured.files,
  } satisfies RuntimePluginPackageArtifact);
}

export function activateRuntimePluginPackageArtifact(options: {
  readonly artifact: RuntimePluginPackageArtifact;
  readonly entryRelativePath: string;
}): string {
  if (options.artifact.provenance !== 'operator') {
    throw new TypeError(
      'Bundled runtime plugin packages must use their host-bound factory.',
    );
  }
  const entryRelativePath = normalizeArtifactRelativePath(
    options.entryRelativePath,
  );

  if (!options.artifact.files.has(entryRelativePath)) {
    throw new TypeError('Runtime plugin artifact entry is unavailable.');
  }
  const active = activatedArtifacts.get(options.artifact.id);
  if (active === undefined) {
    activatedArtifacts.set(options.artifact.id, options.artifact);
  } else if (!runtimePluginArtifactsEqual(active, options.artifact)) {
    throw new TypeError(
      'Runtime plugin artifact identifier collision was rejected.',
    );
  }
  ensureRuntimePluginArtifactHooks();
  return createArtifactUrl(options.artifact.id, entryRelativePath);
}

function createArtifactId(options: {
  readonly directories: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, CapturedPackageFile>;
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly provenance: RuntimePluginPackageProvenance;
}): string {
  const hash = createHash('sha256');
  const directories = [...options.directories].sort(compareText);
  const files = [...options.files].sort(([left], [right]) =>
    compareText(left, right),
  );

  updateArtifactIdFrame(hash, 'version', runtimePluginArtifactIdVersion);
  updateArtifactIdFrame(hash, 'provenance', options.provenance);
  updateArtifactIdFrame(
    hash,
    'package-root',
    options.packageDirectory.realPackageRoot,
  );
  updateArtifactIdFrame(
    hash,
    'directory-count',
    encodeCount(directories.length),
  );
  for (const relativePath of directories) {
    updateArtifactIdFrame(hash, 'entry-type', 'directory');
    updateArtifactIdFrame(hash, 'directory-path', relativePath);
  }
  updateArtifactIdFrame(hash, 'file-count', encodeCount(files.length));
  for (const [relativePath, file] of files) {
    updateArtifactIdFrame(hash, 'entry-type', file.type);
    updateArtifactIdFrame(hash, 'file-path', relativePath);
    updateArtifactIdFrame(hash, 'file-source', file.source);
  }
  return hash.digest('hex');
}

function updateArtifactIdFrame(
  hash: ReturnType<typeof createHash>,
  type: string,
  value: string | Uint8Array,
): void {
  const typeBytes = Buffer.from(type, 'utf8');
  const valueBytes =
    typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const header = Buffer.allocUnsafe(8);

  header.writeUInt32BE(typeBytes.byteLength, 0);
  header.writeUInt32BE(valueBytes.byteLength, 4);
  hash.update(header);
  hash.update(typeBytes);
  hash.update(valueBytes);
}

function encodeCount(value: number): Buffer {
  const encoded = Buffer.allocUnsafe(4);

  encoded.writeUInt32BE(value, 0);
  return encoded;
}

function runtimePluginArtifactsEqual(
  left: RuntimePluginPackageArtifact,
  right: RuntimePluginPackageArtifact,
): boolean {
  if (
    left.provenance !== right.provenance ||
    left.packageDirectory.realPackageRoot !==
      right.packageDirectory.realPackageRoot ||
    left.directories.size !== right.directories.size ||
    left.files.size !== right.files.size
  ) {
    return false;
  }
  for (const directory of left.directories) {
    if (!right.directories.has(directory)) {
      return false;
    }
  }
  for (const [path, leftFile] of left.files) {
    const rightFile = right.files.get(path);

    if (rightFile === undefined || !leftFile.source.equals(rightFile.source)) {
      return false;
    }
  }
  return true;
}

function ensureRuntimePluginArtifactHooks(): void {
  if (artifactHooksRegistered) {
    return;
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const directAddress = parseArtifactAddress(specifier);

      if (directAddress !== undefined) {
        return resolveCapturedArtifactFile(directAddress);
      }

      const parentAddress = parseArtifactAddress(context.parentURL);

      if (parentAddress === undefined) {
        return nextResolve(specifier, context);
      }
      return resolveFromArtifact({
        specifier,
        parentAddress,
        context,
        nextResolve,
      });
    },
    load(url, context, nextLoad) {
      const address = parseArtifactAddress(url);

      if (address === undefined) {
        return nextLoad(url, context);
      }
      const file = address.artifact.files.get(address.relativePath);

      if (file === undefined) {
        throw new TypeError('Runtime plugin artifact module is unavailable.');
      }
      return {
        format: runtimePluginArtifactModuleFormat(address.relativePath),
        source: file.source,
        shortCircuit: true,
      };
    },
  });
  artifactHooksRegistered = true;
}

function resolveFromArtifact(options: {
  readonly specifier: string;
  readonly parentAddress: RuntimePluginArtifactAddress;
  readonly context: ResolveHookContext;
  readonly nextResolve: RuntimePluginArtifactNextResolve;
}) {
  const parentFile = options.parentAddress.artifact.files.get(
    options.parentAddress.relativePath,
  );

  if (parentFile === undefined) {
    throw new TypeError('Runtime plugin artifact parent is unavailable.');
  }
  const physicalParentUrl = pathToFileURL(parentFile.absolutePath).href;

  if (isBuiltin(options.specifier)) {
    return options.nextResolve(options.specifier, {
      ...options.context,
      parentURL: physicalParentUrl,
    });
  }
  if (isRelativeModuleSpecifier(options.specifier)) {
    return resolveRelativeArtifactSpecifier({
      ...options,
      physicalParentUrl,
    });
  }
  throw new TypeError(
    'Operator runtime plugin packages must be self-contained.',
  );
}

function resolveRelativeArtifactSpecifier(options: {
  readonly specifier: string;
  readonly parentAddress: RuntimePluginArtifactAddress;
  readonly physicalParentUrl: string;
  readonly context: ResolveHookContext;
  readonly nextResolve: RuntimePluginArtifactNextResolve;
}) {
  const physicalUrl = new URL(options.specifier, options.physicalParentUrl);
  const physicalPath = fileURLToPath(physicalUrl);
  const artifact = options.parentAddress.artifact;
  const relativePath = artifactRelativePathIfContained(
    artifact.packageDirectory.realPackageRoot,
    physicalPath,
  );

  if (relativePath !== undefined) {
    const address = parseArtifactAddress(
      createArtifactUrl(
        artifact.id,
        relativePath,
        physicalUrl.search,
        physicalUrl.hash,
      ),
    );

    if (address === undefined || !artifact.files.has(relativePath)) {
      throw new TypeError('Runtime plugin artifact import is unavailable.');
    }
    return resolveCapturedArtifactFile(address);
  }
  throw new TypeError(
    'Operator runtime plugin packages must be self-contained.',
  );
}

function resolveCapturedArtifactFile(address: RuntimePluginArtifactAddress) {
  if (!address.artifact.files.has(address.relativePath)) {
    throw new TypeError('Runtime plugin artifact module is unavailable.');
  }
  return {
    url: createArtifactUrl(
      address.artifact.id,
      address.relativePath,
      address.search,
      address.hash,
    ),
    format: runtimePluginArtifactModuleFormat(address.relativePath),
    shortCircuit: true,
  };
}

function parseArtifactAddress(
  value: string | undefined,
): RuntimePluginArtifactAddress | undefined {
  if (value === undefined || !value.startsWith(runtimePluginArtifactProtocol)) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const artifact = activatedArtifacts.get(url.hostname);

  if (artifact === undefined) {
    return undefined;
  }
  const relativePath = normalizeArtifactRelativePath(
    decodeURIComponent(url.pathname.slice(1)),
  );

  return {artifact, relativePath, search: url.search, hash: url.hash};
}

function createArtifactUrl(
  id: string,
  relativePath: string,
  search = '',
  hash = '',
): string {
  const pathname = normalizeArtifactRelativePath(relativePath)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `${runtimePluginArtifactProtocol}//${id}/${pathname}${search}${hash}`;
}

function runtimePluginArtifactModuleFormat(
  relativePath: string,
): 'module' | 'module-typescript' {
  switch (extname(relativePath)) {
    case '.js':
    case '.mjs':
      return 'module';
    case '.ts':
      return 'module-typescript';
    default:
      throw new TypeError(
        'Runtime plugin artifact module format is unsupported.',
      );
  }
}

function artifactRelativePathIfContained(
  root: string,
  path: string,
): string | undefined {
  const relativePath = relative(resolve(root), resolve(path));

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return normalizeArtifactRelativePath(relativePath);
}

function normalizeArtifactRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function isRelativeModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function artifactError(
  path: string,
  reason: RuntimePluginPackageArtifactError['reason'],
): RuntimePluginPackageArtifactError {
  return new RuntimePluginPackageArtifactError({path, reason});
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
