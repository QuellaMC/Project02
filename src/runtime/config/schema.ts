import type {RuntimePluginConfigField} from '../../plugins/api/index.ts';

import {
  project02RoleModelProviderValues,
  type RuntimeConfigFieldScope,
  type RuntimeConfigValue,
} from './types.ts';

export type Project02ConfigFieldDefinition = RuntimePluginConfigField & {
  readonly path: string;
  readonly label: string;
  readonly invalidValueCode: string;
  readonly invalidValueMessage: string;
  readonly agentMutable: false;
  readonly reloadRequired: boolean;
  readonly scopes: readonly RuntimeConfigFieldScope[];
};

const globalOnlyFieldScopes = Object.freeze([
  'global',
] satisfies RuntimeConfigFieldScope[]);
const characterScopedFieldScopes = Object.freeze([
  'global',
  'character',
] satisfies RuntimeConfigFieldScope[]);

const project02ConfigFieldDefinitions = Object.freeze([
  Object.freeze({
    path: 'project02.storeRoot',
    name: 'storeRoot',
    label: 'Runtime store root',
    description:
      'The Project02 home: global config, secrets, installed packages, and ' +
      'the per-character data directories.',
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage: 'Runtime config field must be a non-empty string.',
    required: false,
    secret: false,
    valueType: 'path',
    defaultValueSummary: '.project02',
    redactionLabels: Object.freeze([]),
    scopes: globalOnlyFieldScopes,
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.defaultMemoryProvider',
    name: 'defaultMemoryProvider',
    label: 'Default memory provider',
    description: 'Selects one already-enabled memory provider.',
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage: 'Runtime config field must be a non-empty string.',
    required: false,
    secret: false,
    valueType: 'string',
    redactionLabels: Object.freeze([]),
    scopes: characterScopedFieldScopes,
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.character',
    name: 'character',
    label: 'Character',
    description:
      'Selects the default active character package for this Project02 home.',
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage: 'Runtime config field must be a non-empty string.',
    required: false,
    secret: false,
    valueType: 'string',
    defaultValueSummary: 'mira',
    redactionLabels: Object.freeze([]),
    scopes: globalOnlyFieldScopes,
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.roleModelProvider',
    name: 'roleModelProvider',
    label: 'Role-model provider',
    description: 'Default role-model provider used by the Project02 chat CLI.',
    invalidValueCode: 'runtime_config_role_model_provider_invalid',
    invalidValueMessage:
      'Project02 roleModelProvider must be "local" or "nvidia".',
    required: false,
    secret: false,
    valueType: 'enum',
    defaultValueSummary: 'local',
    allowedValues: Object.freeze([...project02RoleModelProviderValues]),
    redactionLabels: Object.freeze([]),
    scopes: characterScopedFieldScopes,
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.userDisplayName',
    name: 'userDisplayName',
    label: 'User display name',
    description:
      "Speaker name stamped on the local user's messages. Applies to new " +
      'sessions; existing sessions keep their historical name.',
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage: 'Runtime config field must be a non-empty string.',
    required: false,
    secret: false,
    valueType: 'string',
    defaultValueSummary: 'You',
    redactionLabels: Object.freeze([]),
    scopes: characterScopedFieldScopes,
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
]);

export function project02RuntimeConfigFieldDefinitions(): readonly Project02ConfigFieldDefinition[] {
  return project02ConfigFieldDefinitions;
}

export function project02RuntimeConfigFieldDefinition(
  name: string,
): Project02ConfigFieldDefinition | undefined {
  return project02ConfigFieldDefinitions.find(field => field.name === name);
}

export function project02RuntimeConfigFieldNames(): readonly string[] {
  return Object.freeze(
    project02ConfigFieldDefinitions.map(field => field.name),
  );
}

export function characterRuntimeConfigFieldScopeViolation(
  field: Project02ConfigFieldDefinition,
): string | undefined {
  return field.scopes.includes('character')
    ? undefined
    : `Config field "${field.path}" is global-only; set it in the home ` +
        'config.json, not the character overlay.';
}

export function runtimeConfigValueMatchesField(
  value: RuntimeConfigValue,
  field: RuntimePluginConfigField,
): boolean {
  if (
    field.allowedValues !== undefined &&
    (typeof value !== 'string' || !field.allowedValues.includes(value))
  ) {
    return false;
  }

  switch (field.valueType) {
    case undefined:
      return true;
    case 'string':
    case 'path':
    case 'enum':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    case 'array':
      return Array.isArray(value);
    case 'secret':
      return field.secret;
  }

  return true;
}

/**
 * Model-facing companion to runtimeConfigValueMatchesField: names the
 * expected type or allowed values and the received value kind so a rejected
 * config update can be corrected without guessing.
 */
export function runtimeConfigFieldValueMismatchMessage(
  field: RuntimePluginConfigField,
  value: RuntimeConfigValue,
): string {
  const received = runtimeConfigValueKindLabel(value);

  if (field.allowedValues !== undefined) {
    return (
      `Plugin config field "${field.name}" must be one of: ` +
      `${field.allowedValues.join(', ')}; received ${received}` +
      `${typeof value === 'string' ? ' that is not an allowed value' : ''}.`
    );
  }

  return `Plugin config field "${field.name}" must be ${runtimeConfigValueTypeLabel(
    field.valueType,
  )}; received ${received}.`;
}

function runtimeConfigValueKindLabel(value: RuntimeConfigValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';

  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    default:
      return 'an object';
  }
}

function runtimeConfigValueTypeLabel(
  valueType: RuntimePluginConfigField['valueType'],
): string {
  switch (valueType) {
    case 'string':
    case 'path':
    case 'enum':
      return 'a string';
    case 'number':
      return 'a finite number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'a plain object';
    case 'array':
      return 'an array';
    case 'secret':
      return 'a secret value';
    case undefined:
      return 'a JSON value';
  }
}
