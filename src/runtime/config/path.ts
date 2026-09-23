import {canonicalPath, PathResolutionError} from '../../shared/real-path.ts';

export {PathResolutionError as RuntimeConfigPathResolutionError};

/**
 * The one canonicalization for runtime config paths: a home may be reached
 * through a link, its config file may not exist yet, and links can dangle.
 * The caller names the domain error, so a failure is never classed by the
 * file it was raised in.
 */
export function canonicalRuntimeConfigPath(
  path: string,
  toDomainError: (cause: PathResolutionError) => Error = cause => cause,
): string {
  try {
    return canonicalPath(path, {followDanglingLinks: true});
  } catch (error: unknown) {
    throw error instanceof PathResolutionError ? toDomainError(error) : error;
  }
}
