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

export type IsHostOwnedFirstPartyModelToolsPlugin = (
  plugin: RuntimePlugin,
) => boolean;

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
        isModelFacingRuntimePluginTool({
          manifest: options.plugin.manifest,
          tool,
        }),
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
  readonly isHostOwnedFirstPartyModelToolsPlugin?: IsHostOwnedFirstPartyModelToolsPlugin;
}): readonly RuntimePluginProvidedTool[] {
  return Object.freeze(
    options.plugin.providedTools.filter(
      tool =>
        pluginCanWriteModelInput(options.access) &&
        (!tool.requiresConfirmation || options.confirmationAvailable) &&
        isDiscoverableCurrentTurnTool({
          plugin: options.plugin,
          tool,
          ...(options.isHostOwnedFirstPartyModelToolsPlugin === undefined
            ? {}
            : {
                isHostOwnedFirstPartyModelToolsPlugin:
                  options.isHostOwnedFirstPartyModelToolsPlugin,
              }),
        }),
    ),
  );
}

/**
 * Whether the model may be shown this tool on this turn.
 *
 * A plugin tool needs a handler to run; a first-party built-in is owned
 * by the host and has none. The two cases cannot overlap, because
 * `isModelFacingRuntimePluginTool` excludes built-in names and
 * `isFirstPartyBuiltInModelTool` requires one.
 */
function isDiscoverableCurrentTurnTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
  readonly isHostOwnedFirstPartyModelToolsPlugin?: IsHostOwnedFirstPartyModelToolsPlugin;
}): boolean {
  if (
    isModelFacingRuntimePluginTool({
      manifest: options.plugin.manifest,
      tool: options.tool,
    })
  ) {
    return options.plugin.lifecycleHooks.handleToolCall !== undefined;
  }

  return isFirstPartyBuiltInModelTool({
    ...options,
    isHostOwnedFirstPartyModelToolsPlugin:
      options.isHostOwnedFirstPartyModelToolsPlugin ??
      isFirstPartyModelToolsPlugin,
  });
}

export function isFirstPartyBuiltInModelTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
  readonly isHostOwnedFirstPartyModelToolsPlugin?: IsHostOwnedFirstPartyModelToolsPlugin;
}): boolean {
  return (
    options.isHostOwnedFirstPartyModelToolsPlugin?.(options.plugin) === true &&
    options.tool.validationOwner === 'built_in_model_tools' &&
    isBuiltInModelToolName(options.tool.name) &&
    !toolRequiresConfirmation(options.tool)
  );
}

function toolRequiresConfirmation(tool: RuntimePluginProvidedTool): boolean {
  return tool.requiresConfirmation;
}
