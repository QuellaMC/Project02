import {containsForbiddenControlCharacter} from '../../api/curated-context.ts';
import type {
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
} from '../../api/types.ts';

export const characterMemoryStoreVersion = 1;
export const characterMemoryStorePath = 'memory.json';
export const characterMemoryOperationLimit = 8;

export const characterMemoryTargetValues = ['notes', 'user_profile'] as const;
export type CharacterMemoryTarget =
  (typeof characterMemoryTargetValues)[number];

/** Rendered-join capacity per target, mirrored in the tool contract. */
export const characterMemoryCapChars: Readonly<
  Record<CharacterMemoryTarget, number>
> = Object.freeze({
  notes: 2200,
  user_profile: 1375,
});

const characterMemoryEntrySeparator = '\n§\n';

export type CharacterMemoryStore = {
  readonly notes: readonly string[];
  readonly userProfile: readonly string[];
};

export type CharacterMemoryCallIdentity = {
  readonly eventId: string;
  readonly traceId: string;
  readonly toolCallId?: string;
  readonly createdAt: string;
};

export type CharacterMemoryAppliedRecord = CharacterMemoryCallIdentity & {
  readonly inputDigest: string;
  readonly output: RuntimePluginJsonObject;
};

/**
 * Concurrent sessions interleave updates, so a retry is not always the
 * latest operation: keep a window of applied identities rather than only
 * the last, or a delayed retry re-applies against a store another session
 * has since changed.
 *
 * The window is bounded by the retry lifetime, not by how many unrelated
 * updates followed: a busy sibling window must not evict an identity that
 * can still come back. The count is only a floor so a burst inside one
 * moment cannot drop a record either.
 */
export const characterMemoryAppliedRecordLimit = 16;
export const characterMemoryAppliedRecordTtlMs = 15 * 60 * 1_000;

export type CharacterMemoryStoreDocument = {
  readonly store: CharacterMemoryStore;
  readonly appliedRecords: readonly CharacterMemoryAppliedRecord[];
};

export function characterMemoryAppliedRecordFor(
  document: CharacterMemoryStoreDocument,
  identity: CharacterMemoryCallIdentity,
): CharacterMemoryAppliedRecord | undefined {
  return document.appliedRecords.find(
    record =>
      record.eventId === identity.eventId &&
      record.traceId === identity.traceId &&
      record.createdAt === identity.createdAt &&
      record.toolCallId === identity.toolCallId,
  );
}

export function withCharacterMemoryAppliedRecord(
  records: readonly CharacterMemoryAppliedRecord[],
  record: CharacterMemoryAppliedRecord,
  now: number = Date.now(),
): readonly CharacterMemoryAppliedRecord[] {
  const next = [...records, record];
  const recent = next.filter(candidate => {
    const appliedAt = Date.parse(candidate.createdAt);

    return (
      Number.isNaN(appliedAt) ||
      now - appliedAt < characterMemoryAppliedRecordTtlMs
    );
  });

  return Object.freeze(
    recent.length >= characterMemoryAppliedRecordLimit
      ? recent
      : next.slice(-characterMemoryAppliedRecordLimit),
  );
}

export type CharacterMemoryOperation =
  | {
      readonly action: 'add';
      readonly target: CharacterMemoryTarget;
      readonly text: string;
    }
  | {
      readonly action: 'replace';
      readonly target: CharacterMemoryTarget;
      readonly text: string;
      readonly oldText: string;
    }
  | {
      readonly action: 'remove';
      readonly target: CharacterMemoryTarget;
      readonly oldText: string;
    };

export type CharacterMemoryAppliedChange = {
  readonly action: CharacterMemoryOperation['action'];
  readonly target: CharacterMemoryTarget;
  readonly status: 'applied' | 'duplicate';
};

export type CharacterMemoryPlanResult =
  | {
      readonly status: 'accepted';
      readonly after: CharacterMemoryStore;
      readonly appliedChanges: readonly CharacterMemoryAppliedChange[];
    }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'memory_entry_invalid'
        | 'memory_old_text_not_found'
        | 'memory_old_text_ambiguous'
        | 'memory_capacity_exceeded';
      readonly details: string;
    };

export function emptyCharacterMemoryStore(): CharacterMemoryStore {
  return Object.freeze({
    notes: Object.freeze([]),
    userProfile: Object.freeze([]),
  });
}

