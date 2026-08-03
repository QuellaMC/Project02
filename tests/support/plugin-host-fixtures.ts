import {testCharacterProfile} from './character-fixtures.ts';
import {readFileSync} from 'node:fs';
import {expect} from 'vitest';
import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginManifest,
  createRuntimePluginProvidedTool,
  runtimePluginContractVersion,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import {
  createRuntimePluginHost,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginHost,
} from '../../src/plugins/host/index.ts';
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginFileStore,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginToolCallResult,
} from '../../src/plugins/api/index.ts';
import {
  createRuntimePluginFileStore,
  type RuntimePluginFileStoreProvider,
} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {createRuntimePluginConfigControlCapability} from '../../src/runtime/config/index.ts';

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
};

export type LateFileStoreWriteOutcome =
  'blocked' | 'missing_file_store' | 'written';

export type TurnContextCapture = {
  beforeCurrentUserMessage?: string;
  afterCurrentUserMessage?: string;
  visibleMessageIds?: readonly string[];
  visibleMessages?: readonly {readonly text: string}[];
};

export type TestRuntimePluginHostOptions = Omit<
  CreateRuntimePluginHostOptions,
  'plugins'
> & {
  readonly plugins: readonly RuntimePlugin[];
};

/** Real engine wired the way the composition root does in production. */
export const testRuntimePluginFileStoreProvider: RuntimePluginFileStoreProvider =
  Object.freeze({
    createFileStore: createRuntimePluginFileStore,
  });

/** Real config-control capability wired the way the composition root does. */
export const testRuntimePluginConfigControlCapability =
  createRuntimePluginConfigControlCapability();

export function createExplicitlyEnabledRuntimePluginHost(
  options: TestRuntimePluginHostOptions,
): RuntimePluginHost {
  return createRuntimePluginHost({
    fileStore: testRuntimePluginFileStoreProvider,
    ...options,
    enabledPluginIds: options.enabledPluginIds ?? [
      runtimePluginId,
      ...options.plugins.map(plugin => plugin.manifest.id),
    ],
  });
}

export function pluginDiscoveryToolNames(
  output: RuntimePluginJsonValue,
): readonly string[] {
  return Object.freeze(
    pluginDiscoveryPluginSummaries(output)
      .flatMap(plugin => {
        const tools = plugin['providedTools'];

        if (!isRuntimePluginJsonArray(tools)) {
          throw new TypeError('Expected plugin discovery tools array.');
        }

        return tools.map(tool => {
          if (
            !isRuntimePluginJsonObject(tool) ||
            typeof tool['name'] !== 'string'
          ) {
            throw new TypeError('Expected plugin discovery tool name.');
          }

          return tool['name'];
        });
      })
      .sort((left, right) => left.localeCompare(right)),
  );
}

export function pluginDiscoveryPluginSummaries(
  output: RuntimePluginJsonValue,
): readonly RuntimePluginJsonObject[] {
  if (!isRuntimePluginJsonObject(output)) {
    throw new TypeError('Expected plugin discovery output object.');
  }

  const plugins = output['plugins'];

  if (!isRuntimePluginJsonArray(plugins)) {
    throw new TypeError('Expected plugin discovery output plugins array.');
  }

  return Object.freeze(
    plugins.map(plugin => {
      if (!isRuntimePluginJsonObject(plugin)) {
        throw new TypeError('Expected plugin discovery plugin object.');
      }

      return plugin;
    }),
  );
}

export function isRuntimePluginJsonObject(
  value: RuntimePluginJsonValue,
): value is RuntimePluginJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRuntimePluginJsonArray(
  value: RuntimePluginJsonValue | undefined,
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}

export function createMemorySearchPlugin(
  id = 'memory.search.fixture',
  fails = false,
  failureMessage = 'search backend failed',
  onHandle?: () => void,
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle?.();

        if (fails) {
          throw new Error(failureMessage);
        }

        const query = call.input['query'];
        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId: id,
          query,
          context,
        });
      },
    },
  });
}

