import {
  isModelToolJsonSchemaTypeArray,
  type ModelToolDefinition,
  type ModelToolJsonSchema,
  type ModelToolJsonSchemaType,
} from '../api/model-tools.ts';
import type {
  RoleModelChatCompletionTool,
  RoleModelProviderToolNameMapping,
} from '../api/chat-wire.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';

export function modelToolDefinitionToChatTool(
  definition: ModelToolDefinition,
  options: {readonly strict?: boolean} = {},
): RoleModelChatCompletionTool {
  const strict =
    options.strict === true &&
    jsonSchemaSupportsStrictTools(definition.inputContract);

  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters: definition.inputContract,
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

// An unrecognized keyword costs the strict flag, never the request.
const strictEligibleKeywords = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
]);

function jsonSchemaSupportsStrictTools(schema: ModelToolJsonSchema): boolean {
  // A boolean subschema is legal JSON Schema and opaque to this walk.
  if (!isJsonRecord(schema)) {
    return false;
  }

  if (
    !Object.keys(schema).every(keyword => strictEligibleKeywords.has(keyword))
  ) {
    return false;
  }

  const schemaTypes = modelToolJsonSchemaTypes(schema.type);

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

function modelToolJsonSchemaTypes(
  type: ModelToolJsonSchema['type'],
): readonly ModelToolJsonSchemaType[] {
  if (type === undefined) {
    return Object.freeze([]);
  }

  return isModelToolJsonSchemaTypeArray(type) ? type : Object.freeze([type]);
}
