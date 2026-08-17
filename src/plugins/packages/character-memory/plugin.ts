import {createHash} from 'node:crypto';

import {canonicalJsonStringify} from '../../../shared/canonical-json.ts';
import {type ModelToolInputContract} from '../../../role-model/index.ts';

import {createRuntimePlugin} from '../../api/constructors.ts';
import {createRuntimePluginCuratedContextSection} from '../../api/curated-context.ts';
import {isRecord} from '../../api/validation-primitives.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import {
  createPluginContextEvidence,
  createPluginToolEvidence,
} from '../../api/evidence-helpers.ts';
import {
  characterMemoryPluginId,
  characterMemoryUpdateToolName,
} from '../../api/contract.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginContext,
  RuntimePluginCuratedContextSection,
  RuntimePluginFileStore,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginManifest,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult,
} from '../../api/types.ts';
import {
  characterMemoryAppliedRecordFor,
  characterMemoryCapChars,
  characterMemoryOperationLimit,
  characterMemoryStorePath,
  characterMemoryTargetValues,
  characterMemoryUsedChars,
  decodeCharacterMemoryStoreDocument,
  encodeCharacterMemoryStoreDocument,
  planCharacterMemoryOperations,
  renderCharacterMemoryEntries,
  withCharacterMemoryAppliedRecord,
  type CharacterMemoryOperation,
  type CharacterMemoryStoreDocument,
  type CharacterMemoryTarget,
} from './store.ts';

export {characterMemoryPluginId} from '../../api/contract.ts';

const characterMemoryPluginEntry = './index.ts';
const characterMemoryPluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);

const characterMemorySectionTitles: Readonly<
  Record<CharacterMemoryTarget, string>
> = Object.freeze({
  notes: 'Notes to yourself',
  user_profile: 'What you know about them',
});

const characterMemorySectionIds: Readonly<
  Record<CharacterMemoryTarget, string>
> = Object.freeze({
  notes: 'notes',
  user_profile: 'user-profile',
});

const characterMemoryEntryTextSchema = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: Math.max(...Object.values(characterMemoryCapChars)),
  description: 'Full entry text to store.',
});

const characterMemoryTargetSchema = Object.freeze({
  type: 'string',
  enum: characterMemoryTargetValues,
  description:
    'notes holds what you want to remember; user_profile holds what you know about them.',
});

const characterMemoryOldTextSchema = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: Math.max(...Object.values(characterMemoryCapChars)),
  description:
    'Substring selecting exactly one existing entry; ambiguity rejects the batch.',
});

const characterMemoryUpdateInputContract = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    operations: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: characterMemoryOperationLimit,
      description: 'Atomic batch: every operation commits or none do.',
      items: Object.freeze({
        oneOf: Object.freeze([
          Object.freeze({
            type: 'object',
            properties: Object.freeze({
              action: Object.freeze({type: 'string', enum: ['add']}),
              target: characterMemoryTargetSchema,
              text: characterMemoryEntryTextSchema,
            }),
            required: Object.freeze(['action', 'target', 'text']),
            additionalProperties: false,
          }),
          Object.freeze({
            type: 'object',
            properties: Object.freeze({
              action: Object.freeze({type: 'string', enum: ['replace']}),
              target: characterMemoryTargetSchema,
              text: characterMemoryEntryTextSchema,
              old_text: characterMemoryOldTextSchema,
            }),
            required: Object.freeze(['action', 'target', 'text', 'old_text']),
            additionalProperties: false,
          }),
          Object.freeze({
            type: 'object',
            properties: Object.freeze({
              action: Object.freeze({type: 'string', enum: ['remove']}),
              target: characterMemoryTargetSchema,
              old_text: characterMemoryOldTextSchema,
            }),
            required: Object.freeze(['action', 'target', 'old_text']),
            additionalProperties: false,
          }),
        ]),
      }),
    }),
  }),
  required: Object.freeze(['operations']),
  additionalProperties: false,
} satisfies ModelToolInputContract);

export function createCharacterMemoryPluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: characterMemoryPluginDescriptorUrl,
    expectedEntry: characterMemoryPluginEntry,
  }).manifest;
}

export function createCharacterMemoryPlugin(): RuntimePlugin {
  return createCharacterMemoryPluginFromManifest(
    createCharacterMemoryPluginManifest(),
  );
}

export function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): RuntimePlugin {
  return createCharacterMemoryPluginFromManifest(input.manifest);
}

