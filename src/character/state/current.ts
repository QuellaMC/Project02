import {
  ACTIVE_INCIDENT_INTERRUPT_POLICIES,
  ACTIVE_INCIDENT_RESUME_POLICIES,
  ACTIVE_INCIDENT_TYPES,
  INCIDENT_COMPLETION,
  USER_MESSAGE,
  ContractValidationError,
  validateNormalizedIncidentCompletionEvent,
  validateNormalizedUserMessageEvent,
  type RuntimeEvent
} from '../../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../../runtime/schema.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireOneOf,
  requireOptionalString,
  requireString,
  validateIso8601Timestamp,
  validateRemainingSeconds
} from '../../runtime/validation.ts';

export type RuntimeReadEventType = typeof USER_MESSAGE | typeof INCIDENT_COMPLETION;

export type CurrentCharacterStateRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  user_id?: string;
  conversation_id?: string;
};

export type ActiveIncidentRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: RuntimeReadEventType;
  user_id?: string;
  conversation_id?: string;
};

export type InterruptedIncidentRequest = CurrentCharacterStateRequest;

export type CharacterRuntimeStateSnapshot = {
  schema_version: SchemaVersion;
  character_id: string;
  living_state: {
    current_activity: string;
    mood: string;
    toward_user: string;
  };
  updated_at: string;
  source_event_ids: string[];
};

export type LivingStateBrief = {
  character_id: string;
  current_activity: string;
  mood: string;
  toward_user: string;
  updated_at: string;
  source_event_ids: string[];
};

export type ActiveIncidentSnapshot = {
  schema_version: SchemaVersion;
  incident_id: string;
  type: (typeof ACTIVE_INCIDENT_TYPES)[number];
  status: 'active';
  title: string;
  started_at?: string;
  expected_end_at?: string;
  remaining_seconds?: number;
  interrupt_policy: (typeof ACTIVE_INCIDENT_INTERRUPT_POLICIES)[number];
  resume_policy: (typeof ACTIVE_INCIDENT_RESUME_POLICIES)[number];
  source_event_ids: string[];
};

export type InterruptedIncidentSnapshot = Omit<ActiveIncidentSnapshot, 'status'> & {
  status: 'interrupted';
  interrupted_at: string;
  interrupt_policy: 'interruptible';
};

export type ActiveIncidentBrief = Omit<
  ActiveIncidentSnapshot,
  'schema_version' | 'status'
>;

export type InterruptedIncidentBrief = Omit<
  InterruptedIncidentSnapshot,
  'schema_version' | 'status'
>;

export type CurrentCharacterStateSource = {
  readCurrentState: (request: CurrentCharacterStateRequest) => unknown;
};

export type ActiveIncidentSource = {
  readActiveIncident: (request: ActiveIncidentRequest) => unknown;
};

export type InterruptedIncidentSource = {
  readInterruptedIncident: (request: InterruptedIncidentRequest) => unknown;
};

export function buildCurrentCharacterStateRequest(
  event: RuntimeEvent
): CurrentCharacterStateRequest {
  return buildUserMessageReadRequest(event, 'CurrentCharacterStateRequest');
}

export function validateCurrentCharacterStateRequest(
  request: unknown
): CurrentCharacterStateRequest {
  return validateUserMessageReadRequest(request, 'CurrentCharacterStateRequest');
}

export function buildActiveIncidentRequest(event: RuntimeEvent): ActiveIncidentRequest {
  const normalizedEvent = validateActiveIncidentRequestEvent(
    event,
    'ActiveIncidentRequest.event'
  );
  const request: ActiveIncidentRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: normalizedEvent.trace_id,
    event_id: normalizedEvent.event_id,
    event_type: normalizedEvent.type
  };
  copyOptionalIdentityFields(request, normalizedEvent.payload);
  return validateActiveIncidentRequest(request);
}

export function validateActiveIncidentRequest(request: unknown): ActiveIncidentRequest {
  return validateRuntimeEventReadRequest(request, 'ActiveIncidentRequest', [
    INCIDENT_COMPLETION,
    USER_MESSAGE
  ]);
}

export function buildInterruptedIncidentRequest(
  event: RuntimeEvent
): InterruptedIncidentRequest {
  return buildUserMessageReadRequest(event, 'InterruptedIncidentRequest');
}

export function validateInterruptedIncidentRequest(
  request: unknown
): InterruptedIncidentRequest {
  return validateUserMessageReadRequest(request, 'InterruptedIncidentRequest');
}

