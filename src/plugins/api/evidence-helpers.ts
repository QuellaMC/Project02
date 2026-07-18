import {createRuntimePluginEvidenceSnapshot} from './constructors.ts';
import type {RuntimePluginEvidenceStatus} from './contract.ts';
import type {
  RuntimePluginContext,
  RuntimePluginEvidenceSnapshot,
} from './types.ts';

export function createPluginToolEvidence(options: {
  readonly context: RuntimePluginContext;
  readonly pluginId: string;
  readonly status: RuntimePluginEvidenceStatus;
  readonly summary: string;
}): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.pluginId,
    evidenceKind: 'tool_invocation',
    status: options.status,
    summary: options.summary,
    redactionLabels: options.context.privacy.redactionLabels,
  });
}

export function createPluginContextEvidence(options: {
  readonly context: RuntimePluginContext;
  readonly pluginId: string;
  readonly status: RuntimePluginEvidenceStatus;
  readonly summary: string;
}): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.pluginId,
    evidenceKind: 'before_role_model_call',
    status: options.status,
    summary: options.summary,
    redactionLabels: options.context.privacy.redactionLabels,
  });
}
