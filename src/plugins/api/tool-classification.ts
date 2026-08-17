import {isBuiltInModelToolName} from '../../role-model/api/index.ts';

import type {
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
} from './types.ts';

/** Enabling is the trust decision: tools are not filtered by declared risk. */
export function isModelFacingRuntimePluginTool(
  tool: RuntimePluginProvidedTool,
): boolean {
  return (
    !isBuiltInModelToolName(tool.name) && tool.validationOwner === 'plugin_host'
  );
}

/** A gated tool prepares its effect; the host applies it once the user approves. */
export function isApprovalGatedRuntimePluginTool(
  tool: RuntimePluginProvidedTool,
): boolean {
  return isModelFacingRuntimePluginTool(tool) && tool.requiresConfirmation;
}

export function validateRuntimePluginModelFacingToolAccess(options: {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
}): void {
  const hasModelFacingTool = options.providedTools.some(
    isModelFacingRuntimePluginTool,
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
