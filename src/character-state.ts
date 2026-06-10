import type { RuntimeEventIdentity } from './runtime-event.ts';

export const characterRuntimeStateVersion = 'mvp-006.character_state.v1';

export const characterMoodValues = Object.freeze([
  'steady',
  'curious',
  'concerned',
  'playful',
  'tired'
] as const);
export const characterEnergyValues = Object.freeze([
  'low',
  'medium',
  'high'
] as const);
export const characterAttentionValues = Object.freeze([
  'present',
  'focused',
  'distracted'
] as const);
export const characterCurrentActivityValues = Object.freeze([
  'idle',
  'chatting',
  'reflecting'
] as const);
export const characterSocialOrientationValues = Object.freeze([
  'open',
  'supportive',
  'reserved'
] as const);

export type CharacterMood = (typeof characterMoodValues)[number];
export type CharacterEnergy = (typeof characterEnergyValues)[number];
export type CharacterAttention = (typeof characterAttentionValues)[number];
export type CharacterCurrentActivity =
  (typeof characterCurrentActivityValues)[number];
export type CharacterSocialOrientation =
  (typeof characterSocialOrientationValues)[number];

export type LivingStateCurrent = {
  readonly mood: CharacterMood;
  readonly energy: CharacterEnergy;
  readonly attention: CharacterAttention;
  readonly currentActivity: CharacterCurrentActivity;
  readonly socialOrientation: CharacterSocialOrientation;
};

export type LivingStateBrief = {
  readonly text: string;
  readonly current: LivingStateCurrent;
};

export type CharacterRuntimeState = {
  readonly version: typeof characterRuntimeStateVersion;
  readonly current: LivingStateCurrent;
};

export type CharacterStatePatch = Partial<LivingStateCurrent>;

export type CharacterStatePatchRejectionReason =
  | 'malformed_state_patch'
  | 'unsupported_state_field'
  | 'invalid_state_value';

export type CharacterStatePatchRejection = {
  readonly reason: CharacterStatePatchRejectionReason;
  readonly details: string;
};

export type CharacterStateAppliedChange = {
  readonly field: keyof LivingStateCurrent;
  readonly before: string;
  readonly after: string;
};

export type AcceptedCharacterStatePatchResult = {
  readonly status: 'accepted';
  readonly patch: CharacterStatePatch;
  readonly before: CharacterRuntimeState;
  readonly after: CharacterRuntimeState;
  readonly appliedChanges: readonly CharacterStateAppliedChange[];
};

export type RejectedCharacterStatePatchResult = {
  readonly status: 'rejected';
  readonly patchInput: Readonly<Record<string, unknown>>;
  readonly before: CharacterRuntimeState;
  readonly rejection: CharacterStatePatchRejection;
};

export type CharacterStatePatchResult =
  | AcceptedCharacterStatePatchResult
  | RejectedCharacterStatePatchResult;

export type CharacterStatePatchSnapshot = RuntimeEventIdentity & {
  readonly kind: 'character_state_patch_snapshot';
  readonly sessionId: string;
  readonly result: CharacterStatePatchResult;
};

export type CreateCharacterStatePatchSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly result: CharacterStatePatchResult;
};

export type CharacterStateStore = {
  readCurrentState(): CharacterRuntimeState;
  writeCurrentState(state: CharacterRuntimeState): CharacterRuntimeState;
};

export function createDefaultCharacterRuntimeState(): CharacterRuntimeState {
  return freezeCharacterRuntimeState({
    version: characterRuntimeStateVersion,
    current: {
      mood: 'steady',
      energy: 'medium',
      attention: 'present',
      currentActivity: 'idle',
      socialOrientation: 'open'
    }
  });
}

export function createLivingStateBrief(
  state: CharacterRuntimeState
): LivingStateBrief {
  const frozenState = freezeCharacterRuntimeState(state);
  const current = frozenState.current;

  return Object.freeze({
    text:
      `mood=${current.mood}; energy=${current.energy}; attention=${current.attention}; ` +
      `activity=${current.currentActivity}; social=${current.socialOrientation}`,
    current
  } satisfies LivingStateBrief);
}

export function planCharacterStatePatch(options: {
  readonly before: CharacterRuntimeState;
  readonly patchInput: Readonly<Record<string, unknown>>;
}): CharacterStatePatchResult {
  const before = freezeCharacterRuntimeState(options.before);
  const parsedPatch = parseCharacterStatePatch(options.patchInput);

  if (parsedPatch.status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      patchInput: freezeUnknownRecord(options.patchInput),
      before,
      rejection: parsedPatch.rejection
    } satisfies RejectedCharacterStatePatchResult);
  }

  const after = createCharacterRuntimeState({
    ...before.current,
    ...parsedPatch.patch
  });
  const appliedChanges = createAppliedChanges(before.current, after.current);

  return Object.freeze({
    status: 'accepted',
    patch: freezeCharacterStatePatch(parsedPatch.patch),
    before,
    after,
    appliedChanges
  } satisfies AcceptedCharacterStatePatchResult);
}

