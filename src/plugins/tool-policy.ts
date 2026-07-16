import { isBuiltInModelToolName } from '../role-model/model-tools.ts';
import type { RoleModelPluginToolDefinition } from '../role-model/contracts.ts';
import { isFirstPartyModelToolsPlugin } from './builtin/model-tools.ts';
import { isModelFacingRuntimePluginTool } from './tool-contract.ts';
import {
  runtimePluginAccessFor,
  runtimePluginAccessForPlugin,
  runtimePluginGrantsAccess,
  type RuntimePluginAccessMapByPluginId
} from './access-control.ts';
import type {
  RuntimePlugin,
  RuntimePluginProvidedTool
} from './plugin-types.ts';
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
  readonly confirmationAvailable: boolean;
}): readonly RoleModelPluginToolDefinition[] {
  return Object.freeze(
    options.plugins
      .flatMap((plugin) => {
        const access = runtimePluginAccessForPlugin({
          plugin,
          accessByPluginId: options.accessByPluginId
        });

        return modelVisiblePluginTools({
          plugin,
          access,
          confirmationAvailable: options.confirmationAvailable
        }).map((tool) =>
          Object.freeze({
            pluginId: plugin.manifest.id,
            ...tool
          } satisfies RoleModelPluginToolDefinition)
        );
      })
      .sort(modelToolDefinitionOrder)
  );
}

function modelToolDefinitionOrder(
  left: RoleModelPluginToolDefinition,
  right: RoleModelPluginToolDefinition
): number {
  const leftBuiltIn = isBuiltInModelToolName(left.name);
  const rightBuiltIn = isBuiltInModelToolName(right.name);

  if (leftBuiltIn === rightBuiltIn) {
    return 0;
  }

  return leftBuiltIn ? -1 : 1;
}

export function modelVisiblePluginTools(options: {
  readonly plugin: RuntimePlugin;
  readonly access: RuntimePluginAccessSnapshot;
  readonly confirmationAvailable: boolean;
}): readonly RuntimePluginProvidedTool[] {
  return Object.freeze(
    options.plugin.providedTools.filter(
      (tool) =>
        pluginToolHasRequiredGrantedAccess({
          tool,
          access: options.access
        }) &&
        (!tool.requiresConfirmation || options.confirmationAvailable) &&
        isModelVisiblePluginTool({
          plugin: options.plugin,
          tool
        })
    )
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
      (tool) =>
        pluginToolHasRequiredGrantedAccess({
          tool,
          access: options.access
        }) &&
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

export function pluginToolHasRequiredGrantedAccess(options: {
  readonly tool: RuntimePluginProvidedTool;
  readonly access: RuntimePluginAccessSnapshot;
}): boolean {
  if (!pluginCanWriteModelInput(options.access)) {
    return false;
  }

  const requestedFileStoreAccess = runtimePluginAccessFor(
    options.access.requestedAccess,
    'file_store'
  );

  // A local-memory tool may own storage behind its provider and request no
  // host fileStore access. If it opts into the host fileStore, a write-classed
  // tool must hold the matching write grant instead of a read-only handle.
  return (
    !toolAllowsFileStoreWrites(options.tool) ||
    requestedFileStoreAccess === 'none' ||
    runtimePluginGrantsAccess({
      access: options.access,
      accessName: 'file_store',
      requiredAccess: 'write'
    })
  );
}

export function discoverableCurrentTurnPluginTools(options: {
  readonly plugin: RuntimePlugin;
  readonly access: RuntimePluginAccessSnapshot;
  readonly confirmationAvailable: boolean;
  readonly isHostOwnedFirstPartyModelToolsPlugin?: IsHostOwnedFirstPartyModelToolsPlugin;
}): readonly RuntimePluginProvidedTool[] {
  return Object.freeze(
    options.plugin.providedTools.filter(
      (tool) =>
        pluginToolHasRequiredGrantedAccess({
          tool,
          access: options.access
        }) &&
        (!tool.requiresConfirmation || options.confirmationAvailable) &&
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
    !toolRequiresConfirmation(options.tool) &&
    options.tool.sideEffectLevel === 'none'
  );
}

export function isModelFacingPluginTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return isModelFacingRuntimePluginTool({
    manifest: options.plugin.manifest,
    tool: options.tool
  });
}

export function isModelVisiblePluginTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  if (
    isFirstPartyBuiltInModelTool({
      ...options,
      isHostOwnedFirstPartyModelToolsPlugin: isFirstPartyModelToolsPlugin
    })
  ) {
    return true;
  }

  return (
    options.plugin.lifecycleHooks.handleToolCall !== undefined &&
    isModelFacingPluginTool(options)
  );
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

export function toolRequiresConfirmation(
  tool: RuntimePluginProvidedTool
): boolean {
  return tool.requiresConfirmation;
}
