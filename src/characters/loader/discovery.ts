/**
 * Discovery for character packages: scans bundled and operator roots,
 * validates descriptors, and applies the identity policy. Character
 * packages are data-only, so discovery returns validated definitions
 * directly — there is no load phase. Unlike plugin discovery, a character
 * id discovered in more than one place is an error for every candidate:
 * explicit beats precedence magic, because exactly one definition may own
 * a character id per runtime.
 */
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  readBoundedPackageJsonFile,
  scanPackageSourceRoot,
  type BoundedPackageJsonRejectionReason,
} from '../../shared/package-metadata.ts';
import {
  characterPackageDescriptorFileName,
  parseCharacterPackageDescriptor,
  type CharacterDefinition,
} from '../api/package-descriptor.ts';

export const maxCharacterPackageDescriptorBytes = 64 * 1024;

export const bundledCharacterPackagesRoot = fileURLToPath(
  new URL('../packages/', import.meta.url),
);

export function operatorCharacterPackagesRoot(storeRoot: string): string {
  return join(storeRoot, 'characters');
}

export type CharacterPackageProvenance = 'bundled' | 'operator';

export type CharacterPackageSource = {
  readonly root: string;
  readonly provenance: CharacterPackageProvenance;
};

export function defaultCharacterPackageSources(
  storeRoot?: string,
): readonly CharacterPackageSource[] {
  return Object.freeze([
    Object.freeze({
      root: bundledCharacterPackagesRoot,
      provenance: 'bundled',
    } satisfies CharacterPackageSource),
    ...(storeRoot === undefined
      ? []
      : [
          Object.freeze({
            root: operatorCharacterPackagesRoot(storeRoot),
            provenance: 'operator',
          } satisfies CharacterPackageSource),
        ]),
  ]);
}

export type DiscoveredCharacterPackage = {
  readonly definition: CharacterDefinition;
  readonly provenance: CharacterPackageProvenance;
  readonly packageRoot: string;
  readonly descriptorPath: string;
};

export type CharacterPackageDiagnostic = {
  readonly severity: 'error';
  readonly code:
    | 'package_source_unavailable'
    | 'invalid_package_directory'
    | 'invalid_descriptor'
    | 'invalid_identity'
    | 'invalid_persona'
    | 'invalid_meta'
    | 'invalid_plugins'
    | 'package_id_mismatch'
    | 'duplicate_character_id';
  readonly message: string;
  readonly path: string;
  readonly provenance: CharacterPackageProvenance;
  readonly characterId?: string;
};

export type CharacterPackageDiscovery = {
  readonly characters: readonly DiscoveredCharacterPackage[];
  readonly diagnostics: readonly CharacterPackageDiagnostic[];
};

export function discoverCharacterPackages(options: {
  readonly sources: readonly CharacterPackageSource[];
}): CharacterPackageDiscovery {
  const candidates: DiscoveredCharacterPackage[] = [];
  const diagnostics: CharacterPackageDiagnostic[] = [];

  for (const source of options.sources) {
    const scan = scanPackageSourceRoot(source.root);

    if (scan.status === 'unavailable') {
      // A missing root or a root that is not a directory both mean "no
      // packages here"; a corrupt store surfaces through the storage
      // layer's own diagnostics instead.
      if (
        isNodeErrorWithCode(scan.error, 'ENOENT') ||
        isNodeErrorWithCode(scan.error, 'ENOTDIR')
      ) {
        continue;
      }

      diagnostics.push(
        characterDiagnostic({
          code: 'package_source_unavailable',
          message: 'Character package source is unavailable.',
          path: source.root,
          provenance: source.provenance,
        }),
      );
      continue;
    }

    for (const candidate of scan.candidates) {
      const packageRoot = join(source.root, candidate.name);

      if (candidate.kind === 'symbolic_link') {
        diagnostics.push(
          characterDiagnostic({
            code: 'invalid_package_directory',
            message:
              'Character package directories must not be symbolic links.',
            path: packageRoot,
            provenance: source.provenance,
            characterId: candidate.name,
          }),
        );
        continue;
      }

      const discovered = discoverCharacterPackage({
        packageRoot,
        provenance: source.provenance,
      });

      if ('diagnostic' in discovered) {
        diagnostics.push(discovered.diagnostic);
        continue;
      }

      candidates.push(discovered.package);
    }
  }

  const characters = applyCharacterIdentityPolicy({candidates, diagnostics});

  diagnostics.sort(
    (left, right) =>
      compareText(left.path, right.path) || compareText(left.code, right.code),
  );

  return Object.freeze({
    characters: Object.freeze(characters),
    diagnostics: Object.freeze(diagnostics),
  } satisfies CharacterPackageDiscovery);
}

