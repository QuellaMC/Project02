import {runtimePluginSourceReferenceLimit} from '../../api/validation-primitives.ts';
import {
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
} from '../../api/constructors.ts';
import {createRuntimePluginContextItem} from '../../api/manifest-validation.ts';
import type {RuntimePluginEvidenceKind} from '../../api/contract.ts';
import type {
  RuntimePluginContext,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginJsonObject,
  RuntimePluginLifecycleHooks,
  RuntimePluginSourceReference,
  RuntimePluginToolCallResult,
} from '../../api/types.ts';
import {
  boundedMemoryItems,
  boundedText,
  memoryProviderMaxItems,
} from './context.ts';
import type {MemoryRecallItem, Project02MemoryProvider} from './types.ts';

export function createMemoryProviderLifecycleHooks(options: {
  readonly provider: Project02MemoryProvider;
  readonly pluginId: string;
  readonly searchToolName: string;
  readonly addToolName: string;
}): RuntimePluginLifecycleHooks {
  return Object.freeze({
    ...(options.provider.recall === undefined
      ? {}
      : {beforeRoleModelCall: createRecallHook(options)}),
    ...(options.provider.captureTurn === undefined
      ? {}
      : {afterTurnCommitted: createCaptureTurnHook(options)}),
    ...(options.provider.search === undefined &&
    options.provider.add === undefined
      ? {}
      : {handleToolCall: createToolCallHook(options)}),
    ...(options.provider.health === undefined
      ? {}
      : {health: createHealthHook(options)}),
    ...(options.provider.endSession === undefined
      ? {}
      : {onSessionEnd: createSessionEndHook(options)}),
    ...(options.provider.close === undefined
      ? {}
      : {onShutdown: createShutdownHook(options)}),
  } satisfies RuntimePluginLifecycleHooks);
}

type MemoryProviderHookOptions = {
  readonly provider: Project02MemoryProvider;
  readonly pluginId: string;
  readonly searchToolName: string;
  readonly addToolName: string;
};

function createRecallHook(
  options: MemoryProviderHookOptions,
): NonNullable<RuntimePluginLifecycleHooks['beforeRoleModelCall']> {
  return async context => {
    const result = await options.provider.recall?.({
      sessionId: context.sessionId,
      currentUserMessage: context.currentUserMessage,
      maxItems: memoryProviderMaxItems,
      deadlineAt: context.deadlineAt,
      signal: context.signal,
    });
    const items = boundedMemoryItems(
      sourceBackedMemoryItems(result?.items ?? []),
    );

    return {
      contextItems: items.map(item =>
        createRuntimePluginContextItem({
          pluginId: options.pluginId,
          id: memoryContextItemId(item.id),
          kind: 'memory',
          text: item.text,
          budget: {
            estimatedTokens: Math.max(1, Math.ceil(item.text.length / 4)),
            priority: 70,
          },
          sourceReferences: item.sourceReferences,
          ...(item.confidence === undefined
            ? {}
            : {confidence: item.confidence}),
          redactionLabels: ['memory'],
        }),
      ),
      evidence: [
        memoryEvidence({
          context,
          pluginId: options.pluginId,
          evidenceKind: 'before_role_model_call',
          status: 'accepted',
          summary: `Provided ${String(items.length)} memory item(s).`,
        }),
      ],
    };
  };
}

function createCaptureTurnHook(
  options: MemoryProviderHookOptions,
): NonNullable<RuntimePluginLifecycleHooks['afterTurnCommitted']> {
  return async context => {
    const lastCharacterMessage = context.committedTurn.visibleMessages
      .filter(message => message.role === 'character')
      .at(-1)?.text;
    const inputSourceReferences = currentTurnSourceReferences(context);
    const result = await options.provider.captureTurn?.({
      sessionId: context.sessionId,
      userMessage: context.currentUserMessage,
      sourceReferences: inputSourceReferences,
      deadlineAt: context.deadlineAt,
      signal: context.signal,
      ...(lastCharacterMessage === undefined
        ? {}
        : {characterMessage: lastCharacterMessage}),
    });
    const providerSourceReferences = nonEmptySourceReferences(
      result?.sourceReferences,
    );
    const missingAcceptedCaptureSources =
      result?.captured !== false && providerSourceReferences === undefined;

    return {
      status: 'completed',
      evidence: [
        memoryEvidence({
          context,
          pluginId: options.pluginId,
          evidenceKind: 'after_turn_committed',
          status:
            result?.captured === false || missingAcceptedCaptureSources
              ? 'degraded'
              : 'accepted',
          summary: captureTurnEvidenceSummary({
            resultSummary: result?.summary,
            missingAcceptedCaptureSources,
          }),
          sourceReferences: providerSourceReferences ?? inputSourceReferences,
        }),
      ],
    };
  };
}

