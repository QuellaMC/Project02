/**
 * Tool wire for the role-model prompt: turns runtime model tool
 * definitions into provider chat-completion tools (the contract renders
 * as-is; strict mode is a per-tool eligibility check) and maps runtime
 * tool names to provider-safe names and back.
 */
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
      // The contract is already a frozen JSON value; rendering it is
      // showing it, not translating it.
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

// The keyword shapes this eligibility rule can vouch for. A contract may
// use anything Ajv compiles; strict mode is only ever claimed for
// schemas made of these, because a keyword the rule cannot see through —
// a combinator hiding an open object, a constraint the provider's strict
// grammar refuses — must cost the strict flag, never the request.
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
  // A JSON manifest may carry a boolean subschema, which is legal JSON
  // Schema the walk cannot see through — same rule as any other opaque
  // shape: it costs the strict flag.
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
