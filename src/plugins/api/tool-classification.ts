import {isBuiltInModelToolName} from '../../role-model/api/index.ts';

import type {
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
} from './types.ts';

/**
 * A tool reaches the model when its plugin is enabled and the host
 * validates it. Enabling the plugin is the trust decision — as with a
 * local MCP server the user chose to run — so the runtime no longer
 * filters tools by a declared effect level. A tool that wants consent
 * per call says so with requiresConfirmation and is prompted, rather
 * than being hidden from the model entirely.
 */
export function isModelFacingRuntimePluginTool(options: {
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    !isBuiltInModelToolName(options.tool.name) &&
    options.tool.validationOwner === 'plugin_host'
  );
}

/**
 * A tool whose call prepares an effect for the user to approve.
 *
 * `requiresConfirmation` names one protocol, not a general "ask me
 * first" flag: the hook runs, stages a `preparedConfigEffect`, and the
 * runtime shows that effect and applies it only if the user agrees.
 * Nothing is written before the prompt because the hook wrote nothing.
 *
 * So this cannot gate a tool that *acts* when called. Such a tool would
 * finish its work, then be asked about — worse than not gating it, since
 * the user is consulted about something already done. The contract is
 * stated on the tool type and enforced by
 * `assertPreparedConfirmationProtocol`; a tool that acts and wants
 * consent has to ask inside its own hook, where it still can.
 */
export function isApprovalGatedRuntimePluginTool(
  tool: RuntimePluginProvidedTool,
): boolean {
  return isModelFacingRuntimePluginTool({tool}) && tool.requiresConfirmation;
}

export function validateRuntimePluginModelFacingToolAccess(options: {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
}): void {
  const hasModelFacingTool = options.providedTools.some(tool =>
    isModelFacingRuntimePluginTool({tool}),
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
