import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';
import {
  visibleReplyTextDescription,
  visibleReplyToolDescription,
} from '../prompt/prompt-text.ts';

export const visibleReplyModelToolName = 'visible_reply';

export type VisibleReplyModelToolName = typeof visibleReplyModelToolName;
export type BuiltInModelToolName = VisibleReplyModelToolName;

export type ModelToolJsonSchemaType =
  'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** The index signature admits all of JSON Schema; Ajv judges validity. */
export type ModelToolJsonSchema = {
  readonly [keyword: string]: unknown;
  readonly type?: ModelToolJsonSchemaType | readonly ModelToolJsonSchemaType[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, ModelToolJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | ModelToolJsonSchema;
  readonly items?: ModelToolJsonSchema;
};

export type ModelToolInputContract = ModelToolJsonSchema & {
  readonly type: 'object';
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
    description: visibleReplyToolDescription,
    inputContract: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: visibleReplyTextDescription,
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

// A keyword-by-keyword copy would drop keywords it does not know. The cast
// states that the snapshot is a faithful JSON projection of a checked value.
function freezeModelToolInputContract(
  inputContract: ModelToolInputContract,
): ModelToolInputContract {
  return createJsonBoundaryObjectSnapshot(inputContract, {
    field: 'Model tool inputContract',
  }) as ModelToolInputContract;
}

export function isModelToolJsonSchemaTypeArray(
  value: NonNullable<ModelToolJsonSchema['type']>,
): value is readonly ModelToolJsonSchemaType[] {
  return Array.isArray(value);
}
