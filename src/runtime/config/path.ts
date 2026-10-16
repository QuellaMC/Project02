import {canonicalPath, PathResolutionError} from '../../shared/real-path.ts';
import type {RuntimeConfigSectionNamespace} from './types.ts';

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

/** One spelling of a section's place in a document, or a field's, in every namespace. */
export function runtimeConfigSectionPath(
  namespace: RuntimeConfigSectionNamespace,
  id: string,
  field?: string,
): string {
  return field === undefined
    ? `${namespace}.${id}`
    : `${namespace}.${id}.config.${field}`;
}
