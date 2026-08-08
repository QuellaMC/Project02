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
  RuntimePluginDatabaseOpener,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginLifecycleHooks,
  RuntimePluginProvidedTool,
  RuntimePluginSessionHistoryFeed,
  RuntimePluginToolCallResult,
} from '../../api/index.ts';
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

type CreateSessionHistoryPluginOptions = {
  readonly sessionHistory?: RuntimePluginSessionHistoryFeed;
  readonly sessionHistoryDatabase?: RuntimePluginDatabaseOpener;
};

const sessionHistoryPluginInstances = new WeakSet<RuntimePlugin>();

export function createSessionHistoryPlugin(
  options: CreateSessionHistoryPluginOptions = {},
): RuntimePlugin {
  const engine =
    options.sessionHistory === undefined ||
    options.sessionHistoryDatabase === undefined
      ? undefined
      : createEngineFromCapabilities({
          sessionHistory: options.sessionHistory,
          sessionHistoryDatabase: options.sessionHistoryDatabase,
        });
  const providedTools: RuntimePluginProvidedTool[] = [];

  if (engine !== undefined) {
    providedTools.push(createSessionHistorySearchTool());
    providedTools.push(createSessionHistoryReadTool());
  }

  const plugin = createRuntimePlugin({
    manifest: createSessionHistoryPluginManifest(),
    providedTools,
    lifecycleHooks:
      engine === undefined ? {} : sessionHistoryLifecycleHooks(engine),
  });

  sessionHistoryPluginInstances.add(plugin);
  return plugin;
}

function createEngineFromCapabilities(capabilities: {
  readonly sessionHistory: RuntimePluginSessionHistoryFeed;
  readonly sessionHistoryDatabase: RuntimePluginDatabaseOpener;
}): SessionHistoryEngine {
  const snapshot = createSessionHistoryCapabilitiesSnapshot(capabilities);

  return createSessionHistoryEngine({
    feed: snapshot.sessionHistory,
    openDatabase: snapshot.sessionHistoryDatabase,
  });
}

function sessionHistoryLifecycleHooks(
  engine: SessionHistoryEngine,
): RuntimePluginLifecycleHooks {
  const guidanceHook = createSessionHistoryGuidanceHook();
  let warmUpKicked = false;

  return {
    beforeRoleModelCall(context) {
      if (!warmUpKicked) {
        // Advisory pre-warm on the first enabled turn; a real failure
        // resurfaces honestly on the first query instead.
        warmUpKicked = true;
        void engine.warmUp().catch(() => undefined);
      }

      return guidanceHook(context);
    },
    handleToolCall(call, context) {
      if (context.character.id !== engine.characterId) {
        return {
          status: 'rejected',
          reason: 'character_scope_mismatch',
          message:
            `Session history is bound to character ` +
            `"${engine.characterId}" but ` +
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
          return handleSessionHistorySearchToolCall({call, context, engine});
        }

        if (call.toolName === sessionHistoryReadToolName) {
          return handleSessionHistoryReadToolCall({call, context, engine});
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
      if (context.character.id !== engine.characterId) {
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
        await engine.warmUp({sessionId: context.sessionId});
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
      engine.close();
      return {status: 'completed', evidence: []};
    },
  };
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
      reasons: ['host_provided_session_history'],
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
