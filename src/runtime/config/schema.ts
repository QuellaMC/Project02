import type {
  RuntimePluginConfigField
} from '../../plugins/plugin-types.ts';

import {
  project02RoleModelProviderValues,
  type RuntimeConfigValue
} from './types.ts';

export type Project02ConfigFieldDefinition = RuntimePluginConfigField & {
  readonly path: string;
  readonly label: string;
  readonly invalidValueCode: string;
  readonly invalidValueMessage: string;
  readonly agentMutable: false;
  readonly reloadRequired: boolean;
};

const project02ConfigFieldDefinitions = Object.freeze([
  Object.freeze({
    path: 'project02.storeRoot',
    name: 'storeRoot',
    label: 'Runtime store root',
    description: 'Directory that owns sessions, logs, plugin data, config, and secrets.',
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage: 'Runtime config field must be a non-empty string.',
    required: false,
    secret: false,
    valueType: 'path',
    defaultValueSummary: '.project02-runtime',
    redactionLabels: Object.freeze([]),
    agentMutable: false,
    reloadRequired: true
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
    agentMutable: false,
    reloadRequired: true
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.roleModelProvider',
    name: 'roleModelProvider',
    label: 'Role-model provider',
    description: 'Default role-model provider used by the Project02 chat CLI.',
    invalidValueCode: 'runtime_config_role_model_provider_invalid',
    invalidValueMessage: 'Project02 roleModelProvider must be "local" or "nvidia".',
    required: false,
    secret: false,
    valueType: 'enum',
    defaultValueSummary: 'local',
    allowedValues: Object.freeze([...project02RoleModelProviderValues]),
    redactionLabels: Object.freeze([]),
    agentMutable: false,
    reloadRequired: true
  } satisfies Project02ConfigFieldDefinition)
]);

export function project02RuntimeConfigFieldDefinitions(): readonly Project02ConfigFieldDefinition[] {
  return project02ConfigFieldDefinitions;
}

export function project02RuntimeConfigFieldDefinition(
  name: string
): Project02ConfigFieldDefinition | undefined {
  return project02ConfigFieldDefinitions.find((field) => field.name === name);
}

export function project02RuntimeConfigFieldNames(): readonly string[] {
  return Object.freeze(project02ConfigFieldDefinitions.map((field) => field.name));
}

export function runtimeConfigValueMatchesField(
  value: RuntimeConfigValue,
  field: RuntimePluginConfigField
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
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'secret':
      return field.secret;
  }

  return true;
}
