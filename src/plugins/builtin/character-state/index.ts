import { createHash } from 'node:crypto';

import { assertCanonicalRuntimeTimestamp } from '../../../runtime/event.ts';

import {
  createRuntimePlugin
} from '../../constructors.ts';
import {
  createRuntimePluginContextItem,
  createRuntimePluginManifest
} from '../../manifest-validation.ts';
import { runtimePluginContractVersion } from '../../contract.ts';
import type {
  RuntimePluginContext,
  RuntimePluginJsonObject
} from '../../plugin-types.ts';
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
  characterRuntimeStatesEqual,
  createDefaultCharacterRuntimeState,
  createLivingStateBrief,
  decodeAcceptedCharacterStatePatchResult,
  decodeCharacterRuntimeState,
  planCharacterStatePatch,
  type AcceptedCharacterStatePatchResult,
  type CharacterRuntimeState
} from './schema.ts';
import { createPluginContextEvidence, createPluginToolEvidence } from '../../evidence.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginFileStore,
  RuntimePluginManifest
} from '../../plugin-types.ts';

export const characterStatePluginId = 'character-state';

const characterStateEventsPath = 'events.jsonl';
const characterStateCheckpointPath = 'checkpoint.json';
const characterStateCheckpointVersion = 1;
const characterStateIdempotencyRecordVersion = 1;
const characterStatePluginInstances = new WeakSet<RuntimePlugin>();

const characterStatePatchInputContract = Object.freeze({
  type: 'object',
  fields: Object.freeze([
    Object.freeze({
      name: 'mood',
      description: "Mira's internal current mood; assistant-owned, model-only, and not the user's mood.",
      required: false,
      allowedValues: characterMoodValues
    }),
    Object.freeze({
      name: 'energy',
      description: "Mira's internal current energy; assistant-owned, model-only, and not the user's energy.",
      required: false,
      allowedValues: characterEnergyValues
    }),
    Object.freeze({
      name: 'attention',
      description: "Mira's internal current attention; assistant-owned and model-only.",
      required: false,
      allowedValues: characterAttentionValues
    }),
    Object.freeze({
      name: 'currentActivity',
      description: "Mira's internal current activity; assistant-owned and model-only.",
      required: false,
      allowedValues: characterCurrentActivityValues
    }),
    Object.freeze({
      name: 'socialOrientation',
      description: "Mira's internal current social orientation; assistant-owned and model-only.",
      required: false,
      allowedValues: characterSocialOrientationValues
    })
  ]),
  additionalFields: false
} satisfies ModelToolInputContract);

export function createCharacterStatePluginManifest(): RuntimePluginManifest {
  return createRuntimePluginManifest({
    id: characterStatePluginId,
    displayName: 'Character State',
    version: '1.0.0',
    kind: 'first_party',
    description: "First-party assistant-owned Character State context and patch tool for Mira's internal state.",
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
    requestedAccess: { file_store: 'write', model_input: 'write' }
  });
}

export function createCharacterStatePlugin(): RuntimePlugin {
  const plugin = createRuntimePlugin({
    manifest: createCharacterStatePluginManifest(),
    providedTools: [
      Object.freeze({
        name: characterStatePatchModelToolName,
        description:
          "Optionally patch Mira's internal Character State. This assistant-owned model-only state is not the user's mood, energy, attention, activity, or social orientation.",
        requiredForUserTurn: false,
        callLimit: {
          scope: 'user_turn',
          maxCalls: 1
        },
        inputContract: characterStatePatchInputContract,
        validationOwner: 'plugin_host',
        sideEffectLevel: 'local_memory_write',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      })
    ],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const state = readCharacterStateStore(
          requiredFileStore(context)
        ).current;
        const brief = createLivingStateBrief(state);

        return Object.freeze({
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: characterStatePluginId,
              id: 'current',
              kind: 'runtime_note',
              text: `Mira's internal Character State (assistant-owned, model-only; not user state): ${brief.text}`,
              budget: {
                estimatedTokens: 32,
                priority: 90
              },
              sourceReferences: [],
              confidence: 1,
              redactionLabels: context.privacy.redactionLabels
            })
          ],
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
        const store = readCharacterStateStore(fileStore);
        const duplicateEvent = readCharacterStatePatchIdempotencyRecord({
          fileStore,
          eventId: call.eventId,
          traceId: call.traceId,
          createdAt: call.createdAt,
          ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId })
        });

        if (duplicateEvent !== undefined) {
          const storedResult = duplicateEvent.result;

          if (!jsonObjectEntriesEqual(call.input, storedResult.patch)) {
            const message =
              'character_state.patch identity was already committed with different input.';

            return {
              status: 'rejected',
              reason: 'character_state_idempotency_conflict',
              message,
              evidence: [
                createPluginToolEvidence({
                  context,
                  pluginId: characterStatePluginId,
                  status: 'rejected',
                  summary: message
                })
              ]
            };
          }

          return {
            status: 'accepted',
            output: Object.freeze({
              status: 'accepted',
              current: storedResult.after.current,
              appliedChanges: storedResult.appliedChanges,
              idempotent: true
            }),
            evidence: [
              createPluginToolEvidence({
                context,
                pluginId: characterStatePluginId,
                status: 'accepted',
                summary: 'Skipped duplicate Character State patch event.'
              })
            ]
          };
        }

        const before = store.current;
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
          ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
          createdAt: call.createdAt,
          input: call.input,
          result
        } satisfies RuntimePluginJsonObject);

        fileStore.appendJsonl(characterStateEventsPath, event);
        writeCharacterStatePatchIdempotencyRecord(
          fileStore,
          decodeStoredCharacterStatePatchEvent(event)
        );
        writeCharacterStateCheckpoint(fileStore, {
          eventCount: store.eventCount + 1,
          current: result.after
        });

        return {
          status: 'accepted',
          output: Object.freeze({
            status: 'accepted',
            current: result.after.current,
            appliedChanges: result.appliedChanges
          }),
          evidence: [
              createPluginToolEvidence({
                context,
                pluginId: characterStatePluginId,
                status: 'accepted',
                summary:
                  result.appliedChanges.length === 0
                    ? 'Recorded no-op Character State patch identity.'
                    : `Applied ${String(result.appliedChanges.length)} Character State changes.`
              })
          ]
        };
      }
    }
  });

  characterStatePluginInstances.add(plugin);
  return plugin;
}

