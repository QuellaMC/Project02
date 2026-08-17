import {
  createRuntimePluginProvidedTool,
  type RuntimePluginProvidedTool,
} from '../../plugins/api/index.ts';
import {isBuiltInModelToolName} from './model-tools.ts';
import {requiredRoleModelIdentifier} from './tool-names.ts';

import type {RoleModelPluginToolDefinition} from './contracts.ts';

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

    assertRoleModelPluginToolPolicy(providedTool);

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
  providedTool: RuntimePluginProvidedTool,
): void {
  if (isBuiltInModelToolName(providedTool.name)) {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" is a built-in model tool and cannot be provided by a plugin.`,
    );
  }

  if (providedTool.validationOwner !== 'plugin_host') {
    throw new TypeError(
      `Plugin tool "${providedTool.name}" must be validated by plugin_host.`,
    );
  }

  // requiresConfirmation is allowed: the tool prompts the user before it runs.
}
