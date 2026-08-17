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
import type {RoleModelToolObservationResult} from '../api/contracts.ts';
import {visibleReplyModelToolName} from '../api/model-tools.ts';
import type {RuntimePluginJsonValue} from '../../plugins/api/index.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';

/** The tool-result message content every round shows the model, live or replayed. */
export function createNativeToolResultMessageContent(call: {
  readonly pluginId: string;
  readonly toolName: string;
  readonly result: RoleModelToolObservationResult;
}): Readonly<Record<string, RuntimePluginJsonValue>> {
  if (call.result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      pluginId: call.pluginId,
      toolName: call.toolName,
      output: call.result.output,
    });
  }

  return Object.freeze({
    status: 'rejected',
    pluginId: call.pluginId,
    toolName: call.toolName,
    reason: call.result.reason,
    message: call.result.message,
  });
}

export function createNativeVisibleReplyToolResultContent(): Readonly<
  Record<string, RuntimePluginJsonValue>
> {
  return Object.freeze({
    status: 'accepted',
    toolName: visibleReplyModelToolName,
    output: Object.freeze({
      kind: 'visible_reply_delivered',
    }),
  });
}

export function createNativeMissingToolResultContent(
  toolName: string,
): Readonly<Record<string, RuntimePluginJsonValue>> {
  return Object.freeze({
    status: 'rejected',
    toolName,
    reason: 'tool_result_missing',
    message: `No routed plugin result was available for native tool call "${toolName}".`,
  });
}

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
