import {
  createJsonBoundaryObjectSnapshot,
  redactJsonBoundaryText
} from '../shared/json-boundary.ts';

export const visibleReplyModelToolName = 'visible_reply';

export type VisibleReplyModelToolName = typeof visibleReplyModelToolName;
export type BuiltInModelToolName = VisibleReplyModelToolName;

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

export type ModelToolJsonSchemaType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export type ModelToolJsonSchema = {
  readonly type?: ModelToolJsonSchemaType | readonly ModelToolJsonSchemaType[];
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, ModelToolJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: ModelToolJsonSchema;
};

export type ModelToolObjectJsonSchema = ModelToolJsonSchema & {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ModelToolJsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
};

export type ModelToolInputContract = {
  readonly type: 'object';
  readonly fields: readonly ModelToolInputField[];
  readonly additionalFields: boolean;
  readonly jsonSchema?: ModelToolObjectJsonSchema;
};

export const modelToolCallLimitScopes = Object.freeze([
  'model_response',
  'user_turn'
] as const);

export type ModelToolCallLimitScope =
  (typeof modelToolCallLimitScopes)[number];

export type ModelToolCallLimit = {
  readonly scope: ModelToolCallLimitScope;
  readonly maxCalls: number;
};

export type ModelToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly requiredForUserTurn: boolean;
  readonly callLimit: ModelToolCallLimit;
  readonly inputContract: ModelToolInputContract;
};

export type BuiltInModelToolDefinition = ModelToolDefinition & {
  readonly name: BuiltInModelToolName;
  readonly callLimit: {
    readonly scope: 'model_response';
    readonly maxCalls: 1;
  };
};

export type VisibleReplyToolInput = {
  readonly text: string;
};

export type VisibleReplyModelToolCall = {
  readonly name: VisibleReplyModelToolName;
  readonly input: VisibleReplyToolInput;
};

export type PluginModelToolCall = {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};

export type BuiltInModelToolCall = VisibleReplyModelToolCall;

export type ModelToolCall = BuiltInModelToolCall | PluginModelToolCall;

export const userTurnBuiltInModelToolNames = Object.freeze([
  visibleReplyModelToolName
] satisfies readonly BuiltInModelToolName[]);

export const requiredUserTurnBuiltInModelToolNames = Object.freeze([
] satisfies readonly BuiltInModelToolName[]);

