import {
  createRuntimePlugin,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  runtimePluginContractVersion,
  type RuntimePlugin,
  type RuntimePluginContext,
  type RuntimePluginEvidenceKind,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginJsonObject,
  type RuntimePluginProvidedTool,
  type RuntimePluginSourceReference,
  type RuntimePluginToolCallResult
} from '../types.ts';
import {
  boundedMemoryItems,
  boundedText,
  memoryProviderMaxItems
} from './context.ts';
import {
  memoryAddTool,
  memorySearchTool
} from './tools.ts';
import type {
  MemoryRecallItem,
  Project02MemoryProvider
} from './types.ts';

export type CreateMemoryProviderRuntimePluginOptions = {
  readonly pluginId?: string;
  readonly version?: string;
  readonly toolNamespace?: string;
};

export function createMemoryProviderRuntimePlugin(
  provider: Project02MemoryProvider,
  options: CreateMemoryProviderRuntimePluginOptions = {}
): RuntimePlugin {
  const pluginId = options.pluginId ?? provider.id;
  const toolNamespace = options.toolNamespace ?? 'memory';
  const searchToolName = `${toolNamespace}.search`;
  const addToolName = `${toolNamespace}.add`;
  const providedTools: RuntimePluginProvidedTool[] = [];
  const declaredPlugins = ['plugin_discovery'] as string[];

  if (provider.recall !== undefined) {
    declaredPlugins.push('before_role_model_call');
  }

  if (provider.captureTurn !== undefined) {
    declaredPlugins.push('after_turn_committed');
  }

  if (provider.search !== undefined || provider.add !== undefined) {
    declaredPlugins.push('tool_provider', 'handle_tool_call');
  }

  if (provider.health !== undefined) {
    declaredPlugins.push('health');
  }

  if (provider.search !== undefined) {
    providedTools.push(memorySearchTool(searchToolName));
  }

  if (provider.add !== undefined) {
    providedTools.push(memoryAddTool(addToolName));
  }

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: provider.displayName,
      version: options.version ?? '1.0.0',
      kind: 'memory_provider',
      description: 'Runtime memory provider adapter.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02',
        externalContract: 'project02_memory_provider'
      },
      declaredPlugins: Array.from(new Set(declaredPlugins)),
      config: {
        fields: []
      },
      localTrustLevel: 'trusted_adapter',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: provider.add === undefined
          ? 'runtime_read'
          : 'local_memory_write',
        confirmation: 'not_required',
        timeoutMs: 1500,
        sourceReferencesRequired: true,
        redactionLabels: ['memory'],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: false,
        reasons: ['memory_provider_factory']
      },
      requestedApis: []
    },
    providedTools,
    lifecycleHooks: {
      ...(provider.recall === undefined
        ? {}
        : {
            async beforeRoleModelCall(context: RuntimePluginContext) {
              const result = await provider.recall?.({
                sessionId: context.sessionId,
                currentUserMessage: context.currentUserMessage,
                maxItems: memoryProviderMaxItems
              });
              const items = boundedMemoryItems(result?.items ?? []);

              return {
                contextItems: items.map((item) =>
                  createRuntimePluginContextItem({
                    pluginId,
                    id: item.id,
                    kind: 'memory',
                    text: item.text,
                    budget: {
                      estimatedTokens: Math.max(1, Math.ceil(item.text.length / 4)),
                      priority: 70
                    },
                    sourceReferences: item.sourceReferences,
                    ...(item.confidence === undefined
                      ? {}
                      : { confidence: item.confidence }),
                    redactionLabels: ['memory']
                  })
                ),
                runtimeNotes: [],
                evidence: [
                  memoryEvidence({
                    context,
                    pluginId,
                    evidenceKind: 'before_role_model_call',
                    status: 'accepted',
                    summary: `Provided ${String(items.length)} memory item(s).`
                  })
                ]
              };
            }
          }),
      ...(provider.captureTurn === undefined
        ? {}
        : {
            async afterTurnCommitted(context) {
              const lastCharacterMessage =
                context.committedTurn.visibleMessages
                  .filter((message) => message.role === 'character')
                  .at(-1)?.text;
              const result = await provider.captureTurn?.({
                sessionId: context.sessionId,
                userMessage: context.currentUserMessage,
                ...(lastCharacterMessage === undefined
                  ? {}
                  : { characterMessage: lastCharacterMessage })
              });

              return {
                status: 'completed',
                evidence: [
                  memoryEvidence({
                    context,
                    pluginId,
                    evidenceKind: 'after_turn_committed',
                    status: result?.captured === false ? 'degraded' : 'accepted',
                    summary: boundedText(result?.summary ?? 'Captured memory turn.', 160),
                    sourceItems: []
                  })
                ]
              };
            }
          }),
      ...(provider.search === undefined && provider.add === undefined
        ? {}
        : {
            async handleToolCall(call, context) {
              if (call.toolName === searchToolName && provider.search !== undefined) {
                const query = stringInput(call.input, 'query');
                const result = await provider.search({
                  sessionId: context.sessionId,
                  query,
                  maxItems: memoryProviderMaxItems
                });
                const items = boundedMemoryItems(result.items);

                return acceptedToolResult({
                  context,
                  pluginId,
                  output: {
                    items: items.map(memoryItemOutput)
                  },
                  summary: `Returned ${String(items.length)} memory search result(s).`,
                  sourceReferences: items.flatMap((item) => item.sourceReferences)
                });
              }

              if (call.toolName === addToolName && provider.add !== undefined) {
                const text = boundedText(stringInput(call.input, 'text'), 600);
                const inputSourceReferences = [
                  {
                    kind: 'conversation',
                    id: context.eventId,
                    title: 'Current conversation turn'
                  }
                ] as const satisfies readonly RuntimePluginSourceReference[];
                const result = await provider.add({
                  sessionId: context.sessionId,
                  text,
                  sourceReferences: inputSourceReferences
                });

                return acceptedToolResult({
                  context,
                  pluginId,
                  output: {
                    id: result.id,
                    sourceReferences: result.sourceReferences
                  },
                  summary: 'Added one memory item.',
                  sourceReferences: [
                    ...inputSourceReferences,
                    ...result.sourceReferences
                  ]
                });
              }

              return {
                status: 'rejected',
                reason: 'tool_not_declared',
                message: `Memory provider does not handle "${call.toolName}".`,
                evidence: [
                  memoryEvidence({
                    context,
                    pluginId,
                    evidenceKind: 'tool_invocation',
                    status: 'rejected',
                    summary: 'Rejected unsupported memory tool call.'
                  })
                ]
              } satisfies RuntimePluginToolCallResult;
            }
          }),
      ...(provider.health === undefined
        ? {}
        : {
            async health(context) {
              const result = await provider.health?.({
                checkedAt: context.timestamp
              });

              return createRuntimePluginHealthSnapshot({
                pluginId,
                status: result?.status ?? 'unavailable',
                checkedAt: context.timestamp,
                summary: boundedText(result?.summary ?? 'Health unavailable.', 160),
                redactionLabels: ['memory']
              });
            }
          })
    }
  });
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
          : { sourceReferences: options.sourceReferences })
      })
    ]
  };
}

function memoryItemOutput(item: MemoryRecallItem): RuntimePluginJsonObject {
  return {
    id: item.id,
    text: item.text,
    sourceReferences: item.sourceReferences.map((reference) => ({
      kind: reference.kind,
      id: reference.id,
      ...(reference.title === undefined ? {} : { title: reference.title }),
      ...(reference.uri === undefined ? {} : { uri: reference.uri })
    })),
    ...(item.confidence === undefined ? {} : { confidence: item.confidence })
  };
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
  const sourceReferences =
    options.sourceReferences ??
    options.sourceItems?.flatMap((item) => item.sourceReferences);

  return createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.pluginId,
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: boundedText(options.summary, 160),
    ...(sourceReferences === undefined ? {} : { sourceReferences }),
    redactionLabels: ['memory']
  });
}

function stringInput(input: RuntimePluginJsonObject, key: string): string {
  const value = input[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Memory tool input "${key}" must be a non-empty string.`);
  }

  return value;
}