export function buildLivingStateBrief(snapshot: unknown): LivingStateBrief {
  const validatedSnapshot = validateCurrentCharacterStateSnapshot(snapshot);
  return validateLivingStateBrief({
    character_id: validatedSnapshot.character_id,
    current_activity: validatedSnapshot.living_state.current_activity,
    mood: validatedSnapshot.living_state.mood,
    toward_user: validatedSnapshot.living_state.toward_user,
    updated_at: validatedSnapshot.updated_at,
    source_event_ids: [...validatedSnapshot.source_event_ids]
  });
}

export function validateCurrentCharacterStateSnapshot(
  snapshot: unknown
): CharacterRuntimeStateSnapshot {
  const snapshotRecord = asRecord(snapshot, 'CharacterRuntimeStateSnapshot');
  rejectExtraKeys(
    snapshotRecord,
    ['schema_version', 'character_id', 'living_state', 'updated_at', 'source_event_ids'],
    'CharacterRuntimeStateSnapshot'
  );
  const livingState = asRecord(
    getOwnField(snapshotRecord, 'living_state'),
    'CharacterRuntimeStateSnapshot.living_state'
  );
  rejectExtraKeys(
    livingState,
    ['current_activity', 'mood', 'toward_user'],
    'CharacterRuntimeStateSnapshot.living_state'
  );
  return {
    schema_version: requireLiteral(
      getOwnField(snapshotRecord, 'schema_version'),
      SCHEMA_VERSION,
      'CharacterRuntimeStateSnapshot.schema_version'
    ),
    character_id: requireString(
      getOwnField(snapshotRecord, 'character_id'),
      'CharacterRuntimeStateSnapshot.character_id'
    ),
    living_state: {
      current_activity: requireString(
        getOwnField(livingState, 'current_activity'),
        'CharacterRuntimeStateSnapshot.living_state.current_activity'
      ),
      mood: requireString(
        getOwnField(livingState, 'mood'),
        'CharacterRuntimeStateSnapshot.living_state.mood'
      ),
      toward_user: requireString(
        getOwnField(livingState, 'toward_user'),
        'CharacterRuntimeStateSnapshot.living_state.toward_user'
      )
    },
    updated_at: validateIso8601Timestamp(
      getOwnField(snapshotRecord, 'updated_at'),
      'CharacterRuntimeStateSnapshot.updated_at'
    ),
    source_event_ids: validateSourceEventIds(
      getOwnField(snapshotRecord, 'source_event_ids'),
      'CharacterRuntimeStateSnapshot.source_event_ids'
    )
  };
}

export function validateLivingStateBrief(brief: unknown): LivingStateBrief {
  const briefRecord = asRecord(brief, 'living_state_brief');
  rejectExtraKeys(
    briefRecord,
    ['character_id', 'current_activity', 'mood', 'toward_user', 'updated_at', 'source_event_ids'],
    'living_state_brief'
  );
  return {
    character_id: requireString(
      getOwnField(briefRecord, 'character_id'),
      'living_state_brief.character_id'
    ),
    current_activity: requireString(
      getOwnField(briefRecord, 'current_activity'),
      'living_state_brief.current_activity'
    ),
    mood: requireString(getOwnField(briefRecord, 'mood'), 'living_state_brief.mood'),
    toward_user: requireString(
      getOwnField(briefRecord, 'toward_user'),
      'living_state_brief.toward_user'
    ),
    updated_at: validateIso8601Timestamp(
      getOwnField(briefRecord, 'updated_at'),
      'living_state_brief.updated_at'
    ),
    source_event_ids: validateSourceEventIds(
      getOwnField(briefRecord, 'source_event_ids'),
      'living_state_brief.source_event_ids'
    )
  };
}

export function validateLivingStateBriefForEvent(
  brief: unknown,
  { eventId }: { eventId: string }
): LivingStateBrief {
  const validatedBrief = validateLivingStateBrief(brief);
  const currentEventId = requireString(eventId, 'event_id');
  if (validatedBrief.source_event_ids.includes(currentEventId)) {
    throw new ContractValidationError(
      'living_state_brief.source_event_ids must not include current event_id.'
    );
  }
  return validatedBrief;
}

