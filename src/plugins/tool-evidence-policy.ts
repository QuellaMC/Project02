import type {
  RuntimePluginEvidenceSnapshot,
  RuntimePluginToolCallResult
} from './plugin-types.ts';

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