function createCharacterMemoryPluginFromManifest(
  manifest: RuntimePluginManifest,
): RuntimePlugin {
  // Frozen per session: built once for each session this instance serves,
  // so mid-session writes surface when the next session begins (a
  // continuation included) and the trusted frame stays byte-stable meanwhile.
  let snapshot:
    | {
        readonly sessionId: string;
        readonly sections: readonly RuntimePluginCuratedContextSection[];
      }
    | undefined;

  return createRuntimePlugin({
    manifest,
    providedTools: [
      Object.freeze({
        name: characterMemoryUpdateToolName,
        description:
          "Update your notes — what you carry from one conversation to the next (you see them at the start of every conversation as 'What you carry between conversations'). Save stable facts worth keeping: what they like and correct you on, facts about their world, conventions, how they work. Skip passing task details and anything easily found again. add appends an entry; replace and remove pick exactly one existing entry by a unique old_text substring. New notes appear from your next conversation on; a full notebook rejects the batch, so tighten or drop stale entries first.",
        inputContract: characterMemoryUpdateInputContract,
        validationOwner: 'plugin_host',
        // Two batches in flight would race the same document.
        concurrency: 'exclusive',
        requiresConfirmation: false,
      }),
    ],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        if (snapshot?.sessionId !== context.sessionId) {
          snapshot = {
            sessionId: context.sessionId,
            sections: characterMemorySnapshotSections(
              requiredCharacterFileStore(context),
            ),
          };
        }

        const sections = snapshot.sections;

        return Object.freeze({
          contextItems: [],
          curatedContext: sections,
          evidence: [
            createPluginContextEvidence({
              context,
              pluginId: characterMemoryPluginId,
              status: 'accepted',
              summary:
                sections.length === 0
                  ? 'Curated memory is empty.'
                  : `Provided the curated memory snapshot (${sections
                      .map(
                        section =>
                          `${section.id} ${String(section.usedChars ?? 0)}/${String(
                            section.capChars ?? 0,
                          )} chars`,
                      )
                      .join(', ')}).`,
            }),
          ],
        } satisfies RuntimePluginBeforeRoleModelCallResult);
      },
      handleToolCall(call, context) {
        if (call.toolName !== characterMemoryUpdateToolName) {
          return {
            status: 'rejected',
            reason: 'tool_not_declared',
            message: `Character memory plugin does not handle "${call.toolName}".`,
            evidence: [
              createPluginToolEvidence({
                context,
                pluginId: characterMemoryPluginId,
                status: 'rejected',
                summary: `Rejected undeclared tool "${call.toolName}".`,
              }),
            ],
          };
        }

        const fileStore = requiredCharacterFileStore(context);

        // One lease across read and rewrite: concurrent processes
        // serialize behind it, so a write always folds the document it
        // read.
        return fileStore.withMutations(() =>
          appliedCharacterMemoryUpdateCall(call, context, fileStore),
        );
      },
    },
  });
}

function characterMemorySnapshotSections(
  fileStore: RuntimePluginFileStore,
): readonly RuntimePluginCuratedContextSection[] {
  const document = decodeCharacterMemoryStoreDocument(
    fileStore.readJson(characterMemoryStorePath),
  );
  const entriesByTarget: Readonly<
    Record<CharacterMemoryTarget, readonly string[]>
  > = Object.freeze({
    notes: document.store.notes,
    user_profile: document.store.userProfile,
  });

  return Object.freeze(
    characterMemoryTargetValues.flatMap(target => {
      const entries = entriesByTarget[target];

      if (entries.length === 0) {
        return [];
      }

      const text = renderCharacterMemoryEntries(entries);

      return [
        createRuntimePluginCuratedContextSection({
          pluginId: characterMemoryPluginId,
          id: characterMemorySectionIds[target],
          title: characterMemorySectionTitles[target],
          text,
          capChars: characterMemoryCapChars[target],
          usedChars: text.length,
        }),
      ];
    }),
  );
}