export function createMemorySearchPluginWithInvocationProbe(
  onHandle: () => void,
): RuntimePlugin {
  return createMemorySearchPlugin(
    'memory.identity-probe.fixture',
    false,
    'search backend failed',
    onHandle,
  );
}

export function createTurnContextCapturePlugin(options: {
  readonly pluginId: string;
  readonly requestedAccess: RuntimePlugin['manifest']['requestedAccess'];
  readonly capture: TurnContextCapture;
}): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(options.pluginId),
      declaredPlugins: ['before_role_model_call', 'after_turn_committed'],
      requestedAccess: options.requestedAccess,
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        options.capture.beforeCurrentUserMessage = context.currentUserMessage;

        return {
          contextItems: [],
          evidence: [],
        };
      },
      afterTurnCommitted(context) {
        options.capture.afterCurrentUserMessage = context.currentUserMessage;
        options.capture.visibleMessageIds =
          context.committedTurn.visibleMessageIds;
        options.capture.visibleMessages = context.committedTurn.visibleMessages;

        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}

export function createRuntimeNotesWithoutModelInputPlugin(): RuntimePlugin {
  const pluginId = 'memory.notes-no-model-input.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call'],
      requestedAccess: {},
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall() {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId,
              id: 'undeclared-model-input',
              kind: 'runtime_note',
              text: 'undeclared model input note',
              budget: {estimatedTokens: 6, priority: 50},
              sourceReferences: [],
              redactionLabels: [],
            }),
          ],
          evidence: [],
        };
      },
    },
  });
}

export function createModelFacingToolWithoutModelInputPlugin(
  onHandle: () => void,
): RuntimePlugin {
  const pluginId = 'memory.tool-no-model-input.fixture';

  return Object.freeze({
    manifest: createRuntimePluginManifest({
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: {},
    }),
    providedTools: Object.freeze(
      memorySearchProvidedTools().map(createRuntimePluginProvidedTool),
    ),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle();
        const query = call.input['query'];

        return createAcceptedMemorySearchResult({
          pluginId,
          query: typeof query === 'string' ? query : '',
          context,
        });
      },
    },
  } satisfies RuntimePlugin);
}

export function createDegradableMemorySearchPlugin(
  onHandle: () => void,
): RuntimePlugin {
  const id = 'memory.degradable.fixture';
  const manifest = memorySearchPluginManifest(id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        failureBehavior: {
          ...manifest.runtimePolicy.failureBehavior,
          handleToolCall: 'degrade',
        },
      },
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        onHandle();
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId: id,
          query,
          context,
        });
      },
    },
  });
}

export function createCredentialKeyOutputPlugin(): RuntimePlugin {
  const id = 'memory.credential-key-output.fixture';

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'accepted',
          output: {
            api_key: 'super-secret',
            nested: {
              password: 'open-sesame',
              safe: 'kept',
            },
            list: [
              {
                access_token: 'secret-token',
                label: 'kept',
              },
            ],
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Search completed.',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createProtoKeyOutputPlugin(): RuntimePlugin {
  const id = 'memory.proto-output.fixture';

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'accepted',
          output: createProtoKeyOutput(),
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Search completed.',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createProtoKeyOutput(): RuntimePluginJsonObject {
  const nested: Record<string, RuntimePluginJsonValue> = {};
  Object.defineProperty(nested, '__proto__', {
    value: 'nested-value',
    enumerable: true,
  });

  const output: Record<string, RuntimePluginJsonValue> = {
    nested,
  };
  Object.defineProperty(output, '__proto__', {
    value: {
      polluted: true,
    },
    enumerable: true,
  });

  return output;
}

export function createRejectingMemorySearchPlugin(
  options: {
    readonly id?: string;
    readonly handleToolCallFailure?: 'reject_tool_call' | 'degrade';
    readonly rejectionReason?: string;
    readonly rejectionMessage?: string;
  } = {},
): RuntimePlugin {
  const id = options.id ?? 'memory.rejecting.fixture';
  const manifest = memorySearchPluginManifest(id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        failureBehavior: {
          ...manifest.runtimePolicy.failureBehavior,
          handleToolCall:
            options.handleToolCallFailure ??
            manifest.runtimePolicy.failureBehavior.handleToolCall,
        },
      },
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'rejected',
          reason: options.rejectionReason ?? 'handler_rejected',
          message:
            options.rejectionMessage ??
            'lookup failed credential="open-sesame" https://user:pass@example.test/?token=abc',
          evidence: [],
        };
      },
    },
  });
}

