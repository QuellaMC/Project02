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

export type ModelToolInputField = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly allowedValues?: readonly string[];
};

export type ModelToolInputContract = {
  readonly type: 'object';
  readonly fields: readonly ModelToolInputField[];
  readonly additionalFields: boolean;
};

export type BuiltInModelToolDefinition = {
  readonly name: BuiltInModelToolName;
  readonly description: string;
  readonly requiredForUserTurn: boolean;
  readonly maxCallsPerUserTurn: 1;
  readonly inputContract: ModelToolInputContract;
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
  calls: readonly BuiltInModelToolCall[]
): VisibleReplyModelToolCall | undefined {
  return calls.find((call) => call.name === visibleReplyModelToolName);
}

export function findCharacterStatePatchModelToolCall(
  calls: readonly BuiltInModelToolCall[]
): CharacterStatePatchModelToolCall | undefined {
  return calls.find((call) => call.name === characterStatePatchModelToolName);
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
    inputContract: Object.freeze({
      type: options.inputContract.type,
      fields: Object.freeze(
        options.inputContract.fields.map((field) =>
          Object.freeze({
            name: field.name,
            description: field.description,
            required: field.required,
            ...(field.allowedValues === undefined
              ? {}
              : { allowedValues: Object.freeze([...field.allowedValues]) })
          } satisfies ModelToolInputField)
        )
      ),
      additionalFields: options.inputContract.additionalFields
    } satisfies ModelToolInputContract)
  } satisfies BuiltInModelToolDefinition);
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