function appliedCharacterMemoryUpdateCall(
  call: RuntimePluginToolCall,
  context: RuntimePluginContext,
  fileStore: RuntimePluginFileStore,
): RuntimePluginToolCallResult {
  const document = decodeCharacterMemoryStoreDocument(
    fileStore.readJson(characterMemoryStorePath),
  );
  const inputDigest = characterMemoryInputDigest(call.input);
  const identity = {
    eventId: call.eventId,
    traceId: call.traceId,
    ...(call.toolCallId === undefined ? {} : {toolCallId: call.toolCallId}),
    createdAt: call.createdAt,
  };
  const applied = characterMemoryAppliedRecordFor(document, identity);

  if (applied !== undefined) {
    if (applied.inputDigest !== inputDigest) {
      const message =
        'memory.update identity was already committed with different input.';

      return {
        status: 'rejected',
        reason: 'memory_idempotency_conflict',
        message,
        evidence: [
          createPluginToolEvidence({
            context,
            pluginId: characterMemoryPluginId,
            status: 'rejected',
            summary: message,
          }),
        ],
      };
    }

    return {
      status: 'accepted',
      output: Object.freeze({...applied.output, idempotent: true}),
      evidence: [
        createPluginToolEvidence({
          context,
          pluginId: characterMemoryPluginId,
          status: 'accepted',
          summary: 'Skipped duplicate memory update event.',
        }),
      ],
    };
  }

  const result = planCharacterMemoryOperations({
    store: document.store,
    operations: characterMemoryOperationsFromInput(call.input),
  });

  if (result.status === 'rejected') {
    return {
      status: 'rejected',
      reason: result.reason,
      message: result.details,
      evidence: [
        createPluginToolEvidence({
          context,
          pluginId: characterMemoryPluginId,
          status: 'rejected',
          summary: result.details,
        }),
      ],
    };
  }

  const output = Object.freeze({
    status: 'accepted',
    appliedChanges: result.appliedChanges,
    usage: Object.freeze({
      notes: characterMemoryUsageSummary(result.after.notes, 'notes'),
      user_profile: characterMemoryUsageSummary(
        result.after.userProfile,
        'user_profile',
      ),
    }),
    visibleNextSession: true,
  } satisfies RuntimePluginJsonObject);
  const nextDocument: CharacterMemoryStoreDocument = Object.freeze({
    store: result.after,
    appliedRecords: withCharacterMemoryAppliedRecord(document.appliedRecords, {
      ...identity,
      inputDigest,
      output,
    }),
  });

  fileStore.writeJsonAtomic(
    characterMemoryStorePath,
    encodeCharacterMemoryStoreDocument(nextDocument),
  );

  return {
    status: 'accepted',
    output,
    evidence: [
      createPluginToolEvidence({
        context,
        pluginId: characterMemoryPluginId,
        status: 'accepted',
        summary:
          result.appliedChanges.length === 0
            ? 'Recorded no-op memory update identity.'
            : `Applied ${String(
                result.appliedChanges.filter(
                  change => change.status === 'applied',
                ).length,
              )} memory change(s).`,
      }),
    ],
  };
}

function characterMemoryUsageSummary(
  entries: readonly string[],
  target: CharacterMemoryTarget,
): RuntimePluginJsonObject {
  return Object.freeze({
    usedChars: characterMemoryUsedChars(entries),
    capChars: characterMemoryCapChars[target],
    entryCount: entries.length,
  });
}

/** Ajv (validationOwner plugin_host) already proved the shape; this narrows. */
function characterMemoryOperationsFromInput(
  input: RuntimePluginJsonObject,
): readonly CharacterMemoryOperation[] {
  const operations = input['operations'];

  if (!Array.isArray(operations)) {
    throw new TypeError('memory.update input operations must be an array.');
  }

  return Object.freeze(
    operations.map((operation: RuntimePluginJsonValue) =>
      characterMemoryOperationFromInput(operation),
    ),
  );
}

function characterMemoryOperationFromInput(
  operation: RuntimePluginJsonValue,
): CharacterMemoryOperation {
  if (!isRecord(operation)) {
    throw new TypeError('memory.update operations must be objects.');
  }

  const action = operation['action'];
  const target = operation['target'];

  if (target !== 'notes' && target !== 'user_profile') {
    throw new TypeError('memory.update operation target is not supported.');
  }

  if (action === 'add') {
    return Object.freeze({
      action,
      target,
      text: requiredOperationString(operation['text'], 'text'),
    });
  }

  if (action === 'replace') {
    return Object.freeze({
      action,
      target,
      text: requiredOperationString(operation['text'], 'text'),
      oldText: requiredOperationString(operation['old_text'], 'old_text'),
    });
  }

  if (action === 'remove') {
    return Object.freeze({
      action,
      target,
      oldText: requiredOperationString(operation['old_text'], 'old_text'),
    });
  }

  throw new TypeError('memory.update operation action is not supported.');
}

function requiredOperationString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `memory.update operation ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function characterMemoryInputDigest(input: RuntimePluginJsonObject): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(input))
    .digest('hex')}`;
}

function requiredCharacterFileStore(
  context: RuntimePluginContext,
): RuntimePluginFileStore {
  const fileStore = context.characterFileStore;

  if (fileStore === undefined) {
    throw new TypeError(
      'Character memory requires the character-scoped file store capability.',
    );
  }

  return fileStore;
}
