/**
 * Mechanical filesystem boundary shared by character and plugin package
 * discovery. Callers retain ownership of source policy, diagnostics,
 * descriptor parsing, and package identity.
 */
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import type {Dirent} from 'node:fs';

import {
  createJsonBoundarySnapshot,
  type JsonBoundaryValue,
} from './json-boundary.ts';

export type PackageSourceCandidate = {
  readonly name: string;
  readonly kind: 'directory' | 'symbolic_link';
};

export type PackageSourceScanResult =
  | {
      readonly status: 'scanned';
      readonly candidates: readonly PackageSourceCandidate[];
    }
  | {
      readonly status: 'unavailable';
      readonly error: unknown;
    };

export function scanPackageSourceRoot(root: string): PackageSourceScanResult {
  let entries: Dirent[];

  try {
    entries = readdirSync(root, {withFileTypes: true});
  } catch (error: unknown) {
    return Object.freeze({status: 'unavailable', error});
  }

  const candidates = entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry =>
      Object.freeze({
        name: entry.name,
        kind: entry.isSymbolicLink() ? 'symbolic_link' : 'directory',
      } satisfies PackageSourceCandidate),
    )
    .sort((left, right) => compareText(left.name, right.name));

  return Object.freeze({
    status: 'scanned',
    candidates: Object.freeze(candidates),
  });
}

export type BoundedPackageJsonRejectionReason =
  | 'unreadable'
  | 'symbolic_link'
  | 'not_file'
  | 'too_large'
  | 'invalid_json'
  | 'unsafe_json';

export type BoundedPackageJsonReadResult =
  | {
      readonly status: 'accepted';
      readonly value: JsonBoundaryValue;
    }
  | {
      readonly status: 'rejected';
      readonly reason: BoundedPackageJsonRejectionReason;
    };

export function readBoundedPackageJsonFile(options: {
  readonly path: string | URL;
  readonly maxBytes: number;
  readonly boundaryField: string;
}): BoundedPackageJsonReadResult {
  let metadataStat;

  try {
    metadataStat = lstatSync(options.path);
  } catch {
    return rejectedPackageJson('unreadable');
  }

  if (metadataStat.isSymbolicLink()) {
    return rejectedPackageJson('symbolic_link');
  }
  if (!metadataStat.isFile()) {
    return rejectedPackageJson('not_file');
  }
  if (metadataStat.size > options.maxBytes) {
    return rejectedPackageJson('too_large');
  }

  let source: string;

  try {
    source = readFileSync(options.path, 'utf8');
  } catch {
    return rejectedPackageJson('unreadable');
  }

  if (Buffer.byteLength(source, 'utf8') > options.maxBytes) {
    return rejectedPackageJson('too_large');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return rejectedPackageJson('invalid_json');
  }

  try {
    return Object.freeze({
      status: 'accepted',
      value: createJsonBoundarySnapshot(parsed, {
        field: options.boundaryField,
      }),
    });
  } catch {
    return rejectedPackageJson('unsafe_json');
  }
}

function rejectedPackageJson(
  reason: BoundedPackageJsonRejectionReason,
): BoundedPackageJsonReadResult {
  return Object.freeze({status: 'rejected', reason});
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