export function buildActiveIncidentBrief(snapshot: unknown): ActiveIncidentBrief {
  const validatedSnapshot = validateActiveIncidentSnapshot(snapshot);
  const brief: ActiveIncidentBrief = {
    incident_id: validatedSnapshot.incident_id,
    type: validatedSnapshot.type,
    title: validatedSnapshot.title,
    interrupt_policy: validatedSnapshot.interrupt_policy,
    resume_policy: validatedSnapshot.resume_policy,
    source_event_ids: [...validatedSnapshot.source_event_ids]
  };
  copyOptionalIncidentTimeFields(brief, validatedSnapshot);
  if (validatedSnapshot.remaining_seconds !== undefined) {
    brief.remaining_seconds = validatedSnapshot.remaining_seconds;
  }
  return validateActiveIncidentBrief(brief);
}

export function buildInterruptedIncidentBrief(
  snapshot: unknown
): InterruptedIncidentBrief {
  const validatedSnapshot = validateInterruptedIncidentSnapshot(snapshot);
  const brief: InterruptedIncidentBrief = {
    incident_id: validatedSnapshot.incident_id,
    type: validatedSnapshot.type,
    title: validatedSnapshot.title,
    interrupt_policy: validatedSnapshot.interrupt_policy,
    resume_policy: validatedSnapshot.resume_policy,
    interrupted_at: validatedSnapshot.interrupted_at,
    source_event_ids: [...validatedSnapshot.source_event_ids]
  };
  copyOptionalIncidentTimeFields(brief, validatedSnapshot);
  if (validatedSnapshot.remaining_seconds !== undefined) {
    brief.remaining_seconds = validatedSnapshot.remaining_seconds;
  }
  return validateInterruptedIncidentBrief(brief);
}

export function validateActiveIncidentSnapshot(
  snapshot: unknown
): ActiveIncidentSnapshot {
  const snapshotRecord = asRecord(snapshot, 'ActiveIncidentSnapshot');
  rejectExtraKeys(
    snapshotRecord,
    [
      'schema_version',
      'incident_id',
      'type',
      'status',
      'title',
      'started_at',
      'expected_end_at',
      'remaining_seconds',
      'interrupt_policy',
      'resume_policy',
      'source_event_ids'
    ],
    'ActiveIncidentSnapshot'
  );
  const normalized: ActiveIncidentSnapshot = {
    schema_version: requireLiteral(
      getOwnField(snapshotRecord, 'schema_version'),
      SCHEMA_VERSION,
      'ActiveIncidentSnapshot.schema_version'
    ),
    incident_id: requireString(
      getOwnField(snapshotRecord, 'incident_id'),
      'ActiveIncidentSnapshot.incident_id'
    ),
    type: requireOneOf(
      getOwnField(snapshotRecord, 'type'),
      ACTIVE_INCIDENT_TYPES,
      'ActiveIncidentSnapshot.type'
    ),
    status: requireLiteral(
      getOwnField(snapshotRecord, 'status'),
      'active',
      'ActiveIncidentSnapshot.status'
    ),
    title: requireString(getOwnField(snapshotRecord, 'title'), 'ActiveIncidentSnapshot.title'),
    interrupt_policy: requireOneOf(
      getOwnField(snapshotRecord, 'interrupt_policy'),
      ACTIVE_INCIDENT_INTERRUPT_POLICIES,
      'ActiveIncidentSnapshot.interrupt_policy'
    ),
    resume_policy: requireOneOf(
      getOwnField(snapshotRecord, 'resume_policy'),
      ACTIVE_INCIDENT_RESUME_POLICIES,
      'ActiveIncidentSnapshot.resume_policy'
    ),
    source_event_ids: validateNonEmptySourceEventIds(
      getOwnField(snapshotRecord, 'source_event_ids'),
      'ActiveIncidentSnapshot.source_event_ids'
    )
  };
  addOptionalIncidentSnapshotFields(normalized, snapshotRecord, 'ActiveIncidentSnapshot');
  return normalized;
}