export function createDegradedRejectingMemorySearchPlugin(): RuntimePlugin {
  const id = 'memory.rejecting.optional-degraded.fixture';

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'rejected',
          reason: 'handler_rejected',
          message: 'search backend degraded',
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: 'degraded',
              summary: 'search backend degraded',
              policyOutcome: 'optional_degraded',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createAcceptedBlockingEvidenceMemorySearchPlugin(
  evidenceStatus: 'rejected' | 'failed',
): RuntimePlugin {
  const id = `memory.accepted-blocking.${evidenceStatus}.fixture`;

  return createRuntimePlugin({
    manifest: memorySearchPluginManifest(id),
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return {
          status: 'accepted',
          output: {
            matched: query,
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: evidenceStatus,
              summary: 'Search did not complete.',
              policyOutcome:
                evidenceStatus === 'failed' ? 'timeout' : 'handler_rejected',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createSourceRequiredMemorySearchPlugin(options: {
  readonly id: string;
  readonly evidenceKinds: readonly ('policy' | 'health' | 'tool_invocation')[];
  readonly handleToolCallFailure?: 'reject_tool_call' | 'degrade';
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        failureBehavior: {
          ...manifest.runtimePolicy.failureBehavior,
          handleToolCall:
            options.handleToolCallFailure ??
            manifest.runtimePolicy.failureBehavior.handleToolCall,
        },
      },
    },
    providedTools: memorySearchProvidedTools().map(tool =>
      Object.freeze({
        ...tool,
        sourceReferencesRequired: true,
      }),
    ),
    lifecycleHooks: {
      handleToolCall(call, context) {
        const query = call.input['query'];

        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return {
          status: 'accepted',
          output: {
            matched: query,
          },
          evidence: options.evidenceKinds.map(evidenceKind =>
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.id,
              evidenceKind,
              status: 'accepted',
              summary: `${evidenceKind} evidence.`,
              sourceReferences: [
                {
                  kind: 'memory',
                  id: `source.${evidenceKind}`,
                  title: `${evidenceKind} source`,
                },
              ],
              redactionLabels: [],
            }),
          ),
        };
      },
    },
  });
}

export function createAcceptedMemorySearchResult(options: {
  readonly pluginId: string;
  readonly query: string;
  readonly context: RuntimePluginContext;
}): RuntimePluginToolCallResult {
  return {
    status: 'accepted',
    output: {
      matched: options.query,
    },
    evidence: [
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.pluginId,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: 'Search completed.',
        redactionLabels: [],
      }),
    ],
  };
}

export function createMemorySearchToolProviderOnlyPlugin(): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest('memory.tool-provider-only.fixture'),
      declaredPlugins: ['tool_provider'],
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {},
  });
}

export function createRuntimeNotesPlugin(): RuntimePlugin {
  const pluginId = 'memory.notes.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call'],
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [],
          runtimeNotes: [
            `${'large note '.repeat(140)}api_key=super-secret`,
            'short note',
          ],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Notes loaded.',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createBoundedHookRecordsPlugin(options: {
  readonly id: string;
  readonly contextItemCount: number;
  readonly evidenceCount: number;
}): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(options.id),
      declaredPlugins: ['before_role_model_call'],
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: Array.from(
            {length: options.contextItemCount},
            (_value, index) =>
              createRuntimePluginContextItem({
                pluginId: options.id,
                id: `context-${String(index)}`,
                kind: 'memory',
                text: 'x',
                budget: {estimatedTokens: 1, priority: 1},
                sourceReferences: [],
                redactionLabels: [],
              }),
          ),
          evidence: Array.from({length: options.evidenceCount}, () =>
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.id,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'bounded evidence',
              redactionLabels: [],
            }),
          ),
        };
      },
    },
  });
}