function readCharacterStatePatchIdempotencyRecord(options: {
  readonly fileStore: RuntimePluginFileStore;
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly toolCallId?: string;
}): DecodedCharacterStatePatchEvent | undefined {
  const path = characterStateIdempotencyPath(options);
  const record = options.fileStore.readJson(path);

  if (record === undefined) {
    return undefined;
  }

  if (
    !isJsonObject(record) ||
    record['kind'] !== 'character_state.patch_idempotency' ||
    record['version'] !== characterStateIdempotencyRecordVersion
  ) {
    throw new TypeError(
      'Stored Character State idempotency record is malformed.'
    );
  }

  const event = decodeStoredCharacterStatePatchEvent(record['event']);

  if (
    event.eventId !== options.eventId ||
    event.traceId !== options.traceId ||
    event.createdAt !== options.createdAt ||
    event.toolCallId !== options.toolCallId
  ) {
    throw new TypeError(
      'Stored Character State idempotency record identity is malformed.'
    );
  }

  return event;
}

type DecodedCharacterStatePatchEvent = {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly toolCallId?: string;
  readonly input: RuntimePluginJsonObject;
  readonly result: AcceptedCharacterStatePatchResult;
};

type DecodedCharacterStateEventLog = {
  readonly events: readonly DecodedCharacterStatePatchEvent[];
  readonly current: CharacterRuntimeState;
};

type CharacterStateCheckpoint = {
  readonly eventCount: number;
  readonly storeRevision: number;
  readonly current: CharacterRuntimeState;
};

function decodeCharacterStateEventLog(
  events: readonly unknown[]
): DecodedCharacterStateEventLog {
  const decodedEvents: DecodedCharacterStatePatchEvent[] = [];
  const identities = new Set<string>();
  let authoritativeState = createDefaultCharacterRuntimeState();

  for (const rawEvent of events) {
    const event = decodeStoredCharacterStatePatchEvent(rawEvent);
    const identity = JSON.stringify([
      event.eventId,
      event.traceId,
      event.createdAt,
      event.toolCallId ?? null
    ]);

    if (identities.has(identity)) {
      throw new TypeError(
        'Stored Character State plugin event identity is duplicated.'
      );
    }

    if (!characterRuntimeStatesEqual(event.result.before, authoritativeState)) {
      throw new TypeError(
        'Stored Character State plugin event chain is discontinuous.'
      );
    }

    identities.add(identity);
    decodedEvents.push(event);
    authoritativeState = event.result.after;
  }

  return Object.freeze({
    events: Object.freeze(decodedEvents),
    current: authoritativeState
  } satisfies DecodedCharacterStateEventLog);
}

function decodeStoredCharacterStatePatchEvent(
  event: unknown
): DecodedCharacterStatePatchEvent {
  if (!isJsonObject(event) || event['type'] !== 'character_state.patch') {
    throw new TypeError('Stored Character State plugin event is malformed.');
  }

  const eventId = requiredStoredEventIdentityField(event, 'eventId');
  const traceId = requiredStoredEventIdentityField(event, 'traceId');
  const createdAt = requiredStoredEventIdentityField(event, 'createdAt');
  const toolCallId = event['toolCallId'];
  const input = event['input'];
  const storedResult = event['result'];

  if (
    eventId === traceId ||
    (toolCallId !== undefined &&
      (typeof toolCallId !== 'string' || toolCallId.trim().length === 0)) ||
    !isJsonObject(input) ||
    !isJsonObject(storedResult)
  ) {
    throw new TypeError('Stored Character State plugin event is malformed.');
  }

  const result = decodeAcceptedCharacterStatePatchResult(storedResult, (field) => {
    throw new TypeError(
      `Stored Character State plugin event field "${field}" is malformed.`
    );
  });

  if (!jsonObjectEntriesEqual(input, result.patch)) {
    throw new TypeError('Stored Character State plugin event input is malformed.');
  }

  return Object.freeze({
    eventId,
    traceId,
    createdAt,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    input: Object.freeze({ ...input }),
    result
  } satisfies DecodedCharacterStatePatchEvent);
}