export function validateInterruptedIncidentSnapshot(
  snapshot: unknown
): InterruptedIncidentSnapshot {
  const snapshotRecord = asRecord(snapshot, 'InterruptedIncidentSnapshot');
  rejectExtraKeys(
    snapshotRecord,
    [
      'schema_version',
      'incident_id',
      'type',
      'status',
      'title',
      'started_at',
      'expected_end_at',
      'remaining_seconds',
      'interrupt_policy',
      'resume_policy',
      'interrupted_at',
      'source_event_ids'
    ],
    'InterruptedIncidentSnapshot'
  );
  const normalized: InterruptedIncidentSnapshot = {
    schema_version: requireLiteral(
      getOwnField(snapshotRecord, 'schema_version'),
      SCHEMA_VERSION,
      'InterruptedIncidentSnapshot.schema_version'
    ),
    incident_id: requireString(
      getOwnField(snapshotRecord, 'incident_id'),
      'InterruptedIncidentSnapshot.incident_id'
    ),
    type: requireOneOf(
      getOwnField(snapshotRecord, 'type'),
      ACTIVE_INCIDENT_TYPES,
      'InterruptedIncidentSnapshot.type'
    ),
    status: requireLiteral(
      getOwnField(snapshotRecord, 'status'),
      'interrupted',
      'InterruptedIncidentSnapshot.status'
    ),
    title: requireString(
      getOwnField(snapshotRecord, 'title'),
      'InterruptedIncidentSnapshot.title'
    ),
    interrupt_policy: requireLiteral(
      getOwnField(snapshotRecord, 'interrupt_policy'),
      'interruptible',
      'InterruptedIncidentSnapshot.interrupt_policy'
    ),
    resume_policy: requireOneOf(
      getOwnField(snapshotRecord, 'resume_policy'),
      ACTIVE_INCIDENT_RESUME_POLICIES,
      'InterruptedIncidentSnapshot.resume_policy'
    ),
    interrupted_at: validateIso8601Timestamp(
      getOwnField(snapshotRecord, 'interrupted_at'),
      'InterruptedIncidentSnapshot.interrupted_at'
    ),
    source_event_ids: validateNonEmptySourceEventIds(
      getOwnField(snapshotRecord, 'source_event_ids'),
      'InterruptedIncidentSnapshot.source_event_ids'
    )
  };
  addOptionalIncidentSnapshotFields(normalized, snapshotRecord, 'InterruptedIncidentSnapshot');
  return normalized;
}

export function validateActiveIncidentBrief(brief: unknown): ActiveIncidentBrief {
  const briefRecord = asRecord(brief, 'active_incident');
  rejectExtraKeys(
    briefRecord,
    [
      'incident_id',
      'type',
      'title',
      'started_at',
      'expected_end_at',
      'remaining_seconds',
      'interrupt_policy',
      'resume_policy',
      'source_event_ids'
    ],
    'active_incident'
  );
  const normalized: ActiveIncidentBrief = {
    incident_id: requireString(getOwnField(briefRecord, 'incident_id'), 'active_incident.incident_id'),
    type: requireOneOf(getOwnField(briefRecord, 'type'), ACTIVE_INCIDENT_TYPES, 'active_incident.type'),
    title: requireString(getOwnField(briefRecord, 'title'), 'active_incident.title'),
    interrupt_policy: requireOneOf(
      getOwnField(briefRecord, 'interrupt_policy'),
      ACTIVE_INCIDENT_INTERRUPT_POLICIES,
      'active_incident.interrupt_policy'
    ),
    resume_policy: requireOneOf(
      getOwnField(briefRecord, 'resume_policy'),
      ACTIVE_INCIDENT_RESUME_POLICIES,
      'active_incident.resume_policy'
    ),
    source_event_ids: validateNonEmptySourceEventIds(
      getOwnField(briefRecord, 'source_event_ids'),
      'active_incident.source_event_ids'
    )
  };
  addOptionalIncidentBriefFields(normalized, briefRecord, 'active_incident');
  return normalized;
}

export function validateInterruptedIncidentBrief(
  brief: unknown
): InterruptedIncidentBrief {
  const briefRecord = asRecord(brief, 'interrupted_incident');
  rejectExtraKeys(
    briefRecord,
    [
      'incident_id',
      'type',
      'title',
      'started_at',
      'expected_end_at',
      'remaining_seconds',
      'interrupt_policy',
      'resume_policy',
      'interrupted_at',
      'source_event_ids'
    ],
    'interrupted_incident'
  );
  const normalized: InterruptedIncidentBrief = {
    incident_id: requireString(
      getOwnField(briefRecord, 'incident_id'),
      'interrupted_incident.incident_id'
    ),
    type: requireOneOf(
      getOwnField(briefRecord, 'type'),
      ACTIVE_INCIDENT_TYPES,
      'interrupted_incident.type'
    ),
    title: requireString(getOwnField(briefRecord, 'title'), 'interrupted_incident.title'),
    interrupt_policy: requireLiteral(
      getOwnField(briefRecord, 'interrupt_policy'),
      'interruptible',
      'interrupted_incident.interrupt_policy'
    ),
    resume_policy: requireOneOf(
      getOwnField(briefRecord, 'resume_policy'),
      ACTIVE_INCIDENT_RESUME_POLICIES,
      'interrupted_incident.resume_policy'
    ),
    interrupted_at: validateIso8601Timestamp(
      getOwnField(briefRecord, 'interrupted_at'),
      'interrupted_incident.interrupted_at'
    ),
    source_event_ids: validateNonEmptySourceEventIds(
      getOwnField(briefRecord, 'source_event_ids'),
      'interrupted_incident.source_event_ids'
    )
  };
  addOptionalIncidentBriefFields(normalized, briefRecord, 'interrupted_incident');
  return normalized;
}

