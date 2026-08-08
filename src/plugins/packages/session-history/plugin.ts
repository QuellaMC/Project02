import {
  sessionHistoryPluginId,
  sessionHistoryReadToolName,
  sessionHistorySearchToolName,
} from '../../api/contract.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
} from '../../api/constructors.ts';
import {createPluginToolEvidence} from '../../api/evidence-helpers.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import type {
  RuntimePlugin,
  RuntimePluginAfterTurnCommittedContext,
  RuntimePluginContext,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginToolCallResult,
} from '../../api/index.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {RuntimePluginManifest} from '../../api/types.ts';
import {createSessionHistoryGuidanceHook} from './context.ts';
import {
  createSessionHistoryEngine,
  SessionHistoryEngineError,
  type SessionHistoryEngine,
} from './engine/index.ts';
import {
  createSessionHistoryReadTool,
  handleSessionHistoryReadToolCall,
} from './read.ts';
import {
  createSessionHistorySearchTool,
  handleSessionHistorySearchToolCall,
} from './search.ts';
import {createSessionHistoryCapabilitiesSnapshot} from './state.ts';

const sessionHistoryPluginEntry = './index.ts';
const sessionHistoryPluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);
const sessionHistoryPluginInstances = new WeakSet<RuntimePlugin>();

export function createSessionHistoryPlugin(): RuntimePlugin {
  return createSessionHistoryPluginFromManifest(
    createSessionHistoryPluginManifest(),
  );
}

function createSessionHistoryPluginFromManifest(
  manifest: RuntimePluginManifest,
): RuntimePlugin {
  const guidanceHook = createSessionHistoryGuidanceHook();
  let engine: SessionHistoryEngine | undefined;
  let warmUpKicked = false;

  // The declared capabilities arrive on the hook context; the engine is
  // built once from the first context that carries both and lives for the
  // plugin instance so its database handle and warm-up survive turns.
  const engineForContext = (
    context: RuntimePluginContext,
  ): SessionHistoryEngine | undefined => {
    if (
      engine === undefined &&
      context.sessionHistory !== undefined &&
      context.pluginDatabase !== undefined
    ) {
      const snapshot = createSessionHistoryCapabilitiesSnapshot({
        sessionHistory: context.sessionHistory,
        sessionHistoryDatabase: context.pluginDatabase,
      });

      engine = createSessionHistoryEngine({
        feed: snapshot.sessionHistory,
        openDatabase: snapshot.sessionHistoryDatabase,
      });
    }

    return engine;
  };

  const plugin = createRuntimePlugin({
    manifest,
    providedTools: [
      createSessionHistorySearchTool(),
      createSessionHistoryReadTool(),
    ],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const activeEngine = engineForContext(context);

        if (activeEngine === undefined) {
          return {contextItems: [], evidence: []};
        }

        if (!warmUpKicked) {
          // Advisory pre-warm on the first enabled turn; a real failure
          // resurfaces honestly on the first query instead.
          warmUpKicked = true;
          void activeEngine.warmUp().catch(() => undefined);
        }

        return guidanceHook(context);
      },
      async handleToolCall(call, context) {
        const activeEngine = engineForContext(context);

        if (activeEngine === undefined) {
          return unavailableSessionHistoryTool(call.toolName);
        }

        if (context.character.id !== activeEngine.characterId) {
          return {
            status: 'rejected',
            reason: 'character_scope_mismatch',
            message:
              `Session history is bound to character ` +
              `"${activeEngine.characterId}" but ` +
              `"${context.character.id}" is active.`,
            evidence: [
              createPluginToolEvidence({
                context,
                pluginId: sessionHistoryPluginId,
                status: 'rejected',
                summary: 'Rejected a cross-character history request.',
              }),
            ],
          };
        }

        try {
          if (call.toolName === sessionHistorySearchToolName) {
            return await handleSessionHistorySearchToolCall({
              call,
              context,
              engine: activeEngine,
            });
          }

          if (call.toolName === sessionHistoryReadToolName) {
            return await handleSessionHistoryReadToolCall({
              call,
              context,
              engine: activeEngine,
            });
          }
        } catch (error: unknown) {
          const rejection = sessionHistoryRejection(error);

          if (rejection !== undefined) {
            return {
              status: 'rejected',
              reason: rejection.reason,
              message: rejection.message,
              evidence: [
                createPluginToolEvidence({
                  context,
                  pluginId: sessionHistoryPluginId,
                  status: 'rejected',
                  summary: 'Rejected a session-history request.',
                }),
              ],
            };
          }

          throw error;
        }

        return unavailableSessionHistoryTool(call.toolName);
      },
      async afterTurnCommitted(context) {
        const activeEngine = engineForContext(context);

        if (activeEngine === undefined) {
          return {status: 'completed', evidence: []};
        }

        if (context.character.id !== activeEngine.characterId) {
          return {
            status: 'completed',
            evidence: [
              afterTurnEvidence(
                context,
                'degraded',
                'Skipped indexing for a foreign character context.',
              ),
            ],
          };
        }

        try {
          await activeEngine.warmUp({sessionId: context.sessionId});
        } catch {
          // Advisory catch-up: the next query surfaces real failures.
          return {
            status: 'completed',
            evidence: [
              afterTurnEvidence(
                context,
                'degraded',
                'Session index catch-up failed; the next search retries.',
              ),
            ],
          };
        }

        return {
          status: 'completed',
          evidence: [
            afterTurnEvidence(
              context,
              'accepted',
              'Caught the session index up to the committed turn.',
            ),
          ],
        };
      },
      onShutdown() {
        engine?.close();
        return {status: 'completed', evidence: []};
      },
    },
  });

  sessionHistoryPluginInstances.add(plugin);
  return plugin;
}

