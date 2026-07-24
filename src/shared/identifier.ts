export const project02IdentifierPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export function isProject02Identifier(value: unknown): boolean {
  return typeof value === 'string' && project02IdentifierPattern.test(value);
}

export function displayNameFromProject02Identifier(id: string): string {
  return id
    .split(/[._-]/u)
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