export function renderCharacterMemoryEntries(
  entries: readonly string[],
): string {
  return entries.join(characterMemoryEntrySeparator);
}

export function characterMemoryUsedChars(entries: readonly string[]): number {
  return renderCharacterMemoryEntries(entries).length;
}

export function planCharacterMemoryOperations(options: {
  readonly store: CharacterMemoryStore;
  readonly operations: readonly CharacterMemoryOperation[];
}): CharacterMemoryPlanResult {
  const working: Record<CharacterMemoryTarget, string[]> = {
    notes: [...options.store.notes],
    user_profile: [...options.store.userProfile],
  };
  const appliedChanges: CharacterMemoryAppliedChange[] = [];

  for (const operation of options.operations) {
    const entries = working[operation.target];

    if (operation.action === 'add') {
      const text = normalizedCharacterMemoryEntry(operation.text);

      if (text === undefined) {
        return invalidEntryRejection(operation.target);
      }

      if (entries.includes(text)) {
        appliedChanges.push(
          Object.freeze({
            action: 'add',
            target: operation.target,
            status: 'duplicate',
          }),
        );
        continue;
      }

      entries.push(text);
      appliedChanges.push(
        Object.freeze({
          action: 'add',
          target: operation.target,
          status: 'applied',
        }),
      );
      continue;
    }

    const selected = selectCharacterMemoryEntry(entries, operation.oldText);

    if (selected.status !== 'selected') {
      const detail =
        selected.status === 'not_found'
          ? `No ${operation.target} entry contains the given old_text.`
          : `old_text selects ${String(selected.matchCount)} ${operation.target} entries; use a longer unique substring.`;

      return Object.freeze({
        status: 'rejected',
        reason:
          selected.status === 'not_found'
            ? 'memory_old_text_not_found'
            : 'memory_old_text_ambiguous',
        details: detail,
      });
    }

    if (operation.action === 'remove') {
      entries.splice(selected.index, 1);
      appliedChanges.push(
        Object.freeze({
          action: 'remove',
          target: operation.target,
          status: 'applied',
        }),
      );
      continue;
    }

    const text = normalizedCharacterMemoryEntry(operation.text);

    if (text === undefined) {
      return invalidEntryRejection(operation.target);
    }

    // Replacing an entry with another entry's exact text would leave two
    // identical entries, and every old_text selecting one would then
    // select both: the store could never be repaired through the tool.
    // Collapsing onto the existing copy keeps entries unique by
    // construction.
    const duplicateIndex = entries.findIndex(
      (entry, index) => entry === text && index !== selected.index,
    );

    if (duplicateIndex === -1) {
      entries[selected.index] = text;
    } else {
      entries.splice(selected.index, 1);
    }

    appliedChanges.push(
      Object.freeze({
        action: 'replace',
        target: operation.target,
        status: duplicateIndex === -1 ? 'applied' : 'duplicate',
      }),
    );
  }

  for (const target of characterMemoryTargetValues) {
    const usedChars = characterMemoryUsedChars(working[target]);
    const capChars = characterMemoryCapChars[target];

    if (usedChars > capChars) {
      return Object.freeze({
        status: 'rejected',
        reason: 'memory_capacity_exceeded',
        details: `${target} would hold ${String(usedChars)}/${String(
          capChars,
        )} chars; compress or remove entries first.`,
      });
    }
  }

  return Object.freeze({
    status: 'accepted',
    after: Object.freeze({
      notes: Object.freeze([...working.notes]),
      userProfile: Object.freeze([...working.user_profile]),
    }),
    appliedChanges: Object.freeze(appliedChanges),
  });
}

export function encodeCharacterMemoryStoreDocument(
  document: CharacterMemoryStoreDocument,
): RuntimePluginJsonObject {
  return Object.freeze({
    kind: 'character_memory.store',
    formatVersion: characterMemoryStoreVersion,
    notes: Object.freeze([...document.store.notes]),
    userProfile: Object.freeze([...document.store.userProfile]),
    appliedRecords: Object.freeze(
      document.appliedRecords.map(encodeAppliedRecord),
    ),
  });
}

