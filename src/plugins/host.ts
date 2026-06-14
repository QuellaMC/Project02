import {
  createAgentCapabilityProvidedTool,
  type AgentCapabilityEvidenceSnapshot,
  type AgentCapabilityToolCall,
  type AgentCapabilityToolCallResult,
  type RuntimeCapabilityAfterTurnCommittedContext,
  type RuntimeCapabilityContext
} from '../agent-capabilities.ts';
import type {
  RuntimeCapabilityBeforeRoleModelCallCompletedResult,
  RuntimeCapabilityBeforeRoleModelCallHostResult,
  RuntimeCapabilityHealthHostResult,
  RuntimeCapabilityHookHostResult,
  RuntimeCapabilityHost
} from '../agent-capability-host.ts';
import { isBuiltInModelToolName } from '../model-tools.ts';
import {
  createRoleModelCapabilityToolDefinitions,
  type RoleModelCapabilityToolDefinition
} from '../role-model-contracts.ts';
import { createCharacterStatePlugin } from './builtin/character-state.ts';
import { createRuntimePluginFileStore } from './file-store.ts';
import type { RuntimePlugin, RuntimePluginToolContext } from './types.ts';

export type CreateRuntimePluginHostOptions = {
  readonly plugins?: readonly RuntimePlugin[];
  readonly capabilityHost?: RuntimeCapabilityHost;
  readonly storeRoot?: string;
  readonly sessionId: string;
};

export type RuntimePluginHost = {
  capabilityToolDefinitions(): readonly RoleModelCapabilityToolDefinition[];
  resolveToolCapabilityId(toolName: string): string | undefined;
  beforeRoleModelCall(
    context: RuntimeCapabilityContext
  ): Promise<RuntimeCapabilityBeforeRoleModelCallHostResult>;
  handleToolCall(
    call: AgentCapabilityToolCall,
    context: RuntimeCapabilityContext
  ): Promise<AgentCapabilityToolCallResult>;
  afterTurnCommitted(
    context: RuntimeCapabilityAfterTurnCommittedContext
  ): Promise<RuntimeCapabilityHookHostResult>;
  health(context: RuntimeCapabilityContext): Promise<RuntimeCapabilityHealthHostResult>;
};

export function createDefaultProject02PluginHost(
  options: Omit<CreateRuntimePluginHostOptions, 'plugins'>
): RuntimePluginHost {
  return createRuntimePluginHost({
    ...options,
    plugins: [createCharacterStatePlugin()]
  });
}

