import {isBuiltInModelToolName} from '../../role-model/index.ts';
import type {RoleModelPluginToolDefinition} from '../../role-model/index.ts';
import {isFirstPartyModelToolsPlugin} from '../builtin/model-tools/index.ts';
import {isModelFacingRuntimePluginTool} from '../api/tool-classification.ts';
import {
  runtimePluginAccessForPlugin,
  runtimePluginGrantsAccess,
  type RuntimePluginAccessMapByPluginId,
} from './access-control.ts';
import type {RuntimePlugin, RuntimePluginProvidedTool} from '../api/types.ts';
import type {RuntimePluginAccessSnapshot} from '../api/contract.ts';

export function pluginToolDefinitionsForEnabledPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly confirmationAvailable: boolean;
}): readonly RoleModelPluginToolDefinition[] {
  return Object.freeze(
    options.plugins
      .flatMap(plugin => {
        const access = runtimePluginAccessForPlugin({
          plugin,
          accessByPluginId: options.accessByPluginId,
        });

        return discoverableCurrentTurnPluginTools({
          plugin,
          access,
          confirmationAvailable: options.confirmationAvailable,
        }).map(tool =>
          Object.freeze({
            pluginId: plugin.manifest.id,
            ...tool,
          } satisfies RoleModelPluginToolDefinition),
        );
      })
      .sort(modelToolDefinitionOrder),
  );
}

function modelToolDefinitionOrder(
  left: RoleModelPluginToolDefinition,
  right: RoleModelPluginToolDefinition,
): number {
  const leftBuiltIn = isBuiltInModelToolName(left.name);
  const rightBuiltIn = isBuiltInModelToolName(right.name);

  if (leftBuiltIn === rightBuiltIn) {
    return 0;
  }

  return leftBuiltIn ? -1 : 1;
}

export function routableModelFacingPluginTools(options: {
  readonly plugin: RuntimePlugin;
  readonly access: RuntimePluginAccessSnapshot;
}): readonly RuntimePluginProvidedTool[] {
  if (options.plugin.lifecycleHooks.handleToolCall === undefined) {
    return [];
  }

  return Object.freeze(
    options.plugin.providedTools.filter(
      tool =>
        pluginCanWriteModelInput(options.access) &&
        isModelFacingRuntimePluginTool(tool),
    ),
  );
}

export function pluginCanWriteModelInput(
  access: RuntimePluginAccessSnapshot,
): boolean {
  return runtimePluginGrantsAccess({
    access,
    accessName: 'model_input',
    requiredAccess: 'write',
  });
}

export function discoverableCurrentTurnPluginTools(options: {
  readonly plugin: RuntimePlugin;
  readonly access: RuntimePluginAccessSnapshot;
  readonly confirmationAvailable: boolean;
}): readonly RuntimePluginProvidedTool[] {
  return Object.freeze(
    options.plugin.providedTools.filter(
      tool =>
        pluginCanWriteModelInput(options.access) &&
        (!tool.requiresConfirmation || options.confirmationAvailable) &&
        isDiscoverableCurrentTurnTool({plugin: options.plugin, tool}),
    ),
  );
}

/** A plugin tool needs a handler; a host-owned built-in has none. */
function isDiscoverableCurrentTurnTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  if (isModelFacingRuntimePluginTool(options.tool)) {
    return options.plugin.lifecycleHooks.handleToolCall !== undefined;
  }

  return isFirstPartyBuiltInModelTool(options);
}

export function isFirstPartyBuiltInModelTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    isFirstPartyModelToolsPlugin(options.plugin) &&
    options.tool.validationOwner === 'built_in_model_tools' &&
    isBuiltInModelToolName(options.tool.name) &&
    !toolRequiresConfirmation(options.tool)
  );
}

function toolRequiresConfirmation(tool: RuntimePluginProvidedTool): boolean {
  return tool.requiresConfirmation;
}
