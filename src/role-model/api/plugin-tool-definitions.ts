import {
  createRuntimePluginProvidedTool,
  firstPartyModelToolsPluginId,
  type RuntimePluginProvidedTool,
} from '../../plugins/api/index.ts';
import {
  builtInModelToolDefinitionsForUserTurn,
  isBuiltInModelToolName,
} from './model-tools.ts';
import {requiredRoleModelIdentifier} from './tool-names.ts';

import type {
  RoleModelPluginToolDefinition,
  RoleModelToolDefinition,
} from './contracts.ts';
import {freezeModelToolDefinition} from './model-tools.ts';
import type {RoleModelAllowedToolName} from './tool-names.ts';

export function createDefaultRoleModelPluginToolDefinitions(): readonly RoleModelPluginToolDefinition[] {
  // Derived from the built-in tool definitions directly; the first-party
  // model-tools package derives its provided tools from the same source,
  // so both sides stay in lockstep without importing an implementation.
  return Object.freeze(
    builtInModelToolDefinitionsForUserTurn().map(definition =>
      Object.freeze({
        pluginId: firstPartyModelToolsPluginId,
        name: definition.name,
        description: definition.description,
        requiredForUserTurn: definition.requiredForUserTurn,
        callLimit: definition.callLimit,
        inputContract: definition.inputContract,
        validationOwner: 'built_in_model_tools',
        annotations: {readOnlyHint: true},
        concurrency: 'shared',
        requiresConfirmation: false,
        sourceReferencesRequired: false,
      } satisfies RoleModelPluginToolDefinition),
    ),
  );
}

export function createRoleModelPluginToolDefinitions(
  definitions: readonly RoleModelPluginToolDefinition[],
): readonly RoleModelPluginToolDefinition[] {
  const frozenDefinitions: RoleModelPluginToolDefinition[] = [];
  const seenNames = new Set<string>();

  for (const definition of definitions) {
    const pluginId = requiredRoleModelIdentifier(
      definition.pluginId,
      'pluginId',
    );
    const providedTool = createRuntimePluginProvidedTool(definition);

    if (seenNames.has(providedTool.name)) {
      throw new TypeError(
        `Plugin tool "${providedTool.name}" is declared more than once.`,
      );
    }

    assertRoleModelPluginToolPolicy(pluginId, providedTool);

    seenNames.add(providedTool.name);
    frozenDefinitions.push(
      Object.freeze({
        pluginId,
        ...providedTool,
      } satisfies RoleModelPluginToolDefinition),
    );
  }

  return Object.freeze(frozenDefinitions);
}

function assertRoleModelPluginToolPolicy(
  pluginId: string,
  providedTool: RuntimePluginProvidedTool,
): void {
  if (isBuiltInModelToolName(providedTool.name)) {
    assertBuiltInRoleModelToolPolicy(pluginId, providedTool);
    return;
  }

  assertHostRoleModelToolPolicy(providedTool);
}

function assertBuiltInRoleModelToolPolicy(
  pluginId: string,
  providedTool: RuntimePluginProvidedTool,
): void {
  if (
    pluginId !== firstPartyModelToolsPluginId ||
    providedTool.validationOwner !== 'built_in_model_tools' ||
    providedTool.requiresConfirmation ||
    providedTool.callLimit?.scope !== 'model_response' ||
    providedTool.callLimit.maxCalls !== 1
  ) {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" must be provided by ${firstPartyModelToolsPluginId}.`,
    );
  }
}

function assertHostRoleModelToolPolicy(
  providedTool: RuntimePluginProvidedTool,
): void {
  if (providedTool.validationOwner !== 'plugin_host') {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" must be validated by plugin_host.`,
    );
  }

  if (
    providedTool.callLimit !== undefined &&
    providedTool.callLimit.scope !== 'user_turn'
  ) {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" may only declare a user_turn call limit.`,
    );
  }

  // A tool that declares requiresConfirmation is model-facing and
  // prompts the user before it runs; the runtime no longer refuses to
  // expose it. What a plugin may do is decided when the user enables it,
  // as with a local MCP server they chose to run.
}

export function modelToolDefinitionsForPluginToolDefinitions(
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
): readonly RoleModelToolDefinition[] {
  return Object.freeze(
    pluginToolDefinitions.map(definition =>
      freezeModelToolDefinition(definition),
    ),
  );
}

export function defaultAllowedToolsForPluginDefinitions(
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[],
): readonly RoleModelAllowedToolName[] {
  return Object.freeze(
    pluginToolDefinitions.map(definition => definition.name),
  );
}

export function toolDefinitionsForAllowedTools(options: {
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly toolDefinitions: readonly RoleModelToolDefinition[];
}): readonly RoleModelToolDefinition[] {
  return Object.freeze(
    options.toolDefinitions
      .filter(definition => options.allowedTools.includes(definition.name))
      .map(freezeModelToolDefinition),
  );
}
