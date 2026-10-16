import {
  isValidSpeakerDisplayName,
  localUserSpeaker,
  maxSpeakerDisplayNameLength,
} from '../../core/index.ts';
import {
  runtimeConfigValueMatchesField,
  type RuntimeConfigFieldDeclaration,
} from '../../plugins/api/index.ts';
import {
  project02RoleModelProviderValues,
  type RuntimeConfigValue,
} from './types.ts';

export type Project02ConfigFieldDefinition = RuntimeConfigFieldDeclaration & {
  readonly path: string;
  readonly invalidValueCode: string;
  readonly invalidValueMessage: string;
  readonly agentMutable: false;
  readonly reloadRequired: boolean;
  /** Narrows `valueType` where the field's real rule is stricter. */
  readonly acceptsValue?: (value: RuntimeConfigValue) => boolean;
};

// Stated once: each declaration below carries its default, and code that
// needs the value typed reads the same name.
export const defaultProject02Enabled = true;
export const defaultProject02RoleModelProvider = 'local';
/** A safe floor for small local models; a stopgap until providers report their own limit. */
export const defaultProject02ContextWindowTokens = 32768;

const project02ConfigFieldDefinitions = Object.freeze([
  Object.freeze({
    path: 'project02.userDisplayName',
    name: 'userDisplayName',
    description:
      'The name you go by in conversation. Applies to new conversations; ' +
      'earlier ones keep the name they were started with.',
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage:
      'Project02 userDisplayName must be a non-empty single-line string of ' +
      `at most ${String(maxSpeakerDisplayNameLength)} characters.`,
    required: false,
    secret: false,
    valueType: 'string',
    defaultValue: localUserSpeaker.displayName,
    // Must accept exactly what `createUserSpeaker` accepts, or chat throws
    // later. Trimmed because resolution trims before constructing the speaker.
    acceptsValue: value =>
      typeof value === 'string' && isValidSpeakerDisplayName(value.trim()),
    redactionLabels: Object.freeze([]),
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.roleModelProvider',
    name: 'roleModelProvider',
    description:
      'Who answers as the character: the built-in local voice, or a model ' +
      'hosted by NVIDIA.',
    invalidValueCode: 'runtime_config_role_model_provider_invalid',
    invalidValueMessage:
      'Project02 roleModelProvider must be "local" or "nvidia".',
    required: false,
    secret: false,
    valueType: 'enum',
    defaultValue: defaultProject02RoleModelProvider,
    allowedValues: Object.freeze([...project02RoleModelProviderValues]),
    redactionLabels: Object.freeze([]),
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.nvidiaApiKey',
    name: 'nvidiaApiKey',
    description:
      'Your NVIDIA API key. Needed when the provider is nvidia; never shown ' +
      'back once saved.',
    invalidValueCode: 'runtime_config_secret_value_invalid',
    invalidValueMessage: 'Project02 nvidiaApiKey must be a non-empty string.',
    required: false,
    secret: true,
    valueType: 'secret',
    redactionLabels: Object.freeze(['secret']),
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.nvidiaModel',
    name: 'nvidiaModel',
    description:
      "The NVIDIA model to talk to; the provider's default when left unset.",
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage: 'Project02 nvidiaModel must be a non-empty string.',
    required: false,
    secret: false,
    valueType: 'string',
    redactionLabels: Object.freeze([]),
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.contextWindowTokens',
    name: 'contextWindowTokens',
    description:
      'How much conversation the model can hold at once, in tokens; up to ' +
      'half of it replays past messages. Lower it if the model runs out of ' +
      'room.',
    invalidValueCode: 'runtime_config_context_window_tokens_invalid',
    invalidValueMessage:
      'Project02 contextWindowTokens must be a positive whole number of tokens.',
    required: false,
    secret: false,
    valueType: 'number',
    defaultValue: defaultProject02ContextWindowTokens,
    acceptsValue: value =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    redactionLabels: Object.freeze([]),
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.defaultMemoryProvider',
    name: 'defaultMemoryProvider',
    description:
      'Which enabled memory plugin keeps what the character remembers, when ' +
      'more than one is enabled.',
    invalidValueCode: 'runtime_config_string_invalid',
    invalidValueMessage: 'Runtime config field must be a non-empty string.',
    required: false,
    secret: false,
    valueType: 'string',
    redactionLabels: Object.freeze([]),
    agentMutable: false,
    reloadRequired: true,
  } satisfies Project02ConfigFieldDefinition),
  Object.freeze({
    path: 'project02.enabled',
    name: 'enabled',
    description:
      'Whether the character is switched on. A character that is off is not ' +
      'started and cannot be reached; turning it back on starts it.',
    invalidValueCode: 'runtime_config_boolean_invalid',
    invalidValueMessage: 'Project02 enabled must be a boolean.',
    required: false,
    secret: false,
    valueType: 'boolean',
    defaultValue: defaultProject02Enabled,
    redactionLabels: Object.freeze([]),
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

/**
 * The one judge of an authored Project02 field value, for every writer and
 * the loader. A blank string is never a value: unsetting is its own operation.
 */
export function project02RuntimeConfigFieldAcceptsValue(
  value: RuntimeConfigValue,
  field: Project02ConfigFieldDefinition,
): boolean {
  return (
    runtimeConfigValueMatchesField(value, field) &&
    (field.acceptsValue?.(value) ?? true) &&
    !(typeof value === 'string' && value.trim().length === 0)
  );
}

export function runtimeConfigFieldValueMismatchMessage(
  field: RuntimeConfigFieldDeclaration,
  value: RuntimeConfigValue,
): string {
  const received = runtimeConfigValueKindLabel(value);

  if (field.allowedValues !== undefined) {
    return (
      `Config field "${field.name}" must be one of: ` +
      `${field.allowedValues.join(', ')}; received ${received}` +
      `${typeof value === 'string' ? ' that is not an allowed value' : ''}.`
    );
  }

  return `Config field "${field.name}" must be ${runtimeConfigValueTypeLabel(
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
  valueType: RuntimeConfigFieldDeclaration['valueType'],
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