export function decodeCharacterMemoryStoreDocument(
  value: RuntimePluginJsonValue | undefined,
): CharacterMemoryStoreDocument {
  if (value === undefined) {
    return Object.freeze({
      store: emptyCharacterMemoryStore(),
      appliedRecords: Object.freeze([]),
    });
  }

  if (
    !isJsonObject(value) ||
    value['kind'] !== 'character_memory.store' ||
    value['formatVersion'] !== characterMemoryStoreVersion
  ) {
    throw new TypeError(
      'Stored character memory document is malformed or from an unsupported version.',
    );
  }

  const store = Object.freeze({
    notes: decodeEntryList(value['notes'], 'notes'),
    userProfile: decodeEntryList(value['userProfile'], 'userProfile'),
  });
  return Object.freeze({
    store,
    appliedRecords: decodeAppliedRecords(value['appliedRecords']),
  });
}

function decodeAppliedRecords(
  value: RuntimePluginJsonValue | undefined,
): readonly CharacterMemoryAppliedRecord[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  if (!Array.isArray(value)) {
    throw new TypeError(
      'Stored character memory appliedRecords must be an array.',
    );
  }

  return Object.freeze(value.map(decodeAppliedRecord));
}

function encodeAppliedRecord(
  record: CharacterMemoryAppliedRecord,
): RuntimePluginJsonObject {
  return Object.freeze({
    eventId: record.eventId,
    traceId: record.traceId,
    ...(record.toolCallId === undefined ? {} : {toolCallId: record.toolCallId}),
    createdAt: record.createdAt,
    inputDigest: record.inputDigest,
    output: record.output,
  });
}

function decodeAppliedRecord(
  value: RuntimePluginJsonValue,
): CharacterMemoryAppliedRecord {
  if (
    !isJsonObject(value) ||
    typeof value['eventId'] !== 'string' ||
    typeof value['traceId'] !== 'string' ||
    typeof value['createdAt'] !== 'string' ||
    typeof value['inputDigest'] !== 'string' ||
    !isJsonObject(value['output']) ||
    (value['toolCallId'] !== undefined &&
      typeof value['toolCallId'] !== 'string')
  ) {
    throw new TypeError(
      'Stored character memory idempotency record is malformed.',
    );
  }

  return Object.freeze({
    eventId: value['eventId'],
    traceId: value['traceId'],
    ...(value['toolCallId'] === undefined
      ? {}
      : {toolCallId: value['toolCallId']}),
    createdAt: value['createdAt'],
    inputDigest: value['inputDigest'],
    output: value['output'],
  });
}

function decodeEntryList(
  value: RuntimePluginJsonValue | undefined,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Stored character memory ${field} must be an array.`);
  }

  return Object.freeze(
    value.map(entry => {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new TypeError(
          `Stored character memory ${field} entries must be non-empty strings.`,
        );
      }

      return entry;
    }),
  );
}

type CharacterMemoryEntrySelection =
  | {readonly status: 'selected'; readonly index: number}
  | {readonly status: 'not_found'}
  | {readonly status: 'ambiguous'; readonly matchCount: number};

function selectCharacterMemoryEntry(
  entries: readonly string[],
  oldText: string,
): CharacterMemoryEntrySelection {
  const matches = entries
    .map((entry, index) => ({entry, index}))
    .filter(candidate => candidate.entry.includes(oldText));

  if (matches.length === 0) {
    return Object.freeze({status: 'not_found'});
  }

  if (matches.length > 1) {
    return Object.freeze({status: 'ambiguous', matchCount: matches.length});
  }

  return Object.freeze({status: 'selected', index: matches[0]?.index ?? 0});
}

/**
 * An entry must survive the trusted frame that renders it, so the write
 * boundary refuses exactly what the render boundary refuses; storing more
 * would drop the whole snapshot on the next launch, with the offending
 * text invisible to the model that would have to remove it.
 */
function normalizedCharacterMemoryEntry(text: string): string | undefined {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

  if (
    normalized.length === 0 ||
    containsForbiddenControlCharacter(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

function invalidEntryRejection(
  target: CharacterMemoryTarget,
): CharacterMemoryPlanResult {
  return Object.freeze({
    status: 'rejected',
    reason: 'memory_entry_invalid',
    details: `${target} entry text must be non-empty and free of control characters.`,
  });
}

function isJsonObject(
  value: RuntimePluginJsonValue | undefined,
): value is RuntimePluginJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
