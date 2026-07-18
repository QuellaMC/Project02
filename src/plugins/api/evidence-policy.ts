import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginToolCallResult
} from './types.ts';

export function mergedRedactionLabels(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
}): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...options.context.privacy.redactionLabels,
      ...options.plugin.manifest.runtimePolicy.redactionLabels
    ])
  ]);
}

export function runtimePluginEvidenceBlocksToolInvocation(
  evidence: RuntimePluginEvidenceSnapshot
): boolean {
  if (evidence.evidenceKind !== 'tool_invocation') {
    return false;
  }

  return (
    evidence.status === 'rejected' ||
    evidence.status === 'failed' ||
    evidence.policyOutcome === 'handler_rejected' ||
    evidence.policyOutcome === 'required_rejected' ||
    evidence.policyOutcome === 'disallowed_tool_call'
  );
}

export function runtimePluginToolResultHasBlockingEvidence(
  result: RuntimePluginToolCallResult
): boolean {
  return result.evidence.some(runtimePluginEvidenceBlocksToolInvocation);
}

export function beforeRoleModelFailureRejectsTurn(plugin: RuntimePlugin): boolean {
  return (
    plugin.manifest.runtimePolicy.requiredForTurn ||
    plugin.manifest.runtimePolicy.failureBehavior.beforeRoleModelCall ===
      'reject_turn'
  );
}
