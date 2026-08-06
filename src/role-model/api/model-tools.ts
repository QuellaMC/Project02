import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';

export const visibleReplyModelToolName = 'visible_reply';

export type VisibleReplyModelToolName = typeof visibleReplyModelToolName;
export type BuiltInModelToolName = VisibleReplyModelToolName;

export const modelToolJsonSchemaTypeValues = Object.freeze([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
] as const);

export type ModelToolJsonSchemaType =
  (typeof modelToolJsonSchemaTypeValues)[number];

export function isModelToolJsonSchemaType(
  value: unknown,
): value is ModelToolJsonSchemaType {
  return (
    typeof value === 'string' &&
    modelToolJsonSchemaTypeValues.some(allowedValue => allowedValue === value)
  );
}

export type ModelToolJsonSchema = {
  readonly type?: ModelToolJsonSchemaType | readonly ModelToolJsonSchemaType[];
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, ModelToolJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: ModelToolJsonSchema;
};

/**
 * A tool's input shape, and the only way to declare one. It is JSON
 * Schema because that is what providers consume and what a plugin author
 * already knows how to write — nesting included.
 */
export type ModelToolInputContract = ModelToolJsonSchema & {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ModelToolJsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
};

export type ModelToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputContract: ModelToolInputContract;
};

export type BuiltInModelToolDefinition = ModelToolDefinition & {
  readonly name: BuiltInModelToolName;
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
  visibleReplyModelToolName,
] satisfies readonly BuiltInModelToolName[]);

export const builtInModelToolDefinitions = Object.freeze([
  createBuiltInModelToolDefinition({
    name: visibleReplyModelToolName,
    description: 'Send a user-visible reply message from you.',
    inputContract: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The reply text to show to the user.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  }),
] satisfies readonly BuiltInModelToolDefinition[]);

export function builtInModelToolDefinitionsForUserTurn(): readonly BuiltInModelToolDefinition[] {
  return Object.freeze([...builtInModelToolDefinitions]);
}

export function isBuiltInModelToolName(
  value: unknown,
): value is BuiltInModelToolName {
  return value === visibleReplyModelToolName;
}

export function createVisibleReplyModelToolCall(
  text: string,
): VisibleReplyModelToolCall {
  return Object.freeze({
    name: visibleReplyModelToolName,
    input: Object.freeze({text} satisfies VisibleReplyToolInput),
  } satisfies VisibleReplyModelToolCall);
}

export function freezeBuiltInModelToolCall(
  call: BuiltInModelToolCall,
): BuiltInModelToolCall {
  return createVisibleReplyModelToolCall(call.input.text);
}

export function freezeModelToolDefinition(
  definition: ModelToolDefinition,
): ModelToolDefinition {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    inputContract: freezeModelToolInputContract(definition.inputContract),
  } satisfies ModelToolDefinition);
}

export function freezeModelToolCall(call: ModelToolCall): ModelToolCall {
  if (call.name === visibleReplyModelToolName) {
    const text = call.input['text'];

    return createVisibleReplyModelToolCall(
      typeof text === 'string' ? text : '',
    );
  }

  return Object.freeze({
    name: call.name,
    input: createJsonBoundaryObjectSnapshot(call.input, {
      field: `Model tool "${call.name}" input`,
      redact: true,
    }),
  } satisfies PluginModelToolCall);
}

export function freezeModelToolCalls(
  calls: readonly ModelToolCall[],
): readonly ModelToolCall[] {
  return Object.freeze(calls.map(freezeModelToolCall));
}

function createBuiltInModelToolDefinition(options: {
  readonly name: BuiltInModelToolName;
  readonly description: string;
  readonly inputContract: ModelToolInputContract;
}): BuiltInModelToolDefinition {
  return Object.freeze({
    name: options.name,
    description: options.description,
    inputContract: freezeModelToolInputContract(options.inputContract),
  } satisfies BuiltInModelToolDefinition);
}

function freezeModelToolInputContract(
  inputContract: ModelToolInputContract,
): ModelToolInputContract {
  const frozen = freezeModelToolJsonSchema(inputContract);

  return Object.freeze({
    ...frozen,
    type: 'object',
    properties: frozen.properties ?? Object.freeze({}),
    required: frozen.required ?? Object.freeze([]),
    additionalProperties: inputContract.additionalProperties,
  } satisfies ModelToolInputContract);
}

export function isModelToolJsonSchemaTypeArray(
  value: NonNullable<ModelToolJsonSchema['type']>,
): value is readonly ModelToolJsonSchemaType[] {
  return Array.isArray(value);
}

function freezeModelToolJsonSchema(
  schema: ModelToolJsonSchema,
): ModelToolJsonSchema {
  return Object.freeze({
    ...(schema.type === undefined
      ? {}
      : {
          type: freezeModelToolJsonSchemaType(schema.type),
        }),
    ...(schema.description === undefined
      ? {}
      : {description: schema.description}),
    ...(schema.enum === undefined
      ? {}
      : {enum: Object.freeze([...schema.enum])}),
    ...(schema.properties === undefined
      ? {}
      : {
          properties: Object.freeze(
            Object.fromEntries(
              Object.entries(schema.properties).map(([key, value]) => [
                key,
                freezeModelToolJsonSchema(value),
              ]),
            ),
          ),
        }),
    ...(schema.required === undefined
      ? {}
      : {required: Object.freeze([...schema.required])}),
    ...(schema.additionalProperties === undefined
      ? {}
      : {additionalProperties: schema.additionalProperties}),
    ...(schema.items === undefined
      ? {}
      : {items: freezeModelToolJsonSchema(schema.items)}),
  } satisfies ModelToolJsonSchema);
}

export function freezeModelToolJsonSchemaType(
  type: NonNullable<ModelToolJsonSchema['type']>,
): NonNullable<ModelToolJsonSchema['type']> {
  return isModelToolJsonSchemaTypeArray(type) ? Object.freeze([...type]) : type;
}
