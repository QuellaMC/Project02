import {
  createRuntimePlugin,
  createRuntimePluginContextItem,
  runtimePluginContractVersion,
  type RuntimePluginContext,
  type RuntimePluginJsonObject
} from '../../types.ts';
import {
  characterStatePatchModelToolName,
  type ModelToolInputContract
} from '../../../role-model/model-tools.ts';
import {
  characterAttentionValues,
  characterCurrentActivityValues,
  characterEnergyValues,
  characterMoodValues,
  characterSocialOrientationValues,
  createDefaultCharacterRuntimeState,
  createLivingStateBrief,
  decodeCharacterRuntimeState,
  planCharacterStatePatch,
  type CharacterRuntimeState
} from './schema.ts';
import { createPluginContextEvidence, createPluginToolEvidence } from '../../evidence.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginFileStore
} from '../../types.ts';

export const characterStatePluginId = 'character-state';

const characterStateEventsPath = 'events.jsonl';
const characterStateCurrentPath = 'current.json';

const characterStatePatchInputContract = Object.freeze({
  type: 'object',
  fields: Object.freeze([
    Object.freeze({
      name: 'mood',
      description: 'Current mood.',
      required: false,
      allowedValues: characterMoodValues
    }),
    Object.freeze({
      name: 'energy',
      description: 'Current energy.',
      required: false,
      allowedValues: characterEnergyValues
    }),
    Object.freeze({
      name: 'attention',
      description: 'Current attention.',
      required: false,
      allowedValues: characterAttentionValues
    }),
    Object.freeze({
      name: 'currentActivity',
      description: 'Current activity.',
      required: false,
      allowedValues: characterCurrentActivityValues
    }),
    Object.freeze({
      name: 'socialOrientation',
      description: 'Current social orientation.',
      required: false,
      allowedValues: characterSocialOrientationValues
    })
  ]),
  additionalFields: false
} satisfies ModelToolInputContract);

export function createCharacterStatePlugin(): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id: characterStatePluginId,
      displayName: 'Character State',
      version: '1.0.0',
      kind: 'first_party',
      description: 'First-party current Character State context and patch tool.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02',
        externalContract: 'character_state_plugin'
      },
      declaredPlugins: [
        'tool_provider',
        'before_role_model_call',
        'handle_tool_call'
      ],
      config: {
        fields: []
      },
      localTrustLevel: 'first_party',
      runtimePolicy: {
        requiredForTurn: true,
        sideEffectLevel: 'local_memory_write',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'reject_turn',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['built_in_character_state']
      },
      requestedApis: ['file_store']
    },
    providedTools: [
      Object.freeze({
        name: characterStatePatchModelToolName,
        description:
          'Optionally propose a current character-state patch. The Character State plugin validates accepted fields and values.',
        requiredForUserTurn: false,
        maxCallsPerUserTurn: 1,
        inputContract: characterStatePatchInputContract,
        validationOwner: 'plugin_host',
        sideEffectLevel: 'local_memory_write',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      })
    ],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const state = readCurrentCharacterState(requiredFileStore(context));
        const brief = createLivingStateBrief(state);

        return Object.freeze({
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: characterStatePluginId,
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
        } satisfies RuntimePluginJsonObject);

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
    }
  });
}

function readCurrentCharacterState(
  fileStore: RuntimePluginFileStore
): CharacterRuntimeState {
  const current = fileStore.readJson(characterStateCurrentPath);

  if (current === undefined) {
    return rebuildCurrentCharacterState(fileStore);
  }

  return decodeCharacterRuntimeState(current, (field) => {
    throw new TypeError(`Stored Character State plugin field "${field}" is malformed.`);
  });
}

function rebuildCurrentCharacterState(
  fileStore: RuntimePluginFileStore
): CharacterRuntimeState {
  let state = createDefaultCharacterRuntimeState();

  for (const event of fileStore.readJsonl(characterStateEventsPath)) {
    if (!isJsonObject(event) || event['type'] !== 'character_state.patch') {
      throw new TypeError('Stored Character State plugin event is malformed.');
    }

    const result = event['result'];

    if (!isJsonObject(result) || result['status'] !== 'accepted') {
      throw new TypeError('Stored Character State plugin event result is malformed.');
    }

    state = decodeCharacterRuntimeState(result['after'], (field) => {
      throw new TypeError(
        `Stored Character State plugin event field "${field}" is malformed.`
      );
    });
  }

  fileStore.writeJsonAtomic(characterStateCurrentPath, state);
  return state;
}

function requiredFileStore(context: RuntimePluginContext): RuntimePluginFileStore {
  if (context.fileStore === undefined) {
    throw new TypeError('Character State plugin requires file_store API.');
  }

  return context.fileStore;
}

function isJsonObject(value: unknown): value is RuntimePluginJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
