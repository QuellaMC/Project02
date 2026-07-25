import {createRuntimePluginEvidenceSnapshot} from '../api/constructors.ts';
import type {
  RuntimePluginEvidenceKind,
  RuntimePluginEvidenceStatus,
  RuntimePluginPolicyOutcome,
} from '../api/contract.ts';
import {runtimeIdentityMatchesContext} from '../api/identity.ts';
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
  RuntimePluginSourceReference,
} from '../api/types.ts';
import {mergedRedactionLabels} from '../api/evidence-policy.ts';

export function normalizeEvidenceSnapshots(options: {
  readonly plugin: RuntimePlugin;
  readonly pluginId?: string | undefined;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): readonly RuntimePluginEvidenceSnapshot[] {
  const items = requiredArray(options.value, 'evidence');
  if (items.length > 64) {
    throw new TypeError('evidence exceeds the 64-record limit.');
  }

  return Object.freeze(
    items.map(item => {
      const evidence = createRuntimePluginEvidenceSnapshot(item);

      assertSnapshotPluginId({
        plugin: options.plugin,
        pluginId: options.pluginId,
        actualPluginId: evidence.pluginId,
        field: 'evidence.pluginId',
      });
      assertSnapshotRuntimeIdentity({
        context: options.context,
        snapshot: evidence,
        field: 'evidence',
      });

      return evidence;
    }),
  );
}

export function createHookFailureEvidence(options: {
  readonly plugin: RuntimePlugin;
  readonly policyManifest?: RuntimePluginManifest | undefined;
  readonly pluginId?: string | undefined;
  readonly context: RuntimePluginContext;
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly status: RuntimePluginEvidenceStatus;
  readonly summary: string;
  readonly policyOutcome?: RuntimePluginPolicyOutcome;
}): RuntimePluginEvidenceSnapshot {
  const policyManifest = options.policyManifest ?? options.plugin.manifest;

  return createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.pluginId ?? options.plugin.manifest.id,
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: options.summary,
    ...(options.policyOutcome === undefined
      ? {}
      : {policyOutcome: options.policyOutcome}),
    redactionLabels: mergedRedactionLabels({
      manifest: policyManifest,
      context: options.context,
    }),
    ...(policyManifest.config.fingerprint === undefined
      ? {}
      : {configFingerprint: policyManifest.config.fingerprint}),
  });
}

export function failurePolicyOutcomeOption(
  evidenceKind: RuntimePluginEvidenceKind,
  failureKind: 'exception' | 'timeout',
): {readonly policyOutcome?: RuntimePluginPolicyOutcome} {
  if (failureKind === 'timeout') {
    return {
      policyOutcome: 'timeout',
    };
  }

  if (evidenceKind === 'after_turn_committed') {
    return {
      policyOutcome: 'after_commit_failed',
    };
  }

  return {};
}

export function assertSnapshotPluginId(options: {
  readonly plugin: RuntimePlugin;
  readonly pluginId?: string | undefined;
  readonly actualPluginId: string;
  readonly field: string;
}): void {
  const pluginId = options.pluginId ?? options.plugin.manifest.id;

  if (options.actualPluginId === pluginId) {
    return;
  }

  throw new TypeError(`${options.field} must match plugin "${pluginId}".`);
}

function assertSnapshotRuntimeIdentity(options: {
  readonly context: RuntimePluginContext;
  readonly snapshot: Pick<
    RuntimePluginEvidenceSnapshot,
    'eventId' | 'traceId' | 'createdAt'
  >;
  readonly field: string;
}): void {
  if (runtimeIdentityMatchesContext(options.snapshot, options.context)) {
    return;
  }

  throw new TypeError(
    `${options.field} identity must match current runtime event identity.`,
  );
}

export function assertContextItemSourceReferences(options: {
  readonly plugin: RuntimePlugin;
  readonly contextItem: RuntimePluginContextItem;
}): void {
  assertRequiredSourceReferences({
    sourceReferencesRequired:
      options.plugin.manifest.runtimePolicy.sourceReferencesRequired,
    sourceReferences: options.contextItem.sourceReferences,
    message: `Plugin "${options.plugin.manifest.id}" context item "${options.contextItem.id}" requires source references.`,
  });
}

export function assertAcceptedToolEvidenceSourceReferences(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
}): void {
  assertRequiredSourceReferences({
    sourceReferencesRequired: options.providedTool.sourceReferencesRequired,
    sourceReferences: options.evidence
      .filter(
        evidence =>
          evidence.evidenceKind === 'tool_invocation' &&
          evidence.status === 'accepted',
      )
      .flatMap(evidence => evidence.sourceReferences ?? []),
    message: `Plugin "${options.plugin.manifest.id}" tool "${options.providedTool.name}" accepted result requires source references.`,
  });
}

function assertRequiredSourceReferences(options: {
  readonly sourceReferencesRequired: boolean;
  readonly sourceReferences:
    readonly RuntimePluginSourceReference[] | undefined;
  readonly message: string;
}): void {
  if (!options.sourceReferencesRequired) {
    return;
  }

  if ((options.sourceReferences?.length ?? 0) > 0) {
    return;
  }

  throw new TypeError(options.message);
}

export function requiredArray(
  value: unknown,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }

  return value;
}