export function createSessionHistoryPluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: sessionHistoryPluginDescriptorUrl,
    expectedEntry: sessionHistoryPluginEntry,
  }).manifest;
}

export function isSessionHistoryPlugin(plugin: RuntimePlugin): boolean {
  return sessionHistoryPluginInstances.has(plugin);
}

/**
 * Engine errors are the plugin's own; feed errors arrive from the runtime
 * and are recognized structurally so the plugin needs no value import of
 * the storage layer. Storage messages carry local file paths, so the
 * model-facing message is a fixed sentence; engine messages name only
 * session and message ids and pass through. Anything else is a bug and
 * propagates.
 */
function sessionHistoryRejection(
  error: unknown,
): {readonly reason: string; readonly message: string} | undefined {
  if (error instanceof SessionHistoryEngineError) {
    return {
      reason:
        error.code === 'engine_closed'
          ? 'session_history_read_failed'
          : error.code,
      message: error.message,
    };
  }

  if (
    error instanceof Error &&
    error.name === 'LocalRuntimeStorageContractError' &&
    typeof (error as {readonly code?: unknown}).code === 'string'
  ) {
    return {
      reason: 'session_history_read_failed',
      message:
        'Session history storage reported a read failure; the local ' +
        'runtime log has details.',
    };
  }

  return undefined;
}

function afterTurnEvidence(
  context: RuntimePluginAfterTurnCommittedContext,
  status: 'accepted' | 'degraded',
  summary: string,
): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: context.eventId,
    traceId: context.traceId,
    createdAt: context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: sessionHistoryPluginId,
    evidenceKind: 'after_turn_committed',
    status,
    summary,
    redactionLabels: context.privacy.redactionLabels,
  });
}

function unavailableSessionHistoryTool(
  toolName: string,
): RuntimePluginToolCallResult {
  return {
    status: 'rejected',
    reason: 'session_history_tool_unavailable',
    message: `Tool "${toolName}" is not available in this host.`,
    evidence: Object.freeze([]),
  };
}

export function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): RuntimePlugin {
  return createSessionHistoryPluginFromManifest(input.manifest);
}
