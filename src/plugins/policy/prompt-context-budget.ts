import { createHookFailureEvidence } from '../host/hook-evidence.ts';
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot
} from '../api/types.ts';
import { beforeRoleModelFailureRejectsTurn } from '../api/evidence-policy.ts';

const runtimePluginContextEstimatedTokenBudget = 256;

export type CollectedPluginContextItem = {
  readonly plugin: RuntimePlugin;
  readonly item: RuntimePluginContextItem;
};

type CollectedPluginPromptContext = {
  readonly plugin: RuntimePlugin;
  readonly promptIndex: number;
  readonly estimatedTokens: number;
  readonly priority: number;
  readonly contextItem: CollectedPluginContextItem;
};

export type BoundedPluginPromptContextResult =
  | {
      readonly status: 'completed';
      readonly contextItems: readonly RuntimePluginContextItem[];
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly pluginId: string;
      readonly message: string;
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    };

export function boundPluginPromptContext(options: {
  readonly context: RuntimePluginContext;
  readonly contextItems: readonly CollectedPluginContextItem[];
}): BoundedPluginPromptContextResult {
  const candidates = collectedPluginPromptContextCandidates({
    contextItems: options.contextItems
  });
  const totalEstimatedTokens = candidates.reduce(
    (total, candidate) => total + candidate.estimatedTokens,
    0
  );

  if (totalEstimatedTokens <= runtimePluginContextEstimatedTokenBudget) {
    return Object.freeze({
      status: 'completed',
      contextItems: Object.freeze(
        options.contextItems.map((contextItem) => contextItem.item)
      ),
      evidence: Object.freeze([])
    });
  }

  const retainedCandidates = new Set<CollectedPluginPromptContext>();
  let retainedEstimatedTokens = 0;

  for (const candidate of [...candidates].sort(
    compareCollectedPromptContextPriority
  )) {
    const nextEstimatedTokens =
      retainedEstimatedTokens + candidate.estimatedTokens;

    if (nextEstimatedTokens > runtimePluginContextEstimatedTokenBudget) {
      continue;
    }

    retainedCandidates.add(candidate);
    retainedEstimatedTokens = nextEstimatedTokens;
  }

  const retainedContextItems = candidates.flatMap((candidate) => {
    if (!retainedCandidates.has(candidate)) {
      return [];
    }

    return [candidate.contextItem.item];
  });
  const droppedCandidates = candidates.filter(
    (candidate) => !retainedCandidates.has(candidate)
  );
  const evidence = contextBudgetEvidence({
    context: options.context,
    droppedCandidates,
    retainedEstimatedTokens,
    totalEstimatedTokens
  });
  const rejectedContextItem =
    firstDroppedPromptContextThatRejectsTurn(droppedCandidates);

  if (rejectedContextItem !== undefined) {
    return Object.freeze({
      status: 'rejected',
      pluginId: rejectedContextItem.plugin.manifest.id,
      message: requiredContextBudgetRejectionMessage(rejectedContextItem),
      evidence
    });
  }

  return Object.freeze({
    status: 'completed',
    contextItems: Object.freeze(retainedContextItems),
    evidence
  });
}

function collectedPluginPromptContextCandidates(options: {
  readonly contextItems: readonly CollectedPluginContextItem[];
}): readonly CollectedPluginPromptContext[] {
  const candidates: CollectedPluginPromptContext[] = [];

  for (const contextItem of options.contextItems) {
    candidates.push({
      plugin: contextItem.plugin,
      promptIndex: candidates.length,
      estimatedTokens: estimateContextItemTokens(contextItem.item),
      priority: contextItem.item.budget.priority,
      contextItem
    });
  }

  return Object.freeze(candidates);
}

function compareCollectedPromptContextPriority(
  left: CollectedPluginPromptContext,
  right: CollectedPluginPromptContext
): number {
  return right.priority - left.priority || left.promptIndex - right.promptIndex;
}

function contextBudgetEvidence(options: {
  readonly context: RuntimePluginContext;
  readonly droppedCandidates: readonly CollectedPluginPromptContext[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): readonly RuntimePluginEvidenceSnapshot[] {
  const droppedByPlugin = new Map<
    string,
    {
      readonly plugin: RuntimePlugin;
      readonly dropped: CollectedPluginPromptContext[];
    }
  >();

  for (const droppedCandidate of options.droppedCandidates) {
    const pluginId = droppedCandidate.plugin.manifest.id;
    const entry = droppedByPlugin.get(pluginId);

    if (entry === undefined) {
      droppedByPlugin.set(pluginId, {
        plugin: droppedCandidate.plugin,
        dropped: [droppedCandidate]
      });
      continue;
    }

    entry.dropped.push(droppedCandidate);
  }

  return Object.freeze(
    [...droppedByPlugin.values()].map((entry) => {
      const rejectsTurn = beforeRoleModelFailureRejectsTurn(entry.plugin);

      return createHookFailureEvidence({
        plugin: entry.plugin,
        context: options.context,
        evidenceKind: 'before_role_model_call',
        status: rejectsTurn ? 'rejected' : 'degraded',
        summary: contextBudgetEvidenceSummary({
          droppedCandidates: entry.dropped,
          retainedEstimatedTokens: options.retainedEstimatedTokens,
          totalEstimatedTokens: options.totalEstimatedTokens
        }),
        policyOutcome: rejectsTurn ? 'required_rejected' : 'optional_degraded'
      });
    })
  );
}

function firstDroppedPromptContextThatRejectsTurn(
  droppedCandidates: readonly CollectedPluginPromptContext[]
): CollectedPluginPromptContext | undefined {
  return droppedCandidates.find((candidate) =>
    beforeRoleModelFailureRejectsTurn(candidate.plugin)
  );
}

function requiredContextBudgetRejectionMessage(
  candidate: CollectedPluginPromptContext
): string {
  return `Required before-role-model plugin context exceeded the ${String(
    runtimePluginContextEstimatedTokenBudget
  )}-token budget; dropped context item "${candidate.contextItem.item.id}".`;
}

function contextBudgetEvidenceSummary(options: {
  readonly droppedCandidates: readonly CollectedPluginPromptContext[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): string {
  const droppedIds = options.droppedCandidates
    .map((candidate) => candidate.contextItem.item.id)
    .join(', ');

  return `Plugin context budget kept ${String(
    options.retainedEstimatedTokens
  )}/${String(runtimePluginContextEstimatedTokenBudget)} estimated tokens and dropped ${
    String(options.droppedCandidates.length)
  } item(s) from ${String(
    options.totalEstimatedTokens
  )} estimated tokens${
    droppedIds.length === 0 ? '' : `; dropped ids ${droppedIds}`
  }`;
}

function estimateContextItemTokens(item: RuntimePluginContextItem): number {
  return Math.max(
    item.budget.estimatedTokens,
    estimateRuntimeTextTokens(item.text)
  );
}

function estimateRuntimeTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
