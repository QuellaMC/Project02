import {createHash} from 'node:crypto';

import {assertCanonicalRuntimeTimestamp} from '../../../core/index.ts';
import {canonicalJsonStringify} from '../../../shared/canonical-json.ts';

import {createRuntimePlugin} from '../../api/constructors.ts';
import {createRuntimePluginContextItem} from '../../api/manifest-validation.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {
  RuntimePluginContext,
  RuntimePluginJsonObject,
} from '../../api/types.ts';
import {type ModelToolInputContract} from '../../../role-model/index.ts';
import {characterStatePatchModelToolName} from '../../api/contract.ts';
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
  type CharacterRuntimeState,
} from './schema.ts';
import {
  createPluginContextEvidence,
  createPluginToolEvidence,
} from '../../api/evidence-helpers.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginFileStore,
  RuntimePluginManifest,
} from '../../api/types.ts';
import {characterStatePluginId} from '../../api/contract.ts';

export {characterStatePluginId} from '../../api/contract.ts';

const characterStatePluginEntry = './index.ts';
const characterStatePluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);
const characterStateEventsPath = 'events.jsonl';
const characterStateCheckpointPath = 'checkpoint.json';
const characterStateCheckpointVersion = 1;
const characterStateIdempotencyRecordVersion = 1;

const characterStatePatchInputContract = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    mood: Object.freeze({
      type: 'string',
      description:
        "The character's internal current mood; assistant-owned, model-only, and not the user's mood.",
      enum: characterMoodValues,
    }),
    energy: Object.freeze({
      type: 'string',
      description:
        "The character's internal current energy; assistant-owned, model-only, and not the user's energy.",
      enum: characterEnergyValues,
    }),
    attention: Object.freeze({
      type: 'string',
      description:
        "The character's internal current attention; assistant-owned and model-only.",
      enum: characterAttentionValues,
    }),
    currentActivity: Object.freeze({
      type: 'string',
      description:
        "The character's internal current activity; assistant-owned and model-only.",
      enum: characterCurrentActivityValues,
    }),
    socialOrientation: Object.freeze({
      type: 'string',
      description:
        "The character's internal current social orientation; assistant-owned and model-only.",
      enum: characterSocialOrientationValues,
    }),
  }),
  required: Object.freeze([]),
  additionalProperties: false,
} satisfies ModelToolInputContract);

export function createCharacterStatePluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: characterStatePluginDescriptorUrl,
    expectedEntry: characterStatePluginEntry,
  }).manifest;
}

export function createCharacterStatePlugin(): RuntimePlugin {
  return createCharacterStatePluginFromManifest(
    createCharacterStatePluginManifest(),
  );
}

export function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): RuntimePlugin {
  return createCharacterStatePluginFromManifest(input.manifest);
}

