import {isProject02Identifier} from '../../shared/identifier.ts';

export type RoleModelAllowedToolName = string;

export function isRoleModelToolNameSyntax(value: string): boolean {
  return isProject02Identifier(value);
}

export function requiredRoleModelIdentifier(
  value: string,
  field: string,
): string {
  if (!isRoleModelToolNameSyntax(value)) {
    throw new TypeError(
      `Role-model ${field} must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  return value;
}