function createToolCallHook(
  options: MemoryProviderHookOptions,
): NonNullable<RuntimePluginLifecycleHooks['handleToolCall']> {
  return async (call, context) => {
    if (
      call.toolName === options.searchToolName &&
      options.provider.search !== undefined
    ) {
      return await runMemorySearchTool(options, call.input, context);
    }

    if (
      call.toolName === options.addToolName &&
      options.provider.add !== undefined
    ) {
      return await runMemoryAddTool(options, call.input, context);
    }

    return {
      status: 'rejected',
      reason: 'tool_not_declared',
      message: `Memory provider does not handle "${call.toolName}".`,
      evidence: [
        memoryEvidence({
          context,
          pluginId: options.pluginId,
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          summary: 'Rejected unsupported memory tool call.',
        }),
      ],
    } satisfies RuntimePluginToolCallResult;
  };
}

async function runMemorySearchTool(
  options: MemoryProviderHookOptions,
  input: RuntimePluginJsonObject,
  context: RuntimePluginContext,
): Promise<RuntimePluginToolCallResult> {
  const result = await options.provider.search?.({
    sessionId: context.sessionId,
    query: stringInput(input, 'query'),
    maxItems: memoryProviderMaxItems,
    deadlineAt: context.deadlineAt,
    signal: context.signal,
  });

  if (result === undefined) {
    throw new TypeError('Memory provider search hook is unavailable.');
  }

  const items = boundedMemoryItems(sourceBackedMemoryItems(result.items));

  return acceptedToolResult({
    context,
    pluginId: options.pluginId,
    output: {items: items.map(memoryItemOutput)},
    summary: `Returned ${String(items.length)} memory search result(s).`,
    sourceReferences: searchSourceReferences({
      context,
      items,
      searchToolName: options.searchToolName,
    }),
  });
}

async function runMemoryAddTool(
  options: MemoryProviderHookOptions,
  input: RuntimePluginJsonObject,
  context: RuntimePluginContext,
): Promise<RuntimePluginToolCallResult> {
  const inputSourceReferences = currentTurnSourceReferences(context);
  const result = await options.provider.add?.({
    sessionId: context.sessionId,
    text: boundedText(stringInput(input, 'text'), 600),
    sourceReferences: inputSourceReferences,
    deadlineAt: context.deadlineAt,
    signal: context.signal,
  });

  if (result === undefined) {
    throw new TypeError('Memory provider add hook is unavailable.');
  }

  const persistedSourceReferences = addResultSourceReferences(result);

  return acceptedToolResult({
    context,
    pluginId: options.pluginId,
    output: {
      id: result.id,
      sourceReferences: persistedSourceReferences,
    },
    summary: 'Added one memory item.',
    sourceReferences: [...inputSourceReferences, ...persistedSourceReferences],
  });
}

function createHealthHook(
  options: MemoryProviderHookOptions,
): NonNullable<RuntimePluginLifecycleHooks['health']> {
  return async context => {
    const result = await options.provider.health?.({
      checkedAt: context.timestamp,
      deadlineAt: context.deadlineAt,
      signal: context.signal,
    });

    return createRuntimePluginHealthSnapshot({
      pluginId: options.pluginId,
      status: result?.status ?? 'unavailable',
      checkedAt: context.timestamp,
      summary: boundedText(result?.summary ?? 'Health unavailable.', 160),
      redactionLabels: ['memory'],
    });
  };
}

function createSessionEndHook(
  options: MemoryProviderHookOptions,
): NonNullable<RuntimePluginLifecycleHooks['onSessionEnd']> {
  return async context => {
    await options.provider.endSession?.(context.sessionId, {
      deadlineAt: context.deadlineAt,
      signal: context.signal,
    });

    return completedLifecycleResult(
      context,
      options.pluginId,
      'session_end',
      'Ended memory provider session.',
    );
  };
}

function createShutdownHook(
  options: MemoryProviderHookOptions,
): NonNullable<RuntimePluginLifecycleHooks['onShutdown']> {
  return async context => {
    await options.provider.close?.({
      deadlineAt: context.deadlineAt,
      signal: context.signal,
    });

    return completedLifecycleResult(
      context,
      options.pluginId,
      'shutdown',
      'Closed memory provider.',
    );
  };
}

function completedLifecycleResult(
  context: RuntimePluginContext,
  pluginId: string,
  evidenceKind: Extract<RuntimePluginEvidenceKind, 'session_end' | 'shutdown'>,
  summary: string,
): ReturnType<NonNullable<RuntimePluginLifecycleHooks['onSessionEnd']>> {
  return {
    status: 'completed',
    evidence: [
      memoryEvidence({
        context,
        pluginId,
        evidenceKind,
        status: 'accepted',
        summary,
      }),
    ],
  };
}

