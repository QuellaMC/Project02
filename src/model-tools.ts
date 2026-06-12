import {
  characterAttentionValues,
  characterCurrentActivityValues,
  characterEnergyValues,
  characterMoodValues,
  characterSocialOrientationValues
} from './character-state.ts';

export const visibleReplyModelToolName = 'visible_reply';
export const characterStatePatchModelToolName = 'character_state.patch';

export type VisibleReplyModelToolName = typeof visibleReplyModelToolName;
export type CharacterStatePatchModelToolName =
  typeof characterStatePatchModelToolName;
export type BuiltInModelToolName =
  | VisibleReplyModelToolName
  | CharacterStatePatchModelToolName;

export const modelToolInputFieldValueTypes = Object.freeze([
  'string',
  'number',
  'boolean',
  'object',
  'array'
] as const);

export type ModelToolInputFieldValueType =
  (typeof modelToolInputFieldValueTypes)[number];

export type ModelToolInputField = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly valueType?: ModelToolInputFieldValueType;
  readonly allowedValues?: readonly string[];
};

export type ModelToolInputContract = {
  readonly type: 'object';
  readonly fields: readonly ModelToolInputField[];
  readonly additionalFields: boolean;
};

export type ModelToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly requiredForUserTurn: boolean;
  readonly maxCallsPerUserTurn: number;
  readonly inputContract: ModelToolInputContract;
};

export type BuiltInModelToolDefinition = ModelToolDefinition & {
  readonly name: BuiltInModelToolName;
  readonly maxCallsPerUserTurn: 1;
};

export type VisibleReplyToolInput = {
  readonly text: string;
};

export type CharacterStatePatchToolInput = Readonly<Record<string, unknown>>;

export type VisibleReplyModelToolCall = {
  readonly name: VisibleReplyModelToolName;
  readonly input: VisibleReplyToolInput;
};

export type CharacterStatePatchModelToolCall = {
  readonly name: CharacterStatePatchModelToolName;
  readonly input: CharacterStatePatchToolInput;
};

export type BuiltInModelToolCall =
  | VisibleReplyModelToolCall
  | CharacterStatePatchModelToolCall;

export type CapabilityModelToolCall = {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};

export type ModelToolCall = BuiltInModelToolCall | CapabilityModelToolCall;

export const userTurnBuiltInModelToolNames = Object.freeze([
  visibleReplyModelToolName,
  characterStatePatchModelToolName
] satisfies readonly BuiltInModelToolName[]);

export const requiredUserTurnBuiltInModelToolNames = Object.freeze([
  visibleReplyModelToolName
] satisfies readonly BuiltInModelToolName[]);

export const builtInModelToolDefinitions = Object.freeze([
  createBuiltInModelToolDefinition({
    name: visibleReplyModelToolName,
    description: 'Return exactly one visible reply line for the user.',
    requiredForUserTurn: true,
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'text',
          description: 'One visible reply line.',
          required: true
        }
      ],
      additionalFields: false
    }
  }),
  createBuiltInModelToolDefinition({
    name: characterStatePatchModelToolName,
    description:
      'Optionally propose a current character-state patch. Runtime-owned Character State validates accepted fields and values.',
    requiredForUserTurn: false,
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'mood',
          description: 'Current mood.',
          required: false,
          allowedValues: characterMoodValues
        },
        {
          name: 'energy',
          description: 'Current energy.',
          required: false,
          allowedValues: characterEnergyValues
        },
        {
          name: 'attention',
          description: 'Current attention.',
          required: false,
          allowedValues: characterAttentionValues
        },
        {
          name: 'currentActivity',
          description: 'Current activity.',
          required: false,
          allowedValues: characterCurrentActivityValues
        },
        {
          name: 'socialOrientation',
          description: 'Current social orientation.',
          required: false,
          allowedValues: characterSocialOrientationValues
        }
      ],
      additionalFields: false
    }
  })
] satisfies readonly BuiltInModelToolDefinition[]);

export function builtInModelToolDefinitionsForUserTurn(): readonly BuiltInModelToolDefinition[] {
  return Object.freeze([...builtInModelToolDefinitions]);
}

export function isBuiltInModelToolName(
  value: unknown
): value is BuiltInModelToolName {
  return (
    value === visibleReplyModelToolName ||
    value === characterStatePatchModelToolName
  );
}

