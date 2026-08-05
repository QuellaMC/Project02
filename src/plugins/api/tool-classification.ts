import {isBuiltInModelToolName} from '../../role-model/api/index.ts';

import type {
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
} from './types.ts';

/**
 * Enabling the plugin is the trust decision, as with a local MCP server
 * the user chose to run, so tools are not filtered by declared risk. A
 * tool that needs asking says so per tool, and is withheld only when the
 * host has no way to ask.
 */
export function isModelFacingRuntimePluginTool(options: {
  readonly manifest: RuntimePluginManifest;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    !isBuiltInModelToolName(options.tool.name) &&
    options.tool.validationOwner === 'plugin_host'
  );
}

/**
 * A tool whose call stages a `preparedConfigEffect` for the user to
 * approve, applying nothing until they do. It cannot gate a tool that
 * acts when called — the prompt would come after the action — so one
 * that prepares nothing is rejected when its result is normalized.
 */
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
