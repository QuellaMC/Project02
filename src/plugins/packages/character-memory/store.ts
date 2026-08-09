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

export type CharacterMemoryLastApplied = {
  readonly version: typeof characterMemoryStoreVersion;
  readonly eventId: string;
  readonly traceId: string;
  readonly toolCallId?: string;
  readonly createdAt: string;
  readonly inputDigest: string;
  readonly output: RuntimePluginJsonObject;
};

export type CharacterMemoryStoreDocument = {
  readonly store: CharacterMemoryStore;
  readonly lastApplied?: CharacterMemoryLastApplied;
};

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

    entries[selected.index] = text;
    appliedChanges.push(
      Object.freeze({
        action: 'replace',
        target: operation.target,
        status: 'applied',
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
    ...(document.lastApplied === undefined
      ? {}
      : {lastApplied: encodeLastApplied(document.lastApplied)}),
  });
}

export function decodeCharacterMemoryStoreDocument(
  value: RuntimePluginJsonValue | undefined,
): CharacterMemoryStoreDocument {
  if (value === undefined) {
    return Object.freeze({store: emptyCharacterMemoryStore()});
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
  const lastApplied = value['lastApplied'];

  return Object.freeze({
    store,
    ...(lastApplied === undefined
      ? {}
      : {lastApplied: decodeLastApplied(lastApplied)}),
  });
}

function encodeLastApplied(
  lastApplied: CharacterMemoryLastApplied,
): RuntimePluginJsonObject {
  return Object.freeze({
    version: lastApplied.version,
    eventId: lastApplied.eventId,
    traceId: lastApplied.traceId,
    ...(lastApplied.toolCallId === undefined
      ? {}
      : {toolCallId: lastApplied.toolCallId}),
    createdAt: lastApplied.createdAt,
    inputDigest: lastApplied.inputDigest,
    output: lastApplied.output,
  });
}

function decodeLastApplied(
  value: RuntimePluginJsonValue,
): CharacterMemoryLastApplied {
  if (
    !isJsonObject(value) ||
    value['version'] !== characterMemoryStoreVersion ||
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
    version: characterMemoryStoreVersion,
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

/** Newlines are the only control characters a stored entry may carry. */
function normalizedCharacterMemoryEntry(text: string): string | undefined {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;

    if ((codePoint < 0x20 && codePoint !== 0x0a) || codePoint === 0x7f) {
      return undefined;
    }
  }

  return normalized.length === 0 ? undefined : normalized;
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