export function createCharacterStatePatchSnapshot(
  options: CreateCharacterStatePatchSnapshotOptions
): CharacterStatePatchSnapshot {
  return Object.freeze({
    eventId: options.eventId,
    traceId: options.traceId,
    createdAt: options.createdAt,
    kind: 'character_state_patch_snapshot',
    sessionId: options.sessionId,
    result: freezeCharacterStatePatchResult(options.result)
  } satisfies CharacterStatePatchSnapshot);
}

export function createInMemoryCharacterStateStore(
  initialState: CharacterRuntimeState = createDefaultCharacterRuntimeState()
): CharacterStateStore {
  let currentState = freezeCharacterRuntimeState(initialState);

  return Object.freeze({
    readCurrentState() {
      return freezeCharacterRuntimeState(currentState);
    },
    writeCurrentState(state) {
      currentState = freezeCharacterRuntimeState(state);
      return currentState;
    }
  } satisfies CharacterStateStore);
}

export function encodeCharacterRuntimeState(
  state: CharacterRuntimeState
): string {
  return JSON.stringify(freezeCharacterRuntimeState(state));
}

export function decodeCharacterRuntimeState(
  value: unknown,
  fail: (field: string) => never
): CharacterRuntimeState {
  if (!isJsonRecord(value)) {
    fail('characterState');
  }

  const version = value['version'];

  if (version !== characterRuntimeStateVersion) {
    fail('characterState.version');
  }

  const current = value['current'];

  if (!isJsonRecord(current)) {
    fail('characterState.current');
  }

  return createCharacterRuntimeState({
    mood: requiredEnumValue(current, 'mood', characterMoodValues, fail),
    energy: requiredEnumValue(current, 'energy', characterEnergyValues, fail),
    attention: requiredEnumValue(
      current,
      'attention',
      characterAttentionValues,
      fail
    ),
    currentActivity: requiredEnumValue(
      current,
      'currentActivity',
      characterCurrentActivityValues,
      fail
    ),
    socialOrientation: requiredEnumValue(
      current,
      'socialOrientation',
      characterSocialOrientationValues,
      fail
    )
  });
}

export function freezeCharacterRuntimeState(
  state: CharacterRuntimeState
): CharacterRuntimeState {
  return createCharacterRuntimeState(state.current);
}

export function characterRuntimeStatesEqual(
  left: CharacterRuntimeState,
  right: CharacterRuntimeState
): boolean {
  return (
    left.current.mood === right.current.mood &&
    left.current.energy === right.current.energy &&
    left.current.attention === right.current.attention &&
    left.current.currentActivity === right.current.currentActivity &&
    left.current.socialOrientation === right.current.socialOrientation
  );
}

export function freezeCharacterStatePatchResult(
  result: CharacterStatePatchResult
): CharacterStatePatchResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      patch: freezeCharacterStatePatch(result.patch),
      before: freezeCharacterRuntimeState(result.before),
      after: freezeCharacterRuntimeState(result.after),
      appliedChanges: freezeAppliedChanges(result.appliedChanges)
    } satisfies AcceptedCharacterStatePatchResult);
  }

  return Object.freeze({
    status: 'rejected',
    patchInput: freezeUnknownRecord(result.patchInput),
    before: freezeCharacterRuntimeState(result.before),
    rejection: freezeCharacterStatePatchRejection(result.rejection)
  } satisfies RejectedCharacterStatePatchResult);
}

function createCharacterRuntimeState(
  current: LivingStateCurrent
): CharacterRuntimeState {
  return Object.freeze({
    version: characterRuntimeStateVersion,
    current: Object.freeze({
      mood: current.mood,
      energy: current.energy,
      attention: current.attention,
      currentActivity: current.currentActivity,
      socialOrientation: current.socialOrientation
    } satisfies LivingStateCurrent)
  } satisfies CharacterRuntimeState);
}

type ParsedPatchResult =
  | {
      readonly status: 'accepted';
      readonly patch: CharacterStatePatch;
    }
  | {
      readonly status: 'rejected';
      readonly rejection: CharacterStatePatchRejection;
    };

function parseCharacterStatePatch(
  patchInput: Readonly<Record<string, unknown>>
): ParsedPatchResult {
  let patch: CharacterStatePatch = Object.freeze({});

  for (const [field, value] of Object.entries(patchInput)) {
    if (!isCharacterStateField(field)) {
      return rejectPatch(
        'unsupported_state_field',
        `character_state.patch field "${field}" is not supported.`
      );
    }

    if (typeof value !== 'string') {
      return rejectPatch(
        'malformed_state_patch',
        `character_state.patch field "${field}" must be a string.`
      );
    }

    const fieldPatch = parseCharacterStateFieldPatch(field, value);

    if (fieldPatch === undefined) {
      return rejectPatch(
        'invalid_state_value',
        `character_state.patch field "${field}" has unsupported value "${value}".`
      );
    }

    patch = {
      ...patch,
      ...fieldPatch
    };
  }

  return Object.freeze({
    status: 'accepted',
    patch: freezeCharacterStatePatch(patch)
  } satisfies ParsedPatchResult);
}