function createCharacterStatePluginFromManifest(
  manifest: RuntimePluginManifest,
): RuntimePlugin {
  const plugin = createRuntimePlugin({
    manifest,
    providedTools: [
      Object.freeze({
        name: characterStatePatchModelToolName,
        description:
          "Optionally patch the character's internal Character State. This assistant-owned model-only state is not the user's mood, energy, attention, activity, or social orientation.",
        inputContract: characterStatePatchInputContract,
        validationOwner: 'plugin_host',
        // Two patches in one batch would race the same files.
        annotations: {readOnlyHint: false, destructiveHint: true},
        concurrency: 'exclusive',
        requiresConfirmation: false,
      }),
    ],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const state = readCharacterStateStore(
          requiredFileStore(context),
        ).current;
        const brief = createLivingStateBrief(state);

        return Object.freeze({
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: characterStatePluginId,
              id: 'current',
              kind: 'runtime_note',
              text: `${context.character.displayName}'s internal Character State (assistant-owned, model-only; not user state): ${brief.text}`,
              budget: {
                estimatedTokens: 32,
                priority: 90,
              },
              sourceReferences: [],
              confidence: 1,
              redactionLabels: context.privacy.redactionLabels,
            }),
          ],
          evidence: [
            createPluginContextEvidence({
              context,
              pluginId: characterStatePluginId,
              status: 'accepted',
              summary: 'Provided current Character State context.',
            }),
          ],
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
                summary: `Rejected undeclared tool "${call.toolName}".`,
              }),
            ],
          };
        }

        const fileStore = requiredFileStore(context);
        const store = readCharacterStateStore(fileStore);
        const duplicateEvent = readCharacterStatePatchIdempotencyRecord({
          fileStore,
          eventId: call.eventId,
          traceId: call.traceId,
          createdAt: call.createdAt,
          ...(call.toolCallId === undefined
            ? {}
            : {toolCallId: call.toolCallId}),
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
                  summary: message,
                }),
              ],
            };
          }

          return {
            status: 'accepted',
            output: Object.freeze({
              status: 'accepted',
              current: storedResult.after.current,
              appliedChanges: storedResult.appliedChanges,
              idempotent: true,
            }),
            evidence: [
              createPluginToolEvidence({
                context,
                pluginId: characterStatePluginId,
                status: 'accepted',
                summary: 'Skipped duplicate Character State patch event.',
              }),
            ],
          };
        }

        const before = store.current;
        const result = planCharacterStatePatch({
          before,
          patchInput: call.input,
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
                summary: result.rejection.details,
              }),
            ],
          };
        }

        const event = Object.freeze({
          type: 'character_state.patch',
          eventId: call.eventId,
          traceId: call.traceId,
          ...(call.toolCallId === undefined
            ? {}
            : {toolCallId: call.toolCallId}),
          createdAt: call.createdAt,
          input: call.input,
          result,
        } satisfies RuntimePluginJsonObject);

        fileStore.appendJsonl(characterStateEventsPath, event);
        writeCharacterStatePatchIdempotencyRecord(
          fileStore,
          decodeStoredCharacterStatePatchEvent(event),
        );
        writeCharacterStateCheckpoint(fileStore, {
          eventCount: store.eventCount + 1,
          current: result.after,
        });

        return {
          status: 'accepted',
          output: Object.freeze({
            status: 'accepted',
            current: result.after.current,
            appliedChanges: result.appliedChanges,
          }),
          evidence: [
            createPluginToolEvidence({
              context,
              pluginId: characterStatePluginId,
              status: 'accepted',
              summary:
                result.appliedChanges.length === 0
                  ? 'Recorded no-op Character State patch identity.'
                  : `Applied ${String(result.appliedChanges.length)} Character State changes.`,
            }),
          ],
        };
      },
    },
  });

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
      'Stored Character State idempotency record is malformed.',
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
      'Stored Character State idempotency record identity is malformed.',
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
  events: readonly unknown[],
): DecodedCharacterStateEventLog {
  const decodedEvents: DecodedCharacterStatePatchEvent[] = [];
  const identities = new Set<string>();
  let authoritativeState = createDefaultCharacterRuntimeState();

  for (const rawEvent of events) {
    const event = decodeStoredCharacterStatePatchEvent(rawEvent);
    const identity = characterStatePatchIdentityKey(event);

    if (identities.has(identity)) {
      throw new TypeError(
        'Stored Character State plugin event identity is duplicated.',
      );
    }

    if (!characterRuntimeStatesEqual(event.result.before, authoritativeState)) {
      throw new TypeError(
        'Stored Character State plugin event chain is discontinuous.',
      );
    }

    identities.add(identity);
    decodedEvents.push(event);
    authoritativeState = event.result.after;
  }

  return Object.freeze({
    events: Object.freeze(decodedEvents),
    current: authoritativeState,
  } satisfies DecodedCharacterStateEventLog);
}

function decodeStoredCharacterStatePatchEvent(
  event: unknown,
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

  const result = decodeAcceptedCharacterStatePatchResult(
    storedResult,
    field => {
      throw new TypeError(
        `Stored Character State plugin event field "${field}" is malformed.`,
      );
    },
  );

  if (!jsonObjectEntriesEqual(input, result.patch)) {
    throw new TypeError(
      'Stored Character State plugin event input is malformed.',
    );
  }

  return Object.freeze({
    eventId,
    traceId,
    createdAt,
    ...(toolCallId === undefined ? {} : {toolCallId}),
    input: Object.freeze({...input}),
    result,
  } satisfies DecodedCharacterStatePatchEvent);
}