type DiscoverCharacterPackageResult =
  | {readonly package: DiscoveredCharacterPackage}
  | {readonly diagnostic: CharacterPackageDiagnostic};

function discoverCharacterPackage(options: {
  readonly packageRoot: string;
  readonly provenance: CharacterPackageProvenance;
}): DiscoverCharacterPackageResult {
  const characterId = basename(options.packageRoot);
  const descriptorPath = join(
    options.packageRoot,
    characterPackageDescriptorFileName,
  );
  const descriptor = readCharacterDescriptorFile({
    path: descriptorPath,
    provenance: options.provenance,
    characterId,
  });

  if ('diagnostic' in descriptor) {
    return descriptor;
  }

  const parsed = parseCharacterPackageDescriptor(descriptor.value);

  if (parsed.status === 'rejected') {
    return {
      diagnostic: characterDiagnostic({
        code: parsed.issue.code,
        message: parsed.issue.message,
        path: descriptorPath,
        provenance: options.provenance,
        characterId,
      }),
    };
  }

  if (parsed.definition.identity.id !== characterId) {
    return {
      diagnostic: characterDiagnostic({
        code: 'package_id_mismatch',
        message: 'Character package folder must match its identity.id.',
        path: descriptorPath,
        provenance: options.provenance,
        characterId,
      }),
    };
  }

  return {
    package: Object.freeze({
      definition: parsed.definition,
      provenance: options.provenance,
      packageRoot: options.packageRoot,
      descriptorPath,
    } satisfies DiscoveredCharacterPackage),
  };
}

type ReadCharacterDescriptorFileResult =
  {readonly value: unknown} | {readonly diagnostic: CharacterPackageDiagnostic};

function readCharacterDescriptorFile(options: {
  readonly path: string;
  readonly provenance: CharacterPackageProvenance;
  readonly characterId: string;
}): ReadCharacterDescriptorFileResult {
  const reject = (message: string): ReadCharacterDescriptorFileResult => ({
    diagnostic: characterDiagnostic({
      code: 'invalid_descriptor',
      message,
      path: options.path,
      provenance: options.provenance,
      characterId: options.characterId,
    }),
  });
  const descriptor = readBoundedPackageJsonFile({
    path: options.path,
    maxBytes: maxCharacterPackageDescriptorBytes,
    boundaryField: 'Character package descriptor',
  });

  if (descriptor.status === 'rejected') {
    return reject(characterDescriptorReadMessage(descriptor.reason));
  }

  return {value: descriptor.value};
}

function characterDescriptorReadMessage(
  reason: BoundedPackageJsonRejectionReason,
): string {
  switch (reason) {
    case 'unreadable':
      return 'Character package descriptor is unreadable.';
    case 'symbolic_link':
      return 'Character package descriptor must not be a symbolic link.';
    case 'not_file':
      return 'Character package descriptor must be a regular file.';
    case 'too_large':
      return 'Character package descriptor exceeds the size limit.';
    case 'invalid_json':
      return 'Character package descriptor must contain valid JSON.';
    case 'unsafe_json':
      return 'Character package descriptor exceeds safe JSON limits.';
  }
}

function applyCharacterIdentityPolicy(options: {
  readonly candidates: readonly DiscoveredCharacterPackage[];
  readonly diagnostics: CharacterPackageDiagnostic[];
}): DiscoveredCharacterPackage[] {
  const candidatesByCharacterId = new Map<
    string,
    DiscoveredCharacterPackage[]
  >();

  for (const candidate of options.candidates) {
    const characterId = candidate.definition.identity.id;
    const matching = candidatesByCharacterId.get(characterId) ?? [];

    matching.push(candidate);
    candidatesByCharacterId.set(characterId, matching);
  }

  const characters: DiscoveredCharacterPackage[] = [];

  for (const [characterId, matching] of [...candidatesByCharacterId].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    const first = matching[0];

    if (matching.length === 1 && first !== undefined) {
      characters.push(first);
      continue;
    }

    for (const candidate of matching) {
      options.diagnostics.push(
        characterDiagnostic({
          code: 'duplicate_character_id',
          message:
            `Character package id "${characterId}" is defined in more than ` +
            'one place; remove or rename one of the packages.',
          path: candidate.descriptorPath,
          provenance: candidate.provenance,
          characterId,
        }),
      );
    }
  }

  return characters;
}

function characterDiagnostic(
  options: Omit<CharacterPackageDiagnostic, 'severity'>,
): CharacterPackageDiagnostic {
  return Object.freeze({
    severity: 'error',
    code: options.code,
    message: options.message,
    path: options.path,
    provenance: options.provenance,
    ...(options.characterId === undefined
      ? {}
      : {characterId: options.characterId}),
  } satisfies CharacterPackageDiagnostic);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
