import {canonicalPath, PathResolutionError} from '../../shared/real-path.ts';

export {PathResolutionError as RuntimeConfigPathResolutionError};

/**
 * Config paths are canonicalized through dangling links: `--config` may name a
 * link to a file the caller is about to write, and that names the target, not
 * the link. Path locking compares the results, so two spellings of one file
 * must agree.
 */
export function canonicalRuntimeConfigPath(path: string): string {
  return canonicalPath(path, {followDanglingLinks: true});
}