function requiredStoredEventIdentityField(
  event: RuntimePluginJsonObject,
  field: 'eventId' | 'traceId' | 'createdAt',
): string {
  const value = event[field];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Stored Character State plugin event is malformed.');
  }

  if (field === 'createdAt') {
    try {
      return assertCanonicalRuntimeTimestamp(
        value,
        'Stored Character State plugin event createdAt',
      );
    } catch {
      throw new TypeError('Stored Character State plugin event is malformed.');
    }
  }

  return value;
}

function jsonObjectEntriesEqual(left: object, right: object): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every((entry, index) => {
      const other = rightEntries[index];

      return (
        other !== undefined && entry[0] === other[0] && entry[1] === other[1]
      );
    })
  );
}

function readCharacterStateStore(
  fileStore: RuntimePluginFileStore,
): CharacterStateCheckpoint {
  const storedCheckpoint = fileStore.readJson(characterStateCheckpointPath);

  if (storedCheckpoint !== undefined) {
    const checkpoint = decodeCharacterStateCheckpoint(storedCheckpoint);

    if (checkpoint.storeRevision === fileStore.revision()) {
      return checkpoint;
    }
  }

  const eventLog = decodeCharacterStateEventLog(
    fileStore.readJsonl(characterStateEventsPath),
  );

  for (const event of eventLog.events) {
    writeCharacterStatePatchIdempotencyRecord(fileStore, event);
  }

  return writeCharacterStateCheckpoint(fileStore, {
    eventCount: eventLog.events.length,
    current: eventLog.current,
  });
}

function decodeCharacterStateCheckpoint(
  value: unknown,
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

  const current = decodeCharacterRuntimeState(value['current'], field => {
    throw new TypeError(
      `Stored Character State checkpoint field "${field}" is malformed.`,
    );
  });

  return Object.freeze({
    eventCount: value['eventCount'],
    storeRevision: value['storeRevision'],
    current,
  } satisfies CharacterStateCheckpoint);
}

function writeCharacterStateCheckpoint(
  fileStore: RuntimePluginFileStore,
  value: Pick<CharacterStateCheckpoint, 'eventCount' | 'current'>,
): CharacterStateCheckpoint {
  const checkpoint = Object.freeze({
    kind: 'character_state.checkpoint',
    version: characterStateCheckpointVersion,
    eventCount: value.eventCount,
    storeRevision: fileStore.revision() + 1,
    current: value.current,
  } satisfies RuntimePluginJsonObject);

  fileStore.writeJsonAtomic(characterStateCheckpointPath, checkpoint);
  return decodeCharacterStateCheckpoint(checkpoint);
}

function writeCharacterStatePatchIdempotencyRecord(
  fileStore: RuntimePluginFileStore,
  decodedEvent: DecodedCharacterStatePatchEvent,
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
          : {toolCallId: decodedEvent.toolCallId}),
        createdAt: decodedEvent.createdAt,
        input: decodedEvent.input,
        result: decodedEvent.result,
      }),
    } satisfies RuntimePluginJsonObject),
  );
}

function characterStateIdempotencyPath(identity: {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly toolCallId?: string;
}): string {
  const digest = createHash('sha256')
    .update(characterStatePatchIdentityKey(identity))
    .digest('hex');

  return `idempotency/${digest}.json`;
}

function characterStatePatchIdentityKey(identity: {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly toolCallId?: string;
}): string {
  return canonicalJsonStringify([
    identity.eventId,
    identity.traceId,
    identity.createdAt,
    identity.toolCallId ?? null,
  ]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function requiredFileStore(
  context: RuntimePluginContext,
): RuntimePluginFileStore {
  if (context.fileStore === undefined) {
    throw new TypeError('Character State plugin requires file_store API.');
  }

  return context.fileStore;
}

function isJsonObject(value: unknown): value is RuntimePluginJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
