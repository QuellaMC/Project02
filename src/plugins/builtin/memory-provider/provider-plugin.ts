import {createRuntimePlugin} from '../../api/constructors.ts';
import {
  runtimePluginContractVersion,
  type RuntimePluginAccessMap,
  type RuntimePluginDeclaration,
} from '../../api/contract.ts';
import type {
  RuntimePlugin,
  RuntimePluginProvidedTool,
} from '../../api/types.ts';
import {createMemoryProviderLifecycleHooks} from './provider-lifecycle.ts';
import {memoryAddTool, memorySearchTool} from './tools.ts';
import type {Project02MemoryProvider} from './types.ts';

export type CreateMemoryProviderRuntimePluginOptions = {
  readonly pluginId?: string;
  readonly version?: string;
  readonly toolNamespace?: string;
};

export function createMemoryProviderRuntimePlugin(
  provider: Project02MemoryProvider,
  options: CreateMemoryProviderRuntimePluginOptions = {},
): RuntimePlugin {
  const pluginId = options.pluginId ?? provider.id;
  const toolNamespace = options.toolNamespace ?? 'memory';
  const searchToolName = `${toolNamespace}.search`;
  const addToolName = `${toolNamespace}.add`;
  const canWriteMemory =
    provider.add !== undefined || provider.captureTurn !== undefined;

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
        externalContract: 'project02_memory_provider',
      },
      declaredPlugins: memoryProviderDeclarations(provider),
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
      },
      localTrustLevel: 'trusted_adapter',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: canWriteMemory ? 'local_memory_write' : 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1500,
        sourceReferencesRequired: true,
        redactionLabels: ['memory'],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: ['memory_provider_factory'],
      },
      requestedAccess: memoryProviderRequestedAccess(provider),
    },
    providedTools: memoryProviderTools({
      provider,
      searchToolName,
      addToolName,
    }),
    lifecycleHooks: createMemoryProviderLifecycleHooks({
      provider,
      pluginId,
      searchToolName,
      addToolName,
    }),
  });
}

function memoryProviderDeclarations(
  provider: Project02MemoryProvider,
): readonly RuntimePluginDeclaration[] {
  const declarations: RuntimePluginDeclaration[] = ['plugin_discovery'];

  if (provider.recall !== undefined)
    declarations.push('before_role_model_call');
  if (provider.captureTurn !== undefined)
    declarations.push('after_turn_committed');
  if (provider.search !== undefined || provider.add !== undefined) {
    declarations.push('tool_provider', 'handle_tool_call');
  }
  if (provider.health !== undefined) declarations.push('health');
  if (provider.endSession !== undefined) declarations.push('on_session_end');
  if (provider.close !== undefined) declarations.push('on_shutdown');

  return Object.freeze(declarations);
}

function memoryProviderTools(options: {
  readonly provider: Project02MemoryProvider;
  readonly searchToolName: string;
  readonly addToolName: string;
}): readonly RuntimePluginProvidedTool[] {
  const tools: RuntimePluginProvidedTool[] = [];

  if (options.provider.search !== undefined) {
    tools.push(memorySearchTool(options.searchToolName));
  }
  if (options.provider.add !== undefined) {
    tools.push(memoryAddTool(options.addToolName));
  }

  return Object.freeze(tools);
}

function memoryProviderRequestedAccess(
  provider: Project02MemoryProvider,
): RuntimePluginAccessMap {
  return Object.freeze({
    ...(provider.recall === undefined && provider.captureTurn === undefined
      ? {}
      : {turn_context: 'read'}),
    ...(provider.recall === undefined &&
    provider.search === undefined &&
    provider.add === undefined
      ? {}
      : {model_input: 'write'}),
  } satisfies RuntimePluginAccessMap);
}