export function validateActiveIncidentBriefForEvent(
  brief: unknown,
  { eventId }: { eventId: string }
): ActiveIncidentBrief {
  const validatedBrief = validateActiveIncidentBrief(brief);
  const currentEventId = requireString(eventId, 'event_id');
  if (validatedBrief.source_event_ids.includes(currentEventId)) {
    throw new ContractValidationError(
      'active_incident.source_event_ids must not include current event_id.'
    );
  }
  return validatedBrief;
}

export function validateInterruptedIncidentBriefForEvent(
  brief: unknown,
  { eventId }: { eventId: string }
): InterruptedIncidentBrief {
  const currentEventId = requireString(eventId, 'event_id');
  const validatedBrief = validateInterruptedIncidentBrief(brief);
  if (!validatedBrief.source_event_ids.includes(currentEventId)) {
    throw new ContractValidationError(
      'interrupted_incident.source_event_ids must include current event_id.'
    );
  }
  return validatedBrief;
}

function buildUserMessageReadRequest(
  event: RuntimeEvent,
  requestName: string
): CurrentCharacterStateRequest {
  const normalizedEvent = validateNormalizedUserMessageEvent(
    event,
    `${requestName}.event`
  );
  const request: CurrentCharacterStateRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: normalizedEvent.trace_id,
    event_id: normalizedEvent.event_id,
    event_type: normalizedEvent.type
  };
  copyOptionalIdentityFields(request, normalizedEvent.payload);
  return validateUserMessageReadRequest(request, requestName);
}

function validateUserMessageReadRequest(
  request: unknown,
  requestName: string
): CurrentCharacterStateRequest {
  return validateRuntimeEventReadRequest(request, requestName, [USER_MESSAGE]);
}

function validateRuntimeEventReadRequest<EventType extends RuntimeReadEventType>(
  request: unknown,
  requestName: string,
  allowedEventTypes: readonly EventType[]
): ActiveIncidentRequest & { event_type: EventType } {
  const requestRecord = asRecord(request, requestName);
  rejectExtraKeys(
    requestRecord,
    ['schema_version', 'trace_id', 'event_id', 'event_type', 'user_id', 'conversation_id'],
    requestName
  );
  const normalizedRequest: ActiveIncidentRequest = {
    schema_version: requireLiteral(
      getOwnField(requestRecord, 'schema_version'),
      SCHEMA_VERSION,
      `${requestName}.schema_version`
    ),
    trace_id: requireString(getOwnField(requestRecord, 'trace_id'), `${requestName}.trace_id`),
    event_id: requireString(getOwnField(requestRecord, 'event_id'), `${requestName}.event_id`),
    event_type:
      allowedEventTypes.length === 1
        ? requireLiteral(
            getOwnField(requestRecord, 'event_type'),
            allowedEventTypes[0] ?? USER_MESSAGE,
            `${requestName}.event_type`
          )
        : requireOneOf(getOwnField(requestRecord, 'event_type'), allowedEventTypes, `${requestName}.event_type`)
  };
  copyOptionalIdentityFieldsFromRecord(normalizedRequest, requestRecord, requestName);
  return normalizedRequest as ActiveIncidentRequest & { event_type: EventType };
}

function validateActiveIncidentRequestEvent(event: unknown, sourceName: string): RuntimeEvent {
  const eventRecord = asRecord(event, sourceName);
  const eventType = getOwnField(eventRecord, 'type');
  if (eventType === USER_MESSAGE) {
    return validateNormalizedUserMessageEvent(event, sourceName);
  }
  if (eventType === INCIDENT_COMPLETION) {
    return validateNormalizedIncidentCompletionEvent(event, sourceName);
  }
  throw new ContractValidationError(
    `${sourceName}.type must be one of: INCIDENT_COMPLETION, USER_MESSAGE.`
  );
}

