import {isBuiltInModelToolName} from '../../role-model/api/index.ts';

import type {
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
} from './types.ts';

/** Enabling is the trust decision: tools are not filtered by declared risk. */
export function isModelFacingRuntimePluginTool(options: {
  readonly manifest: RuntimePluginManifest;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    !isBuiltInModelToolName(options.tool.name) &&
    options.tool.validationOwner === 'plugin_host'
  );
}

/** Gated tools stage an effect and apply nothing until the user approves. */
export function isApprovalGatedRuntimePluginTool(options: {
  readonly manifest: RuntimePluginManifest;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    isModelFacingRuntimePluginTool(options) && options.tool.requiresConfirmation
  );
}

export function validateRuntimePluginModelFacingToolAccess(options: {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
}): void {
  const hasModelFacingTool = options.providedTools.some(tool =>
    isModelFacingRuntimePluginTool({manifest: options.manifest, tool}),
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
