import { isBuiltInModelToolName } from '../role-model/model-tools.ts';

import type {
  RuntimePluginManifest,
  RuntimePluginProvidedTool
} from './plugin-types.ts';
import {
  runtimePluginConfigUpdateToolName,
  runtimePluginId
} from './contract.ts';

export function isModelFacingRuntimePluginTool(options: {
  readonly manifest: RuntimePluginManifest;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  const approvalGatedRuntimeConfigWrite =
    isApprovalGatedRuntimeConfigTool(options);

  return (
    approvalGatedRuntimeConfigWrite ||
    (!isBuiltInModelToolName(options.tool.name) &&
      options.tool.validationOwner === 'plugin_host' &&
      options.manifest.runtimePolicy.confirmation !== 'required' &&
      !options.tool.requiresConfirmation &&
      (options.tool.sideEffectLevel === 'none' ||
        options.tool.sideEffectLevel === 'runtime_read' ||
        options.tool.sideEffectLevel === 'local_memory_write'))
  );
}

export function isApprovalGatedRuntimeConfigTool(options: {
  readonly manifest: RuntimePluginManifest;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    options.manifest.id === runtimePluginId &&
    options.tool.name === runtimePluginConfigUpdateToolName &&
    options.tool.validationOwner === 'plugin_host' &&
    options.manifest.runtimePolicy.confirmation !== 'required' &&
    options.tool.requiresConfirmation &&
    options.tool.sideEffectLevel === 'runtime_config_write'
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