export function createSlowNormalizationPlugin(): RuntimePlugin {
  const id = 'memory.slow-normalization.fixture';
  const manifest = memorySearchPluginManifest(id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      declaredPlugins: ['before_role_model_call'],
      runtimePolicy: {
        ...manifest.runtimePolicy,
        timeoutMs: 1,
      },
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall() {
        return {
          get contextItems() {
            const deadline = Date.now() + 10;
            while (Date.now() < deadline) {
              // Deliberately occupy normalization to prove the deadline covers it.
            }
            return [];
          },
          evidence: [],
        };
      },
    },
  });
}

export function createSourceRequiredRuntimeNotesPlugin(options: {
  readonly id: string;
  readonly requiredForTurn?: boolean;
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      declaredPlugins: ['before_role_model_call'],
      runtimePolicy: {
        ...manifest.runtimePolicy,
        requiredForTurn: options.requiredForTurn ?? false,
        sourceReferencesRequired: true,
      },
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: options.id,
              id: 'unsourced-note',
              kind: 'runtime_note',
              text: 'unsourced runtime note',
              budget: {estimatedTokens: 5, priority: 50},
              sourceReferences: [],
              redactionLabels: [],
            }),
          ],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.id,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Loaded runtime note.',
              sourceReferences: [
                {
                  kind: 'memory',
                  id: 'source.before_role_model_call',
                },
              ],
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createAcceptedBlockingBeforeRoleModelCallPlugin(options: {
  readonly id: string;
  readonly requiredForTurn?: boolean;
  readonly evidenceStatus: 'rejected' | 'failed';
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.id);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      declaredPlugins: ['before_role_model_call'],
      runtimePolicy: {
        ...manifest.runtimePolicy,
        requiredForTurn: options.requiredForTurn ?? false,
      },
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: options.id,
              id: 'blocked-context',
              kind: 'memory',
              text: 'blocked context',
              budget: {
                estimatedTokens: 1,
                priority: 1,
              },
              sourceReferences: [],
              redactionLabels: context.privacy.redactionLabels,
            }),
          ],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.id,
              evidenceKind: 'before_role_model_call',
              status: options.evidenceStatus,
              summary: 'Before-role-model context blocked.',
              policyOutcome:
                options.evidenceStatus === 'failed'
                  ? 'timeout'
                  : options.requiredForTurn === true
                    ? 'required_rejected'
                    : 'handler_rejected',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createUnderestimatedContextItemPlugin(): RuntimePlugin {
  const pluginId = 'memory.underestimated-context.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call'],
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId,
              id: 'oversized-context',
              kind: 'memory',
              text: 'oversized context '.repeat(160),
              budget: {
                estimatedTokens: 1,
                priority: 1,
              },
              sourceReferences: [],
              redactionLabels: context.privacy.redactionLabels,
            }),
          ],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Loaded oversized context item.',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createLowPriorityBudgetPressurePlugin(): RuntimePlugin {
  const pluginId = 'memory.low-priority-budget-pressure.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call'],
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId,
              id: 'low-priority-bulk',
              kind: 'memory',
              text: 'low '.repeat(254),
              budget: {
                estimatedTokens: 254,
                priority: 1,
              },
              sourceReferences: [],
              redactionLabels: context.privacy.redactionLabels,
            }),
            createRuntimePluginContextItem({
              pluginId,
              id: 'runtime-note-host',
              kind: 'runtime_note',
              text: 'runtime note from host',
              budget: {
                estimatedTokens: 6,
                priority: 100,
              },
              sourceReferences: [],
              redactionLabels: context.privacy.redactionLabels,
            }),
          ],
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Loaded low-priority budget pressure context.',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createRetainedBeforeRoleModelFileStorePlugin(
  retainFileStore: (fileStore: RuntimePluginFileStore) => void,
): RuntimePlugin {
  const pluginId = 'memory.retained-before.fixture';
  const manifest = memorySearchPluginManifest(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
      },
      declaredPlugins: ['before_role_model_call'],
      requestedAccess: {file_store: 'write'},
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        writeDuringHookAndRetainFileStore({
          context,
          path: 'during-before.json',
          retainFileStore,
        });

        return {
          contextItems: [],
          evidence: [],
        };
      },
    },
  });
}

