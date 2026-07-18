import {isBuiltInModelToolName} from '../../role-model/api/index.ts';

import type {
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
} from './types.ts';

export function isModelFacingRuntimePluginTool(options: {
  readonly manifest: RuntimePluginManifest;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  const manifestAllowsModelFacingTools =
    options.manifest.runtimePolicy.confirmation !== 'required';

  return (
    manifestAllowsModelFacingTools &&
    (isApprovalGatedRuntimePluginTool(options.tool) ||
      (!isBuiltInModelToolName(options.tool.name) &&
        options.tool.validationOwner === 'plugin_host' &&
        !options.tool.requiresConfirmation &&
        (options.tool.sideEffectLevel === 'none' ||
          options.tool.sideEffectLevel === 'runtime_read' ||
          options.tool.sideEffectLevel === 'local_memory_write')))
  );
}

export function isApprovalGatedRuntimePluginTool(
  tool: RuntimePluginProvidedTool,
): boolean {
  return (
    !isBuiltInModelToolName(tool.name) &&
    tool.validationOwner === 'plugin_host' &&
    tool.requiresConfirmation &&
    tool.sideEffectLevel === 'runtime_config_write'
  );
}

export function validateRuntimePluginModelFacingToolAccess(options: {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
}): void {
  const hasModelFacingTool = options.providedTools.some(tool =>
    isModelFacingRuntimePluginTool({
      manifest: options.manifest,
      tool,
    }),
  );

  if (
    hasModelFacingTool &&
    options.manifest.requestedAccess.model_input !== 'write'
  ) {
    throw new TypeError(
      'Model-facing tools require requestedAccess.model_input = "write".',
    );
  }
}
