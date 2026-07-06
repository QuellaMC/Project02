import { isBuiltInModelToolName } from '../role-model/model-tools.ts';
import type { RoleModelPluginToolDefinition } from '../role-model/contracts.ts';
import {
  runtimePluginAccessForPlugin,
  runtimePluginGrantsAccess,
  type RuntimePluginAccessMapByPluginId
} from './access-control.ts';
import type {
  RuntimePlugin,
  RuntimePluginManifest,
  RuntimePluginProvidedTool
} from './validation.ts';
import type {
  RuntimePluginAccessSnapshot,
  RuntimePluginSideEffectLevel
} from './contract.ts';

export type IsHostOwnedFirstPartyModelToolsPlugin = (
  plugin: RuntimePlugin
) => boolean;

export function pluginToolDefinitionsForEnabledPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
}): readonly RoleModelPluginToolDefinition[] {
  return Object.freeze(
    options.plugins.flatMap((plugin) => {
      const access = runtimePluginAccessForPlugin({
        plugin,
        accessByPluginId: options.accessByPluginId
      });

      return routableModelFacingPluginTools({ plugin, access }).map((tool) =>
        Object.freeze({
          pluginId: plugin.manifest.id,
          ...tool
        } satisfies RoleModelPluginToolDefinition)
      );
    })
  );
}

export function routableModelFacingPluginTools(options: {
  readonly plugin: RuntimePlugin;
  readonly access: RuntimePluginAccessSnapshot;
}): readonly RuntimePluginProvidedTool[] {
  if (options.plugin.lifecycleHooks.handleToolCall === undefined) {
    return [];
  }

  if (!pluginCanWriteModelInput(options.access)) {
    return [];
  }

  return Object.freeze(
    options.plugin.providedTools.filter((tool) =>
      isModelFacingPluginTool({
        plugin: options.plugin,
        tool
      })
    )
  );
}

export function pluginCanWriteModelInput(
  access: RuntimePluginAccessSnapshot
): boolean {
  return runtimePluginGrantsAccess({
    access,
    accessName: 'model_input',
    requiredAccess: 'write'
  });
}

export function discoverableCurrentTurnPluginTools(options: {
  readonly plugin: RuntimePlugin;
  readonly access: RuntimePluginAccessSnapshot;
  readonly isHostOwnedFirstPartyModelToolsPlugin?: IsHostOwnedFirstPartyModelToolsPlugin;
}): readonly RuntimePluginProvidedTool[] {
  if (!pluginCanWriteModelInput(options.access)) {
    return [];
  }

  return Object.freeze(
    options.plugin.providedTools.filter((tool) =>
      isDiscoverableCurrentTurnTool({
        plugin: options.plugin,
        tool,
        ...(options.isHostOwnedFirstPartyModelToolsPlugin === undefined
          ? {}
          : {
              isHostOwnedFirstPartyModelToolsPlugin:
                options.isHostOwnedFirstPartyModelToolsPlugin
            })
      })
    )
  );
}

export function isDiscoverableCurrentTurnTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
  readonly isHostOwnedFirstPartyModelToolsPlugin?: IsHostOwnedFirstPartyModelToolsPlugin;
}): boolean {
  if (isModelFacingPluginTool(options)) {
    return options.plugin.lifecycleHooks.handleToolCall !== undefined;
  }

  return isFirstPartyBuiltInModelTool(options);
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
    !toolRequiresConfirmation(options) &&
    options.tool.sideEffectLevel === 'none'
  );
}

export function isModelFacingPluginTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    !isBuiltInModelToolName(options.tool.name) &&
    options.tool.validationOwner === 'plugin_host' &&
    !toolRequiresConfirmation(options) &&
    (options.tool.sideEffectLevel === 'none' ||
      options.tool.sideEffectLevel === 'runtime_read' ||
      options.tool.sideEffectLevel === 'local_memory_write')
  );
}

export function validateRuntimePluginModelFacingToolAccess(options: {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
}): void {
  const hasModelFacingTool = options.providedTools.some((tool) =>
    isModelFacingPluginTool({
      plugin: {
        manifest: options.manifest,
        providedTools: options.providedTools,
        lifecycleHooks: {}
      },
      tool
    })
  );

  if (
    hasModelFacingTool &&
    options.manifest.requestedAccess.model_input !== 'write'
  ) {
    throw new TypeError(
      'Model-facing tools require requestedAccess.model_input = "write".'
    );
  }
}

export function toolAllowsFileStoreWrites(
  tool: RuntimePluginProvidedTool
): boolean {
  return sideEffectLevelAllowsFileStoreWrites(tool.sideEffectLevel);
}

export function sideEffectLevelAllowsFileStoreWrites(
  sideEffectLevel: RuntimePluginSideEffectLevel
): boolean {
  return sideEffectLevel === 'local_memory_write';
}

export function toolRequiresConfirmation(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    options.plugin.manifest.runtimePolicy.confirmation === 'required' ||
    options.tool.requiresConfirmation
  );
}