export function createRuntimePluginHost(
  options: CreateRuntimePluginHostOptions
): RuntimePluginHost {
  const plugins = Object.freeze([...(options.plugins ?? [])]);
  const pluginById = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]));
  const toolPluginIds = new Map<string, string>();

  for (const plugin of plugins) {
    for (const tool of plugin.providedTools) {
      toolPluginIds.set(tool.name, plugin.manifest.id);
    }
  }

  const pluginToolDefinitions = createRoleModelCapabilityToolDefinitions(
    plugins.flatMap((plugin) =>
      plugin.providedTools
        .filter((tool) => !isBuiltInModelToolName(tool.name))
        .map((tool) => ({
          capabilityId: plugin.manifest.id,
          ...createAgentCapabilityProvidedTool(tool)
        }))
    )
  );

  return Object.freeze({
    capabilityToolDefinitions() {
      return Object.freeze([
        ...pluginToolDefinitions,
        ...(options.capabilityHost?.capabilityToolDefinitions() ?? [])
      ]);
    },
    resolveToolCapabilityId(toolName) {
      return (
        toolPluginIds.get(toolName) ??
        options.capabilityHost
          ?.capabilityToolDefinitions()
          .find((definition) => definition.name === toolName)
          ?.capabilityId
      );
    },
    async beforeRoleModelCall(context) {
      const pluginContextItems = [];
      const pluginRuntimeNotes = [];
      const pluginEvidence: AgentCapabilityEvidenceSnapshot[] = [];

      for (const plugin of plugins) {
        if (plugin.beforeRoleModelCall === undefined) {
          continue;
        }

        const result = await plugin.beforeRoleModelCall(
          createPluginContext({
            context,
            plugin,
            ...(options.storeRoot === undefined
              ? {}
              : { storeRoot: options.storeRoot }),
            sessionId: options.sessionId
          })
        );

        pluginContextItems.push(...result.contextItems);
        pluginRuntimeNotes.push(...result.runtimeNotes);
        pluginEvidence.push(...result.evidence);
      }

      const capabilityResult =
        options.capabilityHost === undefined
          ? createEmptyBeforeRoleModelCallResult()
          : await options.capabilityHost.beforeRoleModelCall(context);

      if (capabilityResult.status === 'rejected') {
        return capabilityResult;
      }

      return Object.freeze({
        status: 'completed',
        contextItems: Object.freeze([
          ...pluginContextItems,
          ...capabilityResult.contextItems
        ]),
        runtimeNotes: Object.freeze([
          ...pluginRuntimeNotes,
          ...capabilityResult.runtimeNotes
        ]),
        evidence: Object.freeze([
          ...pluginEvidence,
          ...capabilityResult.evidence
        ])
      } satisfies RuntimeCapabilityBeforeRoleModelCallCompletedResult);
    },
    async handleToolCall(call, context) {
      const plugin = pluginById.get(call.capabilityId);

      if (plugin !== undefined) {
        if (plugin.handleToolCall === undefined) {
          return createRejectedPluginToolResult({
            call,
            context,
            reason: 'handler_missing',
            message: `Plugin "${plugin.manifest.id}" has no handleToolCall handler.`
          });
        }

        return await plugin.handleToolCall(
          call,
          createPluginContext({
            context,
            plugin,
            ...(options.storeRoot === undefined
              ? {}
              : { storeRoot: options.storeRoot }),
            sessionId: options.sessionId
          })
        );
      }

      if (options.capabilityHost === undefined) {
        return createRejectedPluginToolResult({
          call,
          context,
          reason: 'tool_host_missing',
          message: `Tool "${call.toolName}" has no plugin or capability host.`
        });
      }

      return await options.capabilityHost.handleToolCall(call, context);
    },
    async afterTurnCommitted(context) {
      return options.capabilityHost === undefined
        ? createEmptyHookResult()
        : await options.capabilityHost.afterTurnCommitted(context);
    },
    async health(context) {
      return options.capabilityHost === undefined
        ? createEmptyHealthResult()
        : await options.capabilityHost.health(context);
    }
  } satisfies RuntimePluginHost);
}

function createPluginContext(options: {
  readonly context: RuntimeCapabilityContext;
  readonly plugin: RuntimePlugin;
  readonly storeRoot?: string;
  readonly sessionId: string;
}): RuntimePluginToolContext {
  const grantsFileStore = options.plugin.manifest.requestedApis.includes('file_store');

  return Object.freeze({
    ...options.context,
    pluginId: options.plugin.manifest.id,
    ...(grantsFileStore
      ? {
          fileStore: createRuntimePluginFileStore({
            ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
            sessionId: options.sessionId,
            pluginId: options.plugin.manifest.id
          })
        }
      : {})
  } satisfies RuntimePluginToolContext);
}

function createRejectedPluginToolResult(options: {
  readonly call: AgentCapabilityToolCall;
  readonly context: RuntimeCapabilityContext;
  readonly reason: string;
  readonly message: string;
}): AgentCapabilityToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: options.reason,
    message: options.message,
    evidence: Object.freeze([])
  } satisfies AgentCapabilityToolCallResult);
}

function createEmptyBeforeRoleModelCallResult(): RuntimeCapabilityBeforeRoleModelCallCompletedResult {
  return Object.freeze({
    status: 'completed',
    contextItems: Object.freeze([]),
    runtimeNotes: Object.freeze([]),
    evidence: Object.freeze([])
  } satisfies RuntimeCapabilityBeforeRoleModelCallCompletedResult);
}

function createEmptyHookResult(): RuntimeCapabilityHookHostResult {
  return Object.freeze({
    status: 'completed',
    evidence: Object.freeze([])
  } satisfies RuntimeCapabilityHookHostResult);
}

function createEmptyHealthResult(): RuntimeCapabilityHealthHostResult {
  return Object.freeze({
    snapshots: Object.freeze([]),
    evidence: Object.freeze([])
  } satisfies RuntimeCapabilityHealthHostResult);
}
