import type {RoleModelPluginToolDefinition} from '../../role-model/index.ts';
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
    options.plugins.flatMap(plugin => {
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
    }),
  );
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

/** A tool the host can route this turn; one that asks first needs someone to ask. */
export function discoverableCurrentTurnPluginTools(options: {
  readonly plugin: RuntimePlugin;
  readonly access: RuntimePluginAccessSnapshot;
  readonly confirmationAvailable: boolean;
}): readonly RuntimePluginProvidedTool[] {
  return Object.freeze(
    routableModelFacingPluginTools(options).filter(
      tool => !tool.requiresConfirmation || options.confirmationAvailable,
    ),
  );
}
