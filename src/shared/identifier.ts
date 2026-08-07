const project02IdentifierPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export function isProject02Identifier(value: unknown): boolean {
  return typeof value === 'string' && project02IdentifierPattern.test(value);
}

/**
 * The key two identifiers collide on when one names a durable directory.
 *
 * Case-insensitive volumes (default macOS and Windows) are the reason: ids
 * that fold together address one directory there and two directories
 * elsewhere, so a runtime that treats them as distinct is only portable by
 * accident. ASCII lowercasing is the complete fold for the accepted
 * charset above rather than an approximation of one; widening the pattern
 * to non-ASCII means widening this fold in the same edit.
 */
export function project02IdentifierCollisionKey(id: string): string {
  return id.toLowerCase();
}

export function displayNameFromProject02Identifier(id: string): string {
  return id
    .split(/[._-]/u)
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