function copyOptionalIdentityFields(
  request: { user_id?: string; conversation_id?: string },
  payload: { user_id?: string; conversation_id?: string }
): void {
  if (Object.hasOwn(payload, 'user_id') && payload.user_id !== undefined) {
    request.user_id = payload.user_id;
  }
  if (Object.hasOwn(payload, 'conversation_id') && payload.conversation_id !== undefined) {
    request.conversation_id = payload.conversation_id;
  }
}

function copyOptionalIdentityFieldsFromRecord(
  request: { user_id?: string; conversation_id?: string },
  requestRecord: Record<string, unknown>,
  requestName: string
): void {
  if (Object.hasOwn(requestRecord, 'user_id')) {
    request.user_id = requireOptionalString(
      getOwnField(requestRecord, 'user_id'),
      `${requestName}.user_id`
    );
  }
  if (Object.hasOwn(requestRecord, 'conversation_id')) {
    request.conversation_id = requireOptionalString(
      getOwnField(requestRecord, 'conversation_id'),
      `${requestName}.conversation_id`
    );
  }
}

function validateSourceEventIds(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(`${fieldName} must be a list.`);
  }
  return value.map((sourceEventId, index) =>
    requireString(sourceEventId, `${fieldName}[${String(index)}]`)
  );
}

function validateNonEmptySourceEventIds(value: unknown, fieldName: string): string[] {
  const sourceEventIds = validateSourceEventIds(value, fieldName);
  if (sourceEventIds.length === 0) {
    throw new ContractValidationError(`${fieldName} must include at least one source event ID.`);
  }
  return sourceEventIds;
}

function addOptionalIncidentSnapshotFields(
  normalized:
    | ActiveIncidentSnapshot
    | InterruptedIncidentSnapshot,
  snapshotRecord: Record<string, unknown>,
  sourceName: 'ActiveIncidentSnapshot' | 'InterruptedIncidentSnapshot'
): void {
  if (Object.hasOwn(snapshotRecord, 'started_at')) {
    normalized.started_at = validateIso8601Timestamp(
      getOwnField(snapshotRecord, 'started_at'),
      `${sourceName}.started_at`
    );
  }
  if (Object.hasOwn(snapshotRecord, 'expected_end_at')) {
    normalized.expected_end_at = validateIso8601Timestamp(
      getOwnField(snapshotRecord, 'expected_end_at'),
      `${sourceName}.expected_end_at`
    );
  }
  if (Object.hasOwn(snapshotRecord, 'remaining_seconds')) {
    normalized.remaining_seconds = validateRemainingSeconds(
      getOwnField(snapshotRecord, 'remaining_seconds'),
      `${sourceName}.remaining_seconds`
    );
  }
}

function addOptionalIncidentBriefFields(
  normalized: ActiveIncidentBrief | InterruptedIncidentBrief,
  briefRecord: Record<string, unknown>,
  sourceName: 'active_incident' | 'interrupted_incident'
): void {
  if (Object.hasOwn(briefRecord, 'started_at')) {
    normalized.started_at = validateIso8601Timestamp(
      getOwnField(briefRecord, 'started_at'),
      `${sourceName}.started_at`
    );
  }
  if (Object.hasOwn(briefRecord, 'expected_end_at')) {
    normalized.expected_end_at = validateIso8601Timestamp(
      getOwnField(briefRecord, 'expected_end_at'),
      `${sourceName}.expected_end_at`
    );
  }
  if (Object.hasOwn(briefRecord, 'remaining_seconds')) {
    normalized.remaining_seconds = validateRemainingSeconds(
      getOwnField(briefRecord, 'remaining_seconds'),
      `${sourceName}.remaining_seconds`
    );
  }
}

function copyOptionalIncidentTimeFields(
  brief: ActiveIncidentBrief | InterruptedIncidentBrief,
  snapshot: ActiveIncidentSnapshot | InterruptedIncidentSnapshot
): void {
  if (Object.hasOwn(snapshot, 'started_at') && snapshot.started_at !== undefined) {
    brief.started_at = snapshot.started_at;
  }
  if (Object.hasOwn(snapshot, 'expected_end_at') && snapshot.expected_end_at !== undefined) {
    brief.expected_end_at = snapshot.expected_end_at;
  }
}