function acceptedToolResult(options: {
  readonly context: RuntimePluginContext;
  readonly pluginId: string;
  readonly output: RuntimePluginJsonObject;
  readonly summary: string;
  readonly sourceReferences?: readonly RuntimePluginSourceReference[];
}): RuntimePluginToolCallResult {
  return {
    status: 'accepted',
    output: options.output,
    evidence: [
      memoryEvidence({
        context: options.context,
        pluginId: options.pluginId,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: options.summary,
        ...(options.sourceReferences === undefined
          ? {}
          : {sourceReferences: options.sourceReferences}),
      }),
    ],
  };
}

function memoryItemOutput(item: MemoryRecallItem): RuntimePluginJsonObject {
  return {
    id: item.id,
    text: item.text,
    sourceReferences: item.sourceReferences.map(reference => ({
      kind: reference.kind,
      id: reference.id,
      ...(reference.title === undefined ? {} : {title: reference.title}),
      ...(reference.uri === undefined ? {} : {uri: reference.uri}),
    })),
    ...(item.confidence === undefined ? {} : {confidence: item.confidence}),
  };
}

function sourceBackedMemoryItems(
  items: readonly MemoryRecallItem[],
): readonly MemoryRecallItem[] {
  return Object.freeze(
    items.filter(
      item =>
        Array.isArray(item.sourceReferences) &&
        item.sourceReferences.length > 0,
    ),
  );
}

function memoryContextItemId(providerItemId: string): string {
  const sanitized = providerItemId.replaceAll(/[^A-Za-z0-9._-]/gu, '_');
  const suffix = sanitized.length === 0 ? 'item' : sanitized;

  return boundedText(`memory.${suffix}`, 128);
}

function searchSourceReferences(options: {
  readonly context: RuntimePluginContext;
  readonly items: readonly MemoryRecallItem[];
  readonly searchToolName: string;
}): readonly RuntimePluginSourceReference[] {
  const itemSourceReferences = options.items.flatMap(
    item => item.sourceReferences,
  );

  if (itemSourceReferences.length > 0) {
    return itemSourceReferences;
  }

  return Object.freeze([
    {
      kind: 'runtime',
      id: `${options.context.eventId}:${options.searchToolName}.no_results`,
      title: 'Memory search completed with no results',
    },
  ] satisfies RuntimePluginSourceReference[]);
}

function addResultSourceReferences(options: {
  readonly id: string;
  readonly sourceReferences: readonly RuntimePluginSourceReference[];
}): readonly RuntimePluginSourceReference[] {
  if (
    options.sourceReferences.some(
      reference => reference.kind === 'memory' && reference.id === options.id,
    )
  ) {
    return options.sourceReferences;
  }

  return Object.freeze([
    ...options.sourceReferences,
    {
      kind: 'memory',
      id: options.id,
      title: 'Persisted memory item',
    },
  ] satisfies RuntimePluginSourceReference[]);
}

function currentTurnSourceReferences(
  context: RuntimePluginContext,
): readonly RuntimePluginSourceReference[] {
  return Object.freeze([
    {
      kind: 'conversation',
      id: context.eventId,
      title: 'Current conversation turn',
    },
  ] satisfies RuntimePluginSourceReference[]);
}

function nonEmptySourceReferences(
  sourceReferences: readonly RuntimePluginSourceReference[] | undefined,
): readonly RuntimePluginSourceReference[] | undefined {
  return sourceReferences === undefined || sourceReferences.length === 0
    ? undefined
    : sourceReferences;
}

function captureTurnEvidenceSummary(options: {
  readonly resultSummary: string | undefined;
  readonly missingAcceptedCaptureSources: boolean;
}): string {
  const summary = options.resultSummary ?? 'Captured memory turn.';

  if (!options.missingAcceptedCaptureSources) {
    return boundedText(summary, 160);
  }

  const suffix = ' Missing provider source references.';

  return boundedText(
    `${boundedText(summary, 160 - suffix.length)}${suffix}`,
    160,
  );
}

function memoryEvidence(options: {
  readonly context: RuntimePluginContext;
  readonly pluginId: string;
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly status: RuntimePluginEvidenceSnapshot['status'];
  readonly summary: string;
  readonly sourceItems?: readonly MemoryRecallItem[];
  readonly sourceReferences?: readonly RuntimePluginSourceReference[];
}): RuntimePluginEvidenceSnapshot {
  // A backend that names many rows must not turn a completed write into a
  // failed hook: evidence records what fits, the write already happened.
  const sourceReferences = (
    options.sourceReferences ??
    options.sourceItems?.flatMap(item => item.sourceReferences)
  )?.slice(0, runtimePluginSourceReferenceLimit);

  return createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.pluginId,
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: boundedText(options.summary, 160),
    ...(sourceReferences === undefined ? {} : {sourceReferences}),
    redactionLabels: ['memory'],
  });
}

function stringInput(input: RuntimePluginJsonObject, key: string): string {
  const value = input[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(
      `Memory tool input "${key}" must be a non-empty string.`,
    );
  }

  return value;
}