export function createReadOnlyFileStoreProbePlugin(): RuntimePlugin {
  const pluginId = 'memory.read-only-file-store.fixture';

  // Genuinely read-only: the granted access is what withholds writes.
  // This fixture used to request write access and rely on a declared
  // effect level to be refused anyway — two systems answering one
  // question, which is the overlap the annotations model retired.
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: {file_store: 'read', model_input: 'write'},
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        if (context.fileStore === undefined) {
          throw new Error(
            'Expected read-only tool context to include fileStore.',
          );
        }

        const seed = context.fileStore.readJson('seed.json');
        if (seed === undefined) {
          throw new Error('Expected seeded fileStore value.');
        }
        let writeBlocked = false;

        try {
          context.fileStore.writeJsonAtomic('read-only-write.json', {
            value: 'blocked',
          });
        } catch {
          writeBlocked = true;
        }

        return {
          status: 'accepted',
          output: {
            seed,
            writeBlocked,
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Read-only fileStore probe completed.',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createReadOnlyBeforeRoleModelFileStoreProbePlugin(): RuntimePlugin {
  const pluginId = 'memory.read-only-before-file-store.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      declaredPlugins: ['before_role_model_call'],
      requestedAccess: {file_store: 'read', model_input: 'write'},
    },
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        if (context.fileStore === undefined) {
          throw new Error(
            'Expected read-only hook context to include fileStore.',
          );
        }

        const seed = context.fileStore.readJson('seed.json');
        if (seed === undefined) {
          throw new Error('Expected seeded fileStore value.');
        }
        let writeBlocked = false;

        try {
          context.fileStore.writeJsonAtomic('read-only-hook-write.json', {
            value: 'blocked',
          });
        } catch {
          writeBlocked = true;
        }

        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId,
              id: 'read-only-probe',
              kind: 'runtime_note',
              text: JSON.stringify({seed, writeBlocked}),
              budget: {estimatedTokens: 16, priority: 50},
              sourceReferences: [],
              redactionLabels: [],
            }),
          ],
          evidence: [],
        };
      },
    },
  });
}

export function createRetainedHandleToolCallFileStorePlugin(
  retainFileStore: (fileStore: RuntimePluginFileStore) => void,
): RuntimePlugin {
  const pluginId = 'memory.retained-handle.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: {file_store: 'write', model_input: 'write'},
    },
    providedTools: localMemoryWriteSearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        writeDuringHookAndRetainFileStore({
          context,
          path: 'during-handle.json',
          retainFileStore,
        });

        const query = call.input['query'];
        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return createAcceptedMemorySearchResult({
          pluginId,
          query,
          context,
        });
      },
    },
  });
}

export function createStagedAppendFileStorePlugin(): RuntimePlugin {
  const pluginId = 'memory.staged-append.fixture';

  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest(pluginId),
      requestedAccess: {file_store: 'write', model_input: 'write'},
    },
    providedTools: localMemoryWriteSearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(call, context) {
        if (context.fileStore === undefined) {
          throw new Error(
            'Expected staged append fixture to receive fileStore.',
          );
        }

        const query = call.input['query'];
        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        context.fileStore.appendJsonl('events.jsonl', {
          value: query,
          traceId: context.traceId,
        });

        return createAcceptedMemorySearchResult({
          pluginId,
          query,
          context,
        });
      },
    },
  });
}

export function createRetainedHealthFileStorePlugin(
  retainFileStore: (fileStore: RuntimePluginFileStore) => void,
): RuntimePlugin {
  const pluginId = 'memory.retained-health.fixture';
  const manifest = memorySearchPluginManifest(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
      },
      declaredPlugins: ['health'],
      requestedAccess: {file_store: 'write'},
    },
    providedTools: [],
    lifecycleHooks: {
      health(context) {
        writeDuringHookAndRetainFileStore({
          context,
          path: 'during-health.json',
          retainFileStore,
        });

        return createRuntimePluginHealthSnapshot({
          pluginId,
          status: 'ok',
          checkedAt: context.timestamp,
          summary: 'Health check completed.',
          redactionLabels: [],
        });
      },
    },
  });
}

