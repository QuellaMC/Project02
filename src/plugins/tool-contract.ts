import { isBuiltInModelToolName } from '../role-model/model-tools.ts';

import type {
  RuntimePluginManifest,
  RuntimePluginProvidedTool
} from './plugin-types.ts';

export function isModelFacingRuntimePluginTool(options: {
  readonly manifest: RuntimePluginManifest;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    !isBuiltInModelToolName(options.tool.name) &&
    options.tool.validationOwner === 'plugin_host' &&
    options.manifest.runtimePolicy.confirmation !== 'required' &&
    !options.tool.requiresConfirmation &&
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
    isModelFacingRuntimePluginTool({
      manifest: options.manifest,
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
