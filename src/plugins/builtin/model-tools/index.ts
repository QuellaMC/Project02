import {builtInModelToolDefinitionsForUserTurn} from '../../../role-model/api/index.ts';
import {
  firstPartyModelToolsPluginId,
  runtimePluginContractVersion,
} from '../../api/contract.ts';
import {createRuntimePlugin} from '../../api/constructors.ts';
import {createRuntimePluginManifest} from '../../api/manifest-validation.ts';
import type {
  RuntimePlugin,
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
} from '../../api/types.ts';

const firstPartyModelToolsPluginInstances = new WeakSet<RuntimePlugin>();

const firstPartyModelToolsProvidedTools = Object.freeze(
  builtInModelToolDefinitionsForUserTurn().map(definition =>
    Object.freeze({
      name: definition.name,
      description: definition.description,
      inputContract: definition.inputContract,
      validationOwner: 'built_in_model_tools',
      concurrency: 'shared',
      requiresConfirmation: false,
    } satisfies RuntimePluginProvidedTool),
  ),
);

export function createFirstPartyModelToolsPlugin(): RuntimePlugin {
  const plugin = createRuntimePlugin({
    manifest: createFirstPartyModelToolsPluginManifest(),
    providedTools: firstPartyModelToolsProvidedTools,
    lifecycleHooks: {},
  });

  firstPartyModelToolsPluginInstances.add(plugin);
  return plugin;
}

export function createFirstPartyModelToolsPluginManifest(): RuntimePluginManifest {
  return createRuntimePluginManifest({
    id: firstPartyModelToolsPluginId,
    displayName: 'First-party model tools',
    version: '1.0.0',
    kind: 'first_party',
    description:
      'Represents the built-in visible_reply tool through the shared plugin contract.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
    },
    declaredPlugins: ['tool_provider'],
    config: {
      scope: 'global_with_character_overrides',
      fields: [],
    },
    firstParty: true,
    runtimePolicy: {
      timeoutMs: 1000,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'reject_turn',
        handleToolCall: 'reject_tool_call',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: true,
      reasons: ['built_in_user_turn_tools'],
    },
    requestedAccess: {model_input: 'write'},
  });
}

export function isFirstPartyModelToolsPlugin(plugin: RuntimePlugin): boolean {
  return firstPartyModelToolsPluginInstances.has(plugin);
}