export function writeDuringHookAndRetainFileStore(options: {
  readonly context: RuntimePluginContext;
  readonly path: string;
  readonly retainFileStore: (fileStore: RuntimePluginFileStore) => void;
}): void {
  if (options.context.fileStore === undefined) {
    throw new Error('Expected plugin hook context to include fileStore.');
  }

  options.context.fileStore.writeJsonAtomic(options.path, {
    value: 'during',
  });
  options.retainFileStore(options.context.fileStore);
}

export function expectRetainedFileStoreWriteBlocked(
  fileStore: RuntimePluginFileStore | undefined,
  path: string,
): void {
  if (fileStore === undefined) {
    throw new Error('Expected retained fileStore.');
  }

  expect(() => {
    fileStore.writeJsonAtomic(path, {
      value: 'after',
    });
  }).toThrow(/after hook completion/iu);
}

export function createPluginHostTestFileStore(options: {
  readonly pluginId: string;
  readonly sessionIdentity: object;
}): RuntimePluginFileStore {
  return createRuntimePluginFileStore({
    sessionId: 'session-plugin-host',
    sessionIdentity: options.sessionIdentity,
    pluginId: options.pluginId,
  });
}

export function createLateFileStoreWritePlugin(options: {
  readonly continueAfterTimeout: Promise<null>;
  readonly recordLateWriteOutcome: (outcome: LateFileStoreWriteOutcome) => void;
  readonly recordExecutionScope?: (scope: {
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }) => void;
}): RuntimePlugin {
  const pluginId = 'memory.late-file-store-write.fixture';
  const manifest = memorySearchPluginManifest(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        timeoutMs: 5,
      },
      requestedAccess: {file_store: 'write', model_input: 'write'},
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      async handleToolCall(_call, context) {
        options.recordExecutionScope?.({
          deadlineAt: context.deadlineAt,
          signal: context.signal,
        });
        await options.continueAfterTimeout;

        if (context.fileStore === undefined) {
          options.recordLateWriteOutcome('missing_file_store');
          return createAcceptedMemorySearchResult({
            pluginId,
            query: 'missing-file-store',
            context,
          });
        }

        try {
          context.fileStore.writeJsonAtomic('late-write.json', {
            value: 'late',
          });
          options.recordLateWriteOutcome('written');
        } catch {
          options.recordLateWriteOutcome('blocked');
        }

        return createAcceptedMemorySearchResult({
          pluginId,
          query: 'late-write',
          context,
        });
      },
    },
  });
}

export function createMemorySearchPluginWithoutHandlerDeclaration(): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      ...memorySearchPluginManifest('memory.handler-mismatch.fixture'),
      declaredPlugins: ['tool_provider'],
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall() {
        throw new Error('Handler should not run for invalid plugin fixture.');
      },
    },
  });
}

export async function callFileStoreAvailabilityProbe(
  host: RuntimePluginHost,
  plugin: RuntimePlugin,
  context: RuntimePluginContext = testPluginContext(),
): Promise<RuntimePluginToolCallResult> {
  return await host.handleToolCall(
    {
      ...testIdentity(),
      pluginId: plugin.manifest.id,
      toolName: 'memory.search',
      input: {
        query: 'Mira',
      },
    },
    context,
  );
}

