import {
  createAgentCapabilityEvidenceSnapshot,
  type AgentCapabilityEvidenceSnapshot,
  type AgentCapabilityEvidenceStatus,
  type RuntimeCapabilityContext
} from '../agent-capabilities.ts';

export function createPluginToolEvidence(options: {
  readonly context: RuntimeCapabilityContext;
  readonly pluginId: string;
  readonly status: AgentCapabilityEvidenceStatus;
  readonly summary: string;
}): AgentCapabilityEvidenceSnapshot {
  return createAgentCapabilityEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'agent_capability_evidence_snapshot',
    capabilityId: options.pluginId,
    evidenceKind: 'tool_invocation',
    status: options.status,
    summary: options.summary,
    redactionLabels: options.context.privacy.redactionLabels
  });
}

export function createPluginContextEvidence(options: {
  readonly context: RuntimeCapabilityContext;
  readonly pluginId: string;
  readonly status: AgentCapabilityEvidenceStatus;
  readonly summary: string;
}): AgentCapabilityEvidenceSnapshot {
  return createAgentCapabilityEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'agent_capability_evidence_snapshot',
    capabilityId: options.pluginId,
    evidenceKind: 'before_role_model_call',
    status: options.status,
    summary: options.summary,
    redactionLabels: options.context.privacy.redactionLabels
  });
}
