import {
  createAgentCapabilityContextItem,
  type AgentCapabilityJsonObject
} from '../../agent-capabilities.ts';
import {
  characterStatePatchModelToolName,
  builtInModelToolDefinitionsForUserTurn
} from '../../model-tools.ts';
import {
  createDefaultCharacterRuntimeState,
  createLivingStateBrief,
  decodeCharacterRuntimeState,
  planCharacterStatePatch,
  type CharacterRuntimeState
} from '../../character-state.ts';
import { createPluginContextEvidence, createPluginToolEvidence } from '../evidence.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginFileStore,
  RuntimePluginToolContext
} from '../types.ts';

export const characterStatePluginId = 'character-state';

const characterStateEventsPath = 'events.jsonl';
const characterStateCurrentPath = 'current.json';

export function createCharacterStatePlugin(): RuntimePlugin {
  const characterStateTool = builtInModelToolDefinitionsForUserTurn().find(
    (definition) => definition.name === characterStatePatchModelToolName
  );

  if (characterStateTool === undefined) {
    throw new Error('character_state.patch built-in tool definition is missing.');
  }

  return Object.freeze({
    manifest: {
      id: characterStatePluginId,
      displayName: 'Character State',
      version: '1.0.0',
      requestedApis: ['file_store']
    },
    providedTools: [
      Object.freeze({
        name: characterStateTool.name,
        description: characterStateTool.description,
        requiredForUserTurn: characterStateTool.requiredForUserTurn,
        maxCallsPerUserTurn: characterStateTool.maxCallsPerUserTurn,
        inputContract: characterStateTool.inputContract,
        validationOwner: 'built_in_model_tools',
        sideEffectLevel: 'local_memory_write',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      })
    ],
    beforeRoleModelCall(context) {
      const state = readCurrentCharacterState(requiredFileStore(context));
      const brief = createLivingStateBrief(state);

      return Object.freeze({
        contextItems: [
          createAgentCapabilityContextItem({
            capabilityId: characterStatePluginId,
            id: 'current',
            kind: 'runtime_note',
            text: `Character State: ${brief.text}`,
            budget: {
              estimatedTokens: 32,
              priority: 90
            },
            sourceReferences: [],
            confidence: 1,
            redactionLabels: context.privacy.redactionLabels
          })
        ],
        runtimeNotes: [],
        evidence: [
          createPluginContextEvidence({
            context,
            pluginId: characterStatePluginId,
            status: 'accepted',
            summary: 'Provided current Character State context.'
          })
        ]
      } satisfies RuntimePluginBeforeRoleModelCallResult);
    },
    handleToolCall(call, context) {
      if (call.toolName !== characterStatePatchModelToolName) {
        return {
          status: 'rejected',
          reason: 'tool_not_declared',
          message: `Character State plugin does not handle "${call.toolName}".`,
          evidence: [
            createPluginToolEvidence({
              context,
              pluginId: characterStatePluginId,
              status: 'rejected',
              summary: `Rejected undeclared tool "${call.toolName}".`
            })
          ]
        };
      }

      const fileStore = requiredFileStore(context);
      const before = readCurrentCharacterState(fileStore);
      const result = planCharacterStatePatch({
        before,
        patchInput: call.input
      });

      if (result.status === 'rejected') {
        return {
          status: 'rejected',
          reason: result.rejection.reason,
          message: result.rejection.details,
          evidence: [
            createPluginToolEvidence({
              context,
              pluginId: characterStatePluginId,
              status: 'rejected',
              summary: result.rejection.details
            })
          ]
        };
      }

      const event = Object.freeze({
        type: 'character_state.patch',
        eventId: call.eventId,
        traceId: call.traceId,
        createdAt: call.createdAt,
        input: call.input,
        result
      } satisfies AgentCapabilityJsonObject);

      fileStore.appendJsonl(characterStateEventsPath, event);
      fileStore.writeJsonAtomic(characterStateCurrentPath, result.after);

      return {
        status: 'accepted',
        output: Object.freeze({
          status: 'accepted',
          current: result.after.current,
          appliedChanges: result.appliedChanges,
          pluginStoreRevision: fileStore.revision()
        }),
        evidence: [
          createPluginToolEvidence({
            context,
            pluginId: characterStatePluginId,
            status: 'accepted',
            summary: `Applied ${String(result.appliedChanges.length)} Character State changes.`
          })
        ]
      };
    }
  } satisfies RuntimePlugin);
}

function readCurrentCharacterState(
  fileStore: RuntimePluginFileStore
): CharacterRuntimeState {
  const current = fileStore.readJson(characterStateCurrentPath);

  if (current === undefined) {
    return createDefaultCharacterRuntimeState();
  }

  return decodeCharacterRuntimeState(current, (field) => {
    throw new TypeError(`Stored Character State plugin field "${field}" is malformed.`);
  });
}

function requiredFileStore(context: RuntimePluginToolContext): RuntimePluginFileStore {
  if (context.fileStore === undefined) {
    throw new TypeError('Character State plugin requires file_store API.');
  }

  return context.fileStore;
}