export function createFileStoreAvailabilityProbePlugin(options: {
  readonly pluginId: string;
  readonly requestedAccess: RuntimePlugin['manifest']['requestedAccess'];
  readonly localTrustLevel?: RuntimePlugin['manifest']['localTrustLevel'];
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      localTrustLevel: options.localTrustLevel ?? manifest.localTrustLevel,
      requestedAccess: options.requestedAccess,
    },
    providedTools: memorySearchProvidedTools(),
    lifecycleHooks: {
      handleToolCall(_call, context) {
        return {
          status: 'accepted',
          output: {
            fileStoreAvailable: context.fileStore !== undefined,
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: options.pluginId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'File store availability probe completed.',
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

export function createSessionEndFileStoreProbePlugin(options: {
  readonly pluginId: string;
  readonly requestedAccess: RuntimePlugin['manifest']['requestedAccess'];
  readonly onSessionEnd: (context: RuntimePluginContext) => void;
}): RuntimePlugin {
  const manifest = memorySearchPluginManifest(options.pluginId);

  return createRuntimePlugin({
    manifest: {
      ...manifest,
      declaredPlugins: ['on_session_end'],
      runtimePolicy: {
        ...manifest.runtimePolicy,
      },
      requestedAccess: options.requestedAccess,
    },
    providedTools: [],
    lifecycleHooks: {
      onSessionEnd(context) {
        options.onSessionEnd(context);

        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}

export function memorySearchPluginManifest(id: string) {
  return {
    id,
    displayName: 'Memory Search Fixture',
    version: '1.0.0',
    kind: 'memory_provider',
    description: 'Test plugin.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test',
    },
    declaredPlugins: ['tool_provider', 'handle_tool_call'],
    config: {
      scope: 'global_with_character_overrides',
      fields: [],
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: {
      requiredForTurn: false,
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: false,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        afterTurnCommitted: 'log_failure',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: true,
      reasons: ['test'],
    },
    requestedAccess: {model_input: 'write'},
  };
}

export function memorySearchProvidedTools() {
  return [
    {
      name: 'memory.search',
      description: 'Search memory.',
      requiredForUserTurn: false,
      callLimit: {
        scope: 'user_turn',
        maxCalls: 1,
      },
      inputContract: {
        type: 'object',
        fields: [
          {
            name: 'query',
            description: 'Search query.',
            required: true,
          },
        ],
        additionalFields: false,
      },
      validationOwner: 'plugin_host',
      requiresConfirmation: false,
      sourceReferencesRequired: false,
    },
  ];
}

export function localMemoryWriteSearchProvidedTools() {
  return memorySearchProvidedTools().map(tool =>
    Object.freeze({
      ...tool,
      sideEffectLevel: 'local_memory_write' as const,
    }),
  );
}

export function testPluginContext(
  identity: {
    readonly eventId?: string;
    readonly traceId?: string;
    readonly createdAt?: string;
  } = {},
) {
  return createRuntimePluginContext({
    ...testIdentity(identity),
    sessionId: 'session-plugin-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: testCharacterProfile,
  });
}

export function testPluginAfterTurnCommittedContext(
  identity: {
    readonly eventId?: string;
    readonly traceId?: string;
  } = {},
) {
  return createRuntimePluginAfterTurnCommittedContext({
    ...testIdentity(identity),
    sessionId: 'session-plugin-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: testCharacterProfile,
    committedAt: '2026-06-15T00:00:00.000Z',
    visibleMessages: [],
  });
}

export function testIdentity(
  options: {
    readonly eventId?: string;
    readonly traceId?: string;
    readonly createdAt?: string;
  } = {},
) {
  return createRuntimeEventIdentity({
    eventId: options.eventId ?? 'evt_plugin_host',
    traceId: options.traceId ?? 'trace_plugin_host',
    createdAt: options.createdAt ?? '2026-06-15T00:00:00.000Z',
  });
}

export function readAgentCapabilityFixture(fileName: string): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL(`../fixtures/agent-capabilities/${fileName}`, import.meta.url),
      'utf8',
    ),
  );

  return parsed;
}

export function expectJsonObject(
  value: RuntimePluginJsonValue | undefined,
): RuntimePluginJsonObject {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    isJsonArray(value)
  ) {
    throw new Error('Expected JSON object.');
  }

  return value;
}

export function isJsonArray(
  value: RuntimePluginJsonValue,
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}

export function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] | undefined;
  const promise = new Promise<T>(resolveValue => {
    resolve = resolveValue;
  });

  if (resolve === undefined) {
    throw new Error('Expected deferred promise resolver to be initialized.');
  }

  return Object.freeze({
    promise,
    resolve,
  });
}
