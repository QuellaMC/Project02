import {
  runtimePluginContractVersion,
  sessionHistoryPluginId,
  sessionHistoryReadToolName,
  sessionHistorySearchToolName,
} from '../../api/contract.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
} from '../../api/constructors.ts';
import {createPluginToolEvidence} from '../../api/evidence-helpers.ts';
import {createRuntimePluginManifest} from '../../api/manifest-validation.ts';
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
      handleToolCall(call, context) {
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
            return handleSessionHistorySearchToolCall({
              call,
              context,
              engine: activeEngine,
            });
          }

          if (call.toolName === sessionHistoryReadToolName) {
            return handleSessionHistoryReadToolCall({
              call,
              context,
              engine: activeEngine,
            });
          }
        } catch (error: unknown) {
          const reason = sessionHistoryRejectionReason(error);

          if (reason !== undefined && error instanceof Error) {
            return {
              status: 'rejected',
              reason,
              message: error.message,
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

export function createSessionHistoryPluginManifest() {
  return createRuntimePluginManifest({
    id: sessionHistoryPluginId,
    displayName: 'Session History',
    version: '1.0.0',
    kind: 'first_party',
    description:
      'Cross-session recall over this character’s own conversation ' +
      'history: full-text search with anchored context windows, and ' +
      'transcript scrolling by message anchor.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
    },
    declaredPlugins: [
      'tool_provider',
      'handle_tool_call',
      'before_role_model_call',
      'after_turn_committed',
      'on_shutdown',
    ],
    config: {
      scope: 'global_with_character_overrides',
      fields: [],
    },
    firstParty: true,
    runtimePolicy: {
      timeoutMs: 5_000,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: true,
      reasons: ['built_in_session_history'],
    },
    requestedAccess: {
      model_input: 'write',
      session_history: 'read',
      plugin_database: 'write',
    },
  });
}

export function isSessionHistoryPlugin(plugin: RuntimePlugin): boolean {
  return sessionHistoryPluginInstances.has(plugin);
}

/**
 * Engine errors are the plugin's own; feed errors arrive from the runtime
 * and are recognized structurally so the plugin needs no value import of
 * the storage layer. Anything else is a bug and propagates.
 */
function sessionHistoryRejectionReason(error: unknown): string | undefined {
  if (error instanceof SessionHistoryEngineError) {
    return error.code === 'engine_closed'
      ? 'session_history_read_failed'
      : error.code;
  }

  if (
    error instanceof Error &&
    error.name === 'LocalRuntimeStorageContractError' &&
    typeof (error as {readonly code?: unknown}).code === 'string'
  ) {
    return 'session_history_read_failed';
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