export function createVisibleReplyModelToolCall(
  text: string
): VisibleReplyModelToolCall {
  return Object.freeze({
    name: visibleReplyModelToolName,
    input: Object.freeze({
      text
    } satisfies VisibleReplyToolInput)
  } satisfies VisibleReplyModelToolCall);
}

export function createCharacterStatePatchModelToolCall(
  input: CharacterStatePatchToolInput
): CharacterStatePatchModelToolCall {
  return Object.freeze({
    name: characterStatePatchModelToolName,
    input: freezeJsonRecord(input)
  } satisfies CharacterStatePatchModelToolCall);
}

export function freezeBuiltInModelToolCall(
  call: BuiltInModelToolCall
): BuiltInModelToolCall {
  if (call.name === visibleReplyModelToolName) {
    return createVisibleReplyModelToolCall(call.input.text);
  }

  return createCharacterStatePatchModelToolCall(call.input);
}

export function freezeBuiltInModelToolCalls(
  calls: readonly BuiltInModelToolCall[]
): readonly BuiltInModelToolCall[] {
  return Object.freeze(calls.map(freezeBuiltInModelToolCall));
}

export function findVisibleReplyModelToolCall(
  calls: readonly ModelToolCall[]
): VisibleReplyModelToolCall | undefined {
  const call = calls.find((candidate) => candidate.name === visibleReplyModelToolName);

  if (call === undefined) {
    return undefined;
  }

  const text = call.input['text'];

  if (typeof text !== 'string') {
    return undefined;
  }

  return createVisibleReplyModelToolCall(text);
}

export function findCharacterStatePatchModelToolCall(
  calls: readonly ModelToolCall[]
): CharacterStatePatchModelToolCall | undefined {
  const call = calls.find(
    (candidate) => candidate.name === characterStatePatchModelToolName
  );

  if (call === undefined) {
    return undefined;
  }

  return createCharacterStatePatchModelToolCall(call.input);
}

export function freezeModelToolDefinition(
  definition: ModelToolDefinition
): ModelToolDefinition {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    requiredForUserTurn: definition.requiredForUserTurn,
    maxCallsPerUserTurn: definition.maxCallsPerUserTurn,
    inputContract: freezeModelToolInputContract(definition.inputContract)
  } satisfies ModelToolDefinition);
}

export function freezeModelToolDefinitions(
  definitions: readonly ModelToolDefinition[]
): readonly ModelToolDefinition[] {
  return Object.freeze(definitions.map(freezeModelToolDefinition));
}

export function freezeModelToolCall(call: ModelToolCall): ModelToolCall {
  if (call.name === visibleReplyModelToolName) {
    const text = call.input['text'];

    return createVisibleReplyModelToolCall(typeof text === 'string' ? text : '');
  }

  if (call.name === characterStatePatchModelToolName) {
    return createCharacterStatePatchModelToolCall(call.input);
  }

  return Object.freeze({
    name: call.name,
    input: freezeJsonRecord(call.input)
  } satisfies CapabilityModelToolCall);
}

export function freezeModelToolCalls(
  calls: readonly ModelToolCall[]
): readonly ModelToolCall[] {
  return Object.freeze(calls.map(freezeModelToolCall));
}

export type ModelToolInputValidationResult =
  | {
      readonly status: 'accepted';
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'rejected';
      readonly details: string;
    };

export function validateModelToolInputAgainstContract(options: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputContract: ModelToolInputContract;
}): ModelToolInputValidationResult {
  const supportedFieldNames = options.inputContract.fields.map(
    (field) => field.name
  );

  if (!options.inputContract.additionalFields) {
    const unsupportedInputKeys = Object.keys(options.input).filter(
      (key) => !supportedFieldNames.includes(key)
    );

    if (unsupportedInputKeys.length > 0) {
      return rejectModelToolInput(
        `${options.toolName} input includes unsupported fields: ${unsupportedInputKeys.join(
          ', '
        )}.`
      );
    }
  }

  for (const field of options.inputContract.fields) {
    const fieldValue = options.input[field.name];

    if (field.required && fieldValue === undefined) {
      return rejectModelToolInput(
        `${options.toolName} input missing required field "${field.name}".`
      );
    }

    if (fieldValue === undefined) {
      continue;
    }

    if (
      field.valueType !== undefined &&
      !modelToolInputValueMatchesType(fieldValue, field.valueType)
    ) {
      return rejectModelToolInput(
        `${options.toolName} input field "${field.name}" must be ${modelToolInputFieldTypeArticle(
          field.valueType
        )} ${modelToolInputFieldTypeLabel(field.valueType)}.`
      );
    }

    if (field.allowedValues === undefined) {
      continue;
    }

    if (
      typeof fieldValue !== 'string' ||
      !field.allowedValues.includes(fieldValue)
    ) {
      return rejectModelToolInput(
        `${options.toolName} input field "${field.name}" must be one of: ${field.allowedValues.join(
          ', '
        )}.`
      );
    }
  }

  const jsonValueValidation = validateModelToolInputJsonValues({
    toolName: options.toolName,
    input: options.input
  });

  if (jsonValueValidation !== undefined) {
    return rejectModelToolInput(jsonValueValidation);
  }

  return Object.freeze({
    status: 'accepted',
    input: freezeJsonRecord(options.input)
  } satisfies ModelToolInputValidationResult);
}

