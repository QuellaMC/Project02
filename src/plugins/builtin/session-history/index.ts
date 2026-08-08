import {
  runtimePluginContractVersion,
  sessionHistoryPluginId,
  sessionHistoryReadToolName,
  sessionHistorySearchToolName,
} from '../../api/contract.ts';
import {createRuntimePlugin} from '../../api/constructors.ts';
import {createPluginToolEvidence} from '../../api/evidence-helpers.ts';
import {createRuntimePluginManifest} from '../../api/manifest-validation.ts';
import type {
  RuntimePlugin,
  RuntimePluginProvidedTool,
  RuntimePluginToolCallResult,
} from '../../api/types.ts';
import {createSessionHistoryGuidanceHook} from './context.ts';
import {
  createSessionHistoryReadTool,
  handleSessionHistoryReadToolCall,
} from './read.ts';
import {
  createSessionHistorySearchTool,
  handleSessionHistorySearchToolCall,
} from './search.ts';
import {
  createSessionIndexSnapshot,
  type LocalRuntimeSessionIndex,
} from './state.ts';

type CreateSessionHistoryPluginOptions = {
  readonly sessionIndex?: LocalRuntimeSessionIndex;
};

const sessionHistoryPluginInstances = new WeakSet<RuntimePlugin>();

export function createSessionHistoryPlugin(
  options: CreateSessionHistoryPluginOptions = {},
): RuntimePlugin {
  const sessionIndex =
    options.sessionIndex === undefined
      ? undefined
      : createSessionIndexSnapshot(options.sessionIndex);
  const providedTools: RuntimePluginProvidedTool[] = [];

  if (sessionIndex !== undefined) {
    providedTools.push(createSessionHistorySearchTool());
    providedTools.push(createSessionHistoryReadTool());
  }

  const plugin = createRuntimePlugin({
    manifest: createSessionHistoryPluginManifest(),
    providedTools,
    lifecycleHooks:
      sessionIndex === undefined
        ? {}
        : {
            beforeRoleModelCall: createSessionHistoryGuidanceHook(),
            handleToolCall(call, context) {
              if (context.character.id !== sessionIndex.characterId) {
                return {
                  status: 'rejected',
                  reason: 'character_scope_mismatch',
                  message:
                    `Session history is bound to character ` +
                    `"${sessionIndex.characterId}" but ` +
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
                    sessionIndex,
                  });
                }

                if (call.toolName === sessionHistoryReadToolName) {
                  return handleSessionHistoryReadToolCall({
                    call,
                    context,
                    sessionIndex,
                  });
                }
              } catch (error: unknown) {
                if (isLocalRuntimeStorageContractError(error)) {
                  return {
                    status: 'rejected',
                    reason:
                      error.code === 'missing_file'
                        ? 'session_not_found'
                        : error.code === 'invalid_session_id'
                          ? 'invalid_session_id'
                          : 'session_history_read_failed',
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
            onShutdown() {
              sessionIndex.close();
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
    requestedAccess: {model_input: 'write'},
  });
}

export function isSessionHistoryPlugin(plugin: RuntimePlugin): boolean {
  return sessionHistoryPluginInstances.has(plugin);
}

/** Structural check so the plugin needs no value import of the storage layer. */
function isLocalRuntimeStorageContractError(
  error: unknown,
): error is Error & {readonly code: string} {
  return (
    error instanceof Error &&
    error.name === 'LocalRuntimeStorageContractError' &&
    typeof (error as {readonly code?: unknown}).code === 'string'
  );
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

export type {LocalRuntimeSessionIndex} from './state.ts';
