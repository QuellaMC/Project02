/**
 * Tool wire conversion for the role-model prompt: turns runtime model
 * tool definitions into provider chat-completion tools (including the
 * ModelTool -> provider JSON-schema conversion and the strict-mode
 * check) and maps runtime tool names to provider-safe names and back.
 */
import {
  freezeModelToolJsonSchemaType,
  isModelToolJsonSchemaTypeArray,
  type ModelToolDefinition,
  type ModelToolInputContract,
  type ModelToolInputField,
  type ModelToolInputFieldValueType,
  type ModelToolJsonSchema,
  type ModelToolJsonSchemaType,
  type ModelToolObjectJsonSchema,
} from '../api/model-tools.ts';
import type {
  RoleModelChatCompletionTool,
  RoleModelJsonSchema,
  RoleModelObjectJsonSchema,
  RoleModelProviderToolNameMapping,
} from '../api/chat-wire.ts';

export function modelToolDefinitionToChatTool(
  definition: ModelToolDefinition,
  options: {readonly strict?: boolean} = {},
): RoleModelChatCompletionTool {
  const parameters = modelToolInputContractToJsonSchema(
    definition.inputContract,
  );
  const strict =
    options.strict === true && jsonSchemaSupportsStrictTools(parameters);

  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters,
      ...(strict ? {strict: true} : {}),
    }),
  } satisfies RoleModelChatCompletionTool);
}

export function createRoleModelProviderToolNameMappings(
  runtimeNames: readonly string[],
): readonly RoleModelProviderToolNameMapping[] {
  const usedProviderNames = new Set<string>();
  const mappings: RoleModelProviderToolNameMapping[] = [];

  for (const runtimeName of runtimeNames) {
    const baseProviderName = roleModelProviderSafeToolName(runtimeName);
    let providerName = baseProviderName;
    let suffix = 1;

    while (usedProviderNames.has(providerName)) {
      suffix += 1;
      providerName = `${baseProviderName}_${String(suffix)}`;
    }

    usedProviderNames.add(providerName);
    mappings.push(
      Object.freeze({
        runtimeName,
        providerName,
      } satisfies RoleModelProviderToolNameMapping),
    );
  }

  return Object.freeze(mappings);
}

export function providerToolNameForRuntimeToolName(
  runtimeName: string,
  mappings: readonly RoleModelProviderToolNameMapping[],
): string {
  return (
    mappings.find(mapping => mapping.runtimeName === runtimeName)
      ?.providerName ?? roleModelProviderSafeToolName(runtimeName)
  );
}

export function runtimeToolNameForProviderToolName(
  providerName: string,
  mappings: readonly RoleModelProviderToolNameMapping[],
): string {
  return (
    mappings.find(mapping => mapping.providerName === providerName)
      ?.runtimeName ?? providerName
  );
}

function roleModelProviderSafeToolName(runtimeName: string): string {
  const safeName = runtimeName.replaceAll(/[^A-Za-z0-9_-]/gu, '_');

  if (/^[A-Za-z]/u.test(safeName)) {
    return safeName;
  }

  return `tool_${safeName}`;
}

function modelToolInputContractToJsonSchema(
  contract: ModelToolInputContract,
): RoleModelObjectJsonSchema {
  if (contract.jsonSchema !== undefined) {
    return modelToolObjectJsonSchemaToRoleModelSchema(contract.jsonSchema);
  }

  const properties: Record<string, RoleModelJsonSchema> = {};
  const required: string[] = [];

  for (const field of contract.fields) {
    properties[field.name] = modelToolInputFieldToJsonSchema(field);

    if (field.required) {
      required.push(field.name);
    }
  }

  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    additionalProperties: contract.additionalFields,
  } satisfies RoleModelObjectJsonSchema);
}

function modelToolObjectJsonSchemaToRoleModelSchema(
  schema: ModelToolObjectJsonSchema,
): RoleModelObjectJsonSchema {
  const converted = modelToolJsonSchemaToRoleModelSchema(schema);

  return Object.freeze({
    type: 'object',
    properties: Object.freeze(converted.properties ?? {}),
    required: Object.freeze(converted.required ?? []),
    additionalProperties: converted.additionalProperties ?? false,
  } satisfies RoleModelObjectJsonSchema);
}

function modelToolJsonSchemaToRoleModelSchema(
  schema: ModelToolJsonSchema,
): RoleModelJsonSchema {
  const schemaType = freezeRoleModelJsonSchemaType(schema.type);

  return Object.freeze({
    ...(schemaType === undefined ? {} : {type: schemaType}),
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
                modelToolJsonSchemaToRoleModelSchema(value),
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
      : {items: modelToolJsonSchemaToRoleModelSchema(schema.items)}),
  } satisfies RoleModelJsonSchema);
}

function freezeRoleModelJsonSchemaType(
  type: ModelToolJsonSchema['type'],
): ModelToolJsonSchema['type'] {
  return type === undefined ? undefined : freezeModelToolJsonSchemaType(type);
}

function modelToolInputFieldToJsonSchema(
  field: ModelToolInputField,
): RoleModelJsonSchema {
  return Object.freeze({
    ...(field.valueType === undefined && field.allowedValues === undefined
      ? {}
      : {type: modelToolInputFieldJsonSchemaType(field)}),
    description: field.description,
    ...(field.allowedValues === undefined
      ? {}
      : {enum: Object.freeze([...field.allowedValues])}),
  } satisfies RoleModelJsonSchema);
}

function modelToolInputFieldJsonSchemaType(
  field: ModelToolInputField,
): NonNullable<RoleModelJsonSchema['type']> {
  if (field.allowedValues !== undefined) {
    return 'string';
  }

  return modelToolValueTypeToJsonSchemaType(field.valueType);
}

function modelToolValueTypeToJsonSchemaType(
  valueType: ModelToolInputFieldValueType | undefined,
): NonNullable<RoleModelJsonSchema['type']> {
  if (valueType === undefined) {
    return 'string';
  }

  return valueType;
}

function jsonSchemaSupportsStrictTools(schema: RoleModelJsonSchema): boolean {
  const schemaTypes = roleModelJsonSchemaTypes(schema.type);

  if (schemaTypes.includes('object')) {
    if (schema.additionalProperties !== false) {
      return false;
    }

    if (
      !Object.values(schema.properties ?? {}).every(
        jsonSchemaSupportsStrictTools,
      )
    ) {
      return false;
    }
  }

  if (
    schemaTypes.includes('array') &&
    schema.items !== undefined &&
    !jsonSchemaSupportsStrictTools(schema.items)
  ) {
    return false;
  }

  return true;
}

function roleModelJsonSchemaTypes(
  type: RoleModelJsonSchema['type'],
): readonly ModelToolJsonSchemaType[] {
  if (type === undefined) {
    return Object.freeze([]);
  }

  return isModelToolJsonSchemaTypeArray(type) ? type : Object.freeze([type]);
}
