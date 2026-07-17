import { userTurnBuiltInModelToolNames } from './model-tools.ts';

export type RoleModelAllowedToolName = string;

export const roleModelAllowedToolNames = userTurnBuiltInModelToolNames;

export function isRoleModelAllowedToolName(
  value: unknown
): value is RoleModelAllowedToolName {
  return typeof value === 'string' && isRoleModelToolNameSyntax(value);
}

export function hasDuplicateRoleModelAllowedTools(
  values: readonly unknown[]
): boolean {
  return new Set(values).size !== values.length;
}

export function isRoleModelToolNameSyntax(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

export function requiredRoleModelIdentifier(value: string, field: string): string {
  if (!isRoleModelToolNameSyntax(value)) {
    throw new TypeError(
      `Role-model ${field} must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`
    );
  }

  return value;
}
