export const project02IdentifierMaxLength = 128;

/** Built from the one length above so the two can never disagree. */
const project02IdentifierPattern = new RegExp(
  `^[A-Za-z][A-Za-z0-9._-]{0,${String(project02IdentifierMaxLength - 1)}}$`,
  'u',
);

export function isProject02Identifier(value: unknown): boolean {
  return typeof value === 'string' && project02IdentifierPattern.test(value);
}

/**
 * Case-insensitive volumes (default on macOS and Windows) address ids that
 * fold together as one directory. ASCII lowercasing is the complete fold for
 * the pattern above; widening that pattern means widening this fold.
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
