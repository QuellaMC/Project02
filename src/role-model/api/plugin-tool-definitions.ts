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
  // Same source as the first-party model-tools package, so both stay in lockstep.
  return Object.freeze(
    builtInModelToolDefinitionsForUserTurn().map(definition =>
      Object.freeze({
        pluginId: firstPartyModelToolsPluginId,
        name: definition.name,
        description: definition.description,
        inputContract: definition.inputContract,
        validationOwner: 'built_in_model_tools',
        annotations: {readOnlyHint: true},
        concurrency: 'shared',
        requiresConfirmation: false,
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
    providedTool.requiresConfirmation
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

  // requiresConfirmation is allowed: the tool prompts the user before it runs.
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