function createBuiltInModelToolDefinition(options: {
  readonly name: BuiltInModelToolName;
  readonly description: string;
  readonly requiredForUserTurn: boolean;
  readonly inputContract: ModelToolInputContract;
}): BuiltInModelToolDefinition {
  return Object.freeze({
    name: options.name,
    description: options.description,
    requiredForUserTurn: options.requiredForUserTurn,
    maxCallsPerUserTurn: 1,
    inputContract: freezeModelToolInputContract(options.inputContract)
  } satisfies BuiltInModelToolDefinition);
}

function freezeModelToolInputContract(
  inputContract: ModelToolInputContract
): ModelToolInputContract {
  return Object.freeze({
    type: inputContract.type,
    fields: Object.freeze(
      inputContract.fields.map((field) =>
        Object.freeze({
          name: field.name,
          description: field.description,
          required: field.required,
          ...(field.valueType === undefined ? {} : { valueType: field.valueType }),
          ...(field.allowedValues === undefined
            ? {}
            : { allowedValues: Object.freeze([...field.allowedValues]) })
        } satisfies ModelToolInputField)
      )
    ),
    additionalFields: inputContract.additionalFields
  } satisfies ModelToolInputContract);
}

function rejectModelToolInput(details: string): ModelToolInputValidationResult {
  return Object.freeze({
    status: 'rejected',
    details
  } satisfies ModelToolInputValidationResult);
}

function modelToolInputValueMatchesType(
  value: unknown,
  valueType: ModelToolInputFieldValueType
): boolean {
  if (valueType === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }

  if (valueType === 'array') {
    return Array.isArray(value);
  }

  if (valueType === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  return typeof value === valueType;
}

function modelToolInputFieldTypeArticle(
  valueType: ModelToolInputFieldValueType
): 'a' | 'an' {
  return valueType === 'array' || valueType === 'object' ? 'an' : 'a';
}

function modelToolInputFieldTypeLabel(
  valueType: ModelToolInputFieldValueType
): string {
  return valueType === 'number' ? 'finite number' : valueType;
}

function validateModelToolInputJsonValues(options: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}): string | undefined {
  for (const [key, value] of Object.entries(options.input)) {
    const result = validateModelToolInputJsonValue({
      toolName: options.toolName,
      fieldPath: key,
      value
    });

    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

function validateModelToolInputJsonValue(options: {
  readonly toolName: string;
  readonly fieldPath: string;
  readonly value: unknown;
}): string | undefined {
  if (
    options.value === null ||
    typeof options.value === 'string' ||
    typeof options.value === 'boolean'
  ) {
    return undefined;
  }

  if (typeof options.value === 'number') {
    if (Number.isFinite(options.value)) {
      return undefined;
    }

    return `${options.toolName} input field "${options.fieldPath}" must be finite JSON.`;
  }

  if (Array.isArray(options.value)) {
    for (const [index, item] of options.value.entries()) {
      const result = validateModelToolInputJsonValue({
        toolName: options.toolName,
        fieldPath: `${options.fieldPath}[${String(index)}]`,
        value: item
      });

      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  if (isJsonRecord(options.value)) {
    for (const [key, item] of Object.entries(options.value)) {
      const result = validateModelToolInputJsonValue({
        toolName: options.toolName,
        fieldPath: `${options.fieldPath}.${key}`,
        value: item
      });

      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  return `${options.toolName} input field "${options.fieldPath}" must be JSON serializable.`;
}

function freezeJsonRecord(
  record: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    snapshot[key] = freezeJsonValue(value);
  }

  return Object.freeze(snapshot);
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue));
  }

  if (isJsonRecord(value)) {
    return freezeJsonRecord(value);
  }

  return value;
}

function isJsonRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