function rejectPatch(
  reason: CharacterStatePatchRejectionReason,
  details: string
): ParsedPatchResult {
  return Object.freeze({
    status: 'rejected',
    rejection: Object.freeze({
      reason,
      details
    } satisfies CharacterStatePatchRejection)
  } satisfies ParsedPatchResult);
}

function isCharacterStateField(
  field: string
): field is keyof LivingStateCurrent {
  return (
    field === 'mood' ||
    field === 'energy' ||
    field === 'attention' ||
    field === 'currentActivity' ||
    field === 'socialOrientation'
  );
}

function parseCharacterStateFieldPatch(
  field: keyof LivingStateCurrent,
  value: string
): CharacterStatePatch | undefined {
  if (field === 'mood' && isCharacterMood(value)) {
    return { mood: value };
  }

  if (field === 'energy' && isCharacterEnergy(value)) {
    return { energy: value };
  }

  if (field === 'attention' && isCharacterAttention(value)) {
    return { attention: value };
  }

  if (
    field === 'currentActivity' &&
    isCharacterCurrentActivity(value)
  ) {
    return { currentActivity: value };
  }

  if (
    field === 'socialOrientation' &&
    isCharacterSocialOrientation(value)
  ) {
    return { socialOrientation: value };
  }

  return undefined;
}

function isCharacterMood(value: string): value is CharacterMood {
  return characterMoodValues.includes(value as CharacterMood);
}

function isCharacterEnergy(value: string): value is CharacterEnergy {
  return characterEnergyValues.includes(value as CharacterEnergy);
}

function isCharacterAttention(value: string): value is CharacterAttention {
  return characterAttentionValues.includes(value as CharacterAttention);
}

function isCharacterCurrentActivity(
  value: string
): value is CharacterCurrentActivity {
  return characterCurrentActivityValues.includes(
    value as CharacterCurrentActivity
  );
}

function isCharacterSocialOrientation(
  value: string
): value is CharacterSocialOrientation {
  return characterSocialOrientationValues.includes(
    value as CharacterSocialOrientation
  );
}

function freezeCharacterStatePatch(
  patch: CharacterStatePatch
): CharacterStatePatch {
  return Object.freeze({
    ...(patch.mood === undefined ? {} : { mood: patch.mood }),
    ...(patch.energy === undefined ? {} : { energy: patch.energy }),
    ...(patch.attention === undefined ? {} : { attention: patch.attention }),
    ...(patch.currentActivity === undefined
      ? {}
      : { currentActivity: patch.currentActivity }),
    ...(patch.socialOrientation === undefined
      ? {}
      : { socialOrientation: patch.socialOrientation })
  } satisfies CharacterStatePatch);
}

function createAppliedChanges(
  before: LivingStateCurrent,
  after: LivingStateCurrent
): readonly CharacterStateAppliedChange[] {
  const changes: CharacterStateAppliedChange[] = [];

  appendAppliedChange(changes, 'mood', before.mood, after.mood);
  appendAppliedChange(changes, 'energy', before.energy, after.energy);
  appendAppliedChange(changes, 'attention', before.attention, after.attention);
  appendAppliedChange(
    changes,
    'currentActivity',
    before.currentActivity,
    after.currentActivity
  );
  appendAppliedChange(
    changes,
    'socialOrientation',
    before.socialOrientation,
    after.socialOrientation
  );

  return freezeAppliedChanges(changes);
}

function appendAppliedChange(
  changes: CharacterStateAppliedChange[],
  field: keyof LivingStateCurrent,
  before: string,
  after: string
): void {
  if (before === after) {
    return;
  }

  changes.push(
    Object.freeze({
      field,
      before,
      after
    } satisfies CharacterStateAppliedChange)
  );
}

function freezeAppliedChanges(
  changes: readonly CharacterStateAppliedChange[]
): readonly CharacterStateAppliedChange[] {
  return Object.freeze(
    changes.map((change) =>
      Object.freeze({
        field: change.field,
        before: change.before,
        after: change.after
      } satisfies CharacterStateAppliedChange)
    )
  );
}

function freezeCharacterStatePatchRejection(
  rejection: CharacterStatePatchRejection
): CharacterStatePatchRejection {
  return Object.freeze({
    reason: rejection.reason,
    details: rejection.details
  } satisfies CharacterStatePatchRejection);
}

function freezeUnknownRecord(
  record: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    snapshot[key] = freezeUnknownValue(value);
  }

  return Object.freeze(snapshot);
}

function freezeUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeUnknownValue));
  }

  if (isJsonRecord(value)) {
    return freezeUnknownRecord(value);
  }

  return value;
}

function requiredEnumValue<const T extends string>(
  record: Readonly<Record<string, unknown>>,
  field: string,
  allowedValues: readonly T[],
  fail: (field: string) => never
): T {
  const value = record[field];

  if (typeof value === 'string' && allowedValues.includes(value as T)) {
    return value as T;
  }

  fail(`characterState.current.${field}`);
}

function isJsonRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