export const builtInModelToolDefinitions = Object.freeze([
  createBuiltInModelToolDefinition({
    name: visibleReplyModelToolName,
    description: 'Send one user-visible reply message from you.',
    requiredForUserTurn: false,
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'text',
          description: 'The reply text to show to the user.',
          required: true,
          valueType: 'string'
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
  return value === visibleReplyModelToolName;
}

export function createVisibleReplyModelToolCall(
  text: string
): VisibleReplyModelToolCall {
  return Object.freeze({
    name: visibleReplyModelToolName,
    input: Object.freeze({
      text: redactJsonBoundaryText(text)
    } satisfies VisibleReplyToolInput)
  } satisfies VisibleReplyModelToolCall);
}

export function freezeBuiltInModelToolCall(
  call: BuiltInModelToolCall
): BuiltInModelToolCall {
  return createVisibleReplyModelToolCall(call.input.text);
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

export function freezeModelToolDefinition(
  definition: ModelToolDefinition
): ModelToolDefinition {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    requiredForUserTurn: definition.requiredForUserTurn,
    callLimit: freezeModelToolCallLimit(definition.callLimit),
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

  return Object.freeze({
    name: call.name,
    input: createJsonBoundaryObjectSnapshot(call.input, {
      field: `Model tool "${call.name}" input`,
      redact: true
    })
  } satisfies PluginModelToolCall);
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
  if (options.inputContract.jsonSchema !== undefined) {
    const schemaValidation = validateModelToolInputAgainstJsonSchema({
      toolName: options.toolName,
      value: options.input,
      schema: options.inputContract.jsonSchema,
      fieldPath: ''
    });

    if (schemaValidation !== undefined) {
      return rejectModelToolInput(schemaValidation);
    }

    return Object.freeze({
      status: 'accepted',
      input: freezeJsonRecord(options.input)
    } satisfies ModelToolInputValidationResult);
  }

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
    callLimit: Object.freeze({
      scope: 'model_response',
      maxCalls: 1
    }),
    inputContract: freezeModelToolInputContract(options.inputContract)
  } satisfies BuiltInModelToolDefinition);
}

function freezeModelToolCallLimit(
  callLimit: ModelToolCallLimit
): ModelToolCallLimit {
  return Object.freeze({
    scope: callLimit.scope,
    maxCalls: callLimit.maxCalls
  });
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
    additionalFields: inputContract.additionalFields,
    ...(inputContract.jsonSchema === undefined
      ? {}
      : { jsonSchema: freezeModelToolObjectJsonSchema(inputContract.jsonSchema) })
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

function validateModelToolInputAgainstJsonSchema(options: {
  readonly toolName: string;
  readonly value: unknown;
  readonly schema: ModelToolJsonSchema;
  readonly fieldPath: string;
}): string | undefined {
  const typeError = validateJsonSchemaType({
    toolName: options.toolName,
    value: options.value,
    schema: options.schema,
    fieldPath: options.fieldPath
  });

  if (typeError !== undefined) {
    return typeError;
  }

  if (
    options.schema.enum !== undefined &&
    (typeof options.value !== 'string' ||
      !options.schema.enum.includes(options.value))
  ) {
    return `${options.toolName} input field "${displayFieldPath(options.fieldPath)}" must be one of: ${options.schema.enum.join(', ')}.`;
  }

  if (Array.isArray(options.value)) {
    if (options.schema.items === undefined) {
      return validateModelToolInputJsonValue({
        toolName: options.toolName,
        fieldPath: displayFieldPath(options.fieldPath),
        value: options.value
      });
    }

    for (const [index, item] of options.value.entries()) {
      const itemError = validateModelToolInputAgainstJsonSchema({
        toolName: options.toolName,
        value: item,
        schema: options.schema.items,
        fieldPath: `${options.fieldPath}[${String(index)}]`
      });

      if (itemError !== undefined) {
        return itemError;
      }
    }

    return undefined;
  }

  if (isJsonRecord(options.value)) {
    const properties = options.schema.properties ?? {};
    const required = options.schema.required ?? [];

    for (const field of required) {
      if (options.value[field] === undefined) {
        return `${options.toolName} input missing required field "${displayFieldPath(
          appendFieldPath(options.fieldPath, field)
        )}".`;
      }
    }

    if (options.schema.additionalProperties === false) {
      const unsupportedKeys = Object.keys(options.value).filter(
        (key) => properties[key] === undefined
      );

      if (unsupportedKeys.length > 0) {
        return `${options.toolName} input includes unsupported fields: ${unsupportedKeys
          .map((key) => displayFieldPath(appendFieldPath(options.fieldPath, key)))
          .join(', ')}.`;
      }
    }

    for (const [field, schema] of Object.entries(properties)) {
      const childValue = options.value[field];

      if (childValue === undefined) {
        continue;
      }

      const childError = validateModelToolInputAgainstJsonSchema({
        toolName: options.toolName,
        value: childValue,
        schema,
        fieldPath: appendFieldPath(options.fieldPath, field)
      });

      if (childError !== undefined) {
        return childError;
      }
    }
  }

  return validateModelToolInputJsonValue({
    toolName: options.toolName,
    fieldPath: displayFieldPath(options.fieldPath),
    value: options.value
  });
}

function validateJsonSchemaType(options: {
  readonly toolName: string;
  readonly value: unknown;
  readonly schema: ModelToolJsonSchema;
  readonly fieldPath: string;
}): string | undefined {
  const schemaType = options.schema.type;

  if (schemaType === undefined) {
    return undefined;
  }

  const types = modelToolJsonSchemaTypes(schemaType);

  if (types.some((type) => jsonValueMatchesSchemaType(options.value, type))) {
    return undefined;
  }

  return `${options.toolName} input field "${displayFieldPath(
    options.fieldPath
  )}" must be ${types.join(' or ')}.`;
}

function jsonValueMatchesSchemaType(
  value: unknown,
  type: ModelToolJsonSchemaType
): boolean {
  if (type === 'array') {
    return Array.isArray(value);
  }

  if (type === 'object') {
    return isJsonRecord(value);
  }

  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }

  if (type === 'null') {
    return value === null;
  }

  return typeof value === type;
}

function modelToolJsonSchemaTypes(
  type: NonNullable<ModelToolJsonSchema['type']>
): readonly ModelToolJsonSchemaType[] {
  return isModelToolJsonSchemaTypeArray(type)
    ? Object.freeze([...type])
    : Object.freeze([type]);
}

function isModelToolJsonSchemaTypeArray(
  value: NonNullable<ModelToolJsonSchema['type']>
): value is readonly ModelToolJsonSchemaType[] {
  return Array.isArray(value);
}

function appendFieldPath(path: string, field: string): string {
  return path.length === 0 ? field : `${path}.${field}`;
}

function displayFieldPath(path: string): string {
  return path.length === 0 ? '$' : path;
}

function freezeModelToolObjectJsonSchema(
  schema: ModelToolObjectJsonSchema
): ModelToolObjectJsonSchema {
  return freezeModelToolJsonSchema(schema) as ModelToolObjectJsonSchema;
}

function freezeModelToolJsonSchema(
  schema: ModelToolJsonSchema
): ModelToolJsonSchema {
  return Object.freeze({
    ...(schema.type === undefined
      ? {}
      : {
          type: freezeModelToolJsonSchemaType(schema.type)
        }),
    ...(schema.description === undefined
      ? {}
      : { description: schema.description }),
    ...(schema.enum === undefined
      ? {}
      : { enum: Object.freeze([...schema.enum]) }),
    ...(schema.properties === undefined
      ? {}
      : {
          properties: Object.freeze(
            Object.fromEntries(
              Object.entries(schema.properties).map(([key, value]) => [
                key,
                freezeModelToolJsonSchema(value)
              ])
            )
          )
        }),
    ...(schema.required === undefined
      ? {}
      : { required: Object.freeze([...schema.required]) }),
    ...(schema.additionalProperties === undefined
      ? {}
      : { additionalProperties: schema.additionalProperties }),
    ...(schema.items === undefined
      ? {}
      : { items: freezeModelToolJsonSchema(schema.items) })
  } satisfies ModelToolJsonSchema);
}

function freezeModelToolJsonSchemaType(
  type: NonNullable<ModelToolJsonSchema['type']>
): NonNullable<ModelToolJsonSchema['type']> {
  return isModelToolJsonSchemaTypeArray(type) ? Object.freeze([...type]) : type;
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