function requiredStoredEventIdentityField(
  event: RuntimePluginJsonObject,
  field: 'eventId' | 'traceId' | 'createdAt'
): string {
  const value = event[field];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Stored Character State plugin event is malformed.');
  }

  if (field === 'createdAt') {
    try {
      return assertCanonicalRuntimeTimestamp(
        value,
        'Stored Character State plugin event createdAt'
      );
    } catch {
      throw new TypeError('Stored Character State plugin event is malformed.');
    }
  }

  return value;
}

function jsonObjectEntriesEqual(left: object, right: object): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey)
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey)
  );

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every((entry, index) => {
      const other = rightEntries[index];

      return other !== undefined && entry[0] === other[0] && entry[1] === other[1];
    })
  );
}

export function isCharacterStatePlugin(plugin: RuntimePlugin): boolean {
  return characterStatePluginInstances.has(plugin);
}

function readCharacterStateStore(
  fileStore: RuntimePluginFileStore
): CharacterStateCheckpoint {
  const storedCheckpoint = fileStore.readJson(characterStateCheckpointPath);

  if (storedCheckpoint !== undefined) {
    const checkpoint = decodeCharacterStateCheckpoint(storedCheckpoint);

    if (checkpoint.storeRevision === fileStore.revision()) {
      return checkpoint;
    }
  }

  const eventLog = decodeCharacterStateEventLog(
    fileStore.readJsonl(characterStateEventsPath)
  );

  for (const event of eventLog.events) {
    writeCharacterStatePatchIdempotencyRecord(fileStore, event);
  }

  return writeCharacterStateCheckpoint(fileStore, {
    eventCount: eventLog.events.length,
    current: eventLog.current
  });
}

function decodeCharacterStateCheckpoint(
  value: unknown
): CharacterStateCheckpoint {
  if (
    !isJsonObject(value) ||
    value['kind'] !== 'character_state.checkpoint' ||
    value['version'] !== characterStateCheckpointVersion ||
    !isNonNegativeSafeInteger(value['eventCount']) ||
    !isNonNegativeSafeInteger(value['storeRevision'])
  ) {
    throw new TypeError('Stored Character State checkpoint is malformed.');
  }

  const current = decodeCharacterRuntimeState(value['current'], (field) => {
    throw new TypeError(
      `Stored Character State checkpoint field "${field}" is malformed.`
    );
  });

  return Object.freeze({
    eventCount: value['eventCount'],
    storeRevision: value['storeRevision'],
    current
  } satisfies CharacterStateCheckpoint);
}

function writeCharacterStateCheckpoint(
  fileStore: RuntimePluginFileStore,
  value: Pick<CharacterStateCheckpoint, 'eventCount' | 'current'>
): CharacterStateCheckpoint {
  const checkpoint = Object.freeze({
    kind: 'character_state.checkpoint',
    version: characterStateCheckpointVersion,
    eventCount: value.eventCount,
    storeRevision: fileStore.revision() + 1,
    current: value.current
  } satisfies RuntimePluginJsonObject);

  fileStore.writeJsonAtomic(characterStateCheckpointPath, checkpoint);
  return decodeCharacterStateCheckpoint(checkpoint);
}

function writeCharacterStatePatchIdempotencyRecord(
  fileStore: RuntimePluginFileStore,
  decodedEvent: DecodedCharacterStatePatchEvent
): void {
  fileStore.writeJsonAtomic(
    characterStateIdempotencyPath(decodedEvent),
    Object.freeze({
      kind: 'character_state.patch_idempotency',
      version: characterStateIdempotencyRecordVersion,
      event: Object.freeze({
        type: 'character_state.patch',
        eventId: decodedEvent.eventId,
        traceId: decodedEvent.traceId,
        ...(decodedEvent.toolCallId === undefined
          ? {}
          : { toolCallId: decodedEvent.toolCallId }),
        createdAt: decodedEvent.createdAt,
        input: decodedEvent.input,
        result: decodedEvent.result
      })
    } satisfies RuntimePluginJsonObject)
  );
}

function characterStateIdempotencyPath(identity: {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly toolCallId?: string;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        identity.eventId,
        identity.traceId,
        identity.createdAt,
        identity.toolCallId ?? null
      ])
    )
    .digest('hex');

  return `idempotency/${digest}.json`;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
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
