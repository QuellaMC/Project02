import {canonicalPath, PathResolutionError} from '../../shared/real-path.ts';

export {PathResolutionError as RuntimeConfigPathResolutionError};

/** `--config` may name a link to a file not yet written; links can dangle. */
export function canonicalRuntimeConfigPath(path: string): string {
  return canonicalPath(path, {followDanglingLinks: true});
}
