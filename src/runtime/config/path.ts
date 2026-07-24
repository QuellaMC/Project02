import {lstatSync, readlinkSync, realpathSync} from 'node:fs';
import {basename, dirname, resolve} from 'node:path';

export class RuntimeConfigPathResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigPathResolutionError';
  }
}

export function canonicalRuntimeConfigPath(path: string): string {
  return canonicalAbsoluteRuntimeConfigPath(resolve(path), new Set<string>());
}

function canonicalAbsoluteRuntimeConfigPath(
  path: string,
  followedSymlinks: Set<string>,
): string {
  try {
    return realpathSync.native(path);
  } catch {
    const symlinkTargetPath = danglingSymlinkTargetPath(path, followedSymlinks);

    return symlinkTargetPath === undefined
      ? canonicalMissingRuntimeConfigPath(path, followedSymlinks)
      : canonicalAbsoluteRuntimeConfigPath(symlinkTargetPath, followedSymlinks);
  }
}

function danglingSymlinkTargetPath(
  path: string,
  followedSymlinks: Set<string>,
): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      return undefined;
    }

    if (followedSymlinks.has(path)) {
      throw new RuntimeConfigPathResolutionError(
        `Could not resolve runtime config path because ${path} is part of a symlink cycle.`,
      );
    }

    followedSymlinks.add(path);
    return resolve(dirname(path), readlinkSync(path));
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigPathResolutionError) {
      throw error;
    }

    return undefined;
  }
}

function canonicalMissingRuntimeConfigPath(
  path: string,
  followedSymlinks: Set<string>,
): string {
  const parent = dirname(path);

  if (parent === path) {
    return path;
  }

  return resolve(
    canonicalAbsoluteRuntimeConfigPath(parent, followedSymlinks),
    basename(path),
  );
}
