import {
  COMPLETE_INCIDENT_ACTION,
  INCIDENT_COMPLETION,
  USER_MESSAGE,
  VISIBLE_REPLY_ACTION,
  ContractValidationError,
  normalizeCompleteIncidentLifeAction,
  normalizeRoleModelTurnResult,
  normalizeVisibleReplyDecisionWithOptionalLifeAction,
  validateNormalizedIncidentCompletionEvent,
  validateNormalizedUserMessageEvent,
  type IncidentCompletionRuntimeEvent,
  type RoleModelTurnResult,
  type UserMessageRuntimeEvent
} from '../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../runtime/schema.ts';
import {
  buildRawLogEntry,
  clockTimestamp,
  snapshotRawValue,
  type Clock,
  type IdGenerator,
  type RawEventLogEntry
} from '../runtime/logging.ts';
import {
  buildIncidentFailure,
  buildIncidentRejectedResult,
  buildIncidentStatusResult,
  copyOptionalIdentityFieldsFromRecord,
  copyOptionalPayloadIdentityFields,
  runStagedCommitTransaction,
  validateCommittedIncidentLogEntry,
  validateIncidentFailure,
  type IncidentFailure as LifecycleIncidentFailure,
  type IncidentSourceIdentity
} from './incident-lifecycle.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireOneOf,
  requireString,
  validateIso8601Timestamp,
  type ValueRecord
} from '../runtime/validation.ts';
import {
  buildActiveIncidentRequest,
  validateActiveIncidentSnapshot,
  type ActiveIncidentSnapshot,
  type ActiveIncidentSource
} from '../character/state/current.ts';

export const LIFE_INCIDENT_COMPLETED_STATUS = 'life_incident_completed';
export const LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS = 'life_incident_complete_skipped';
export const LIFE_INCIDENT_COMPLETE_REJECTED_STATUS = 'life_incident_complete_rejected';
export const LIFE_INCIDENT_COMPLETED_KIND = 'life_incident_completed';
export const LIFE_INCIDENT_COMPLETE_REJECTED_KIND = 'life_incident_complete_rejected';
export const LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE =
  'life_incident_complete_commit_validation';
export const LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE = 'life_incident_complete_finalize';
export const INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE =
  'incident_completion_event_commit_validation';
export const INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE = 'incident_completion_event_finalize';
export const INCIDENT_COMPLETION_EVENT_SOURCE = 'incident_completion_event';

const MODEL_FAILURE_CODES_BY_STAGE = {
  [LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE]: [
    'malformed_commit_input',
    'active_incident_source_error',
    'identity_mismatch',
    'unsupported_result_status',
    'unsupported_action',
    'empty_reply_text',
    'no_active_incident',
    'incident_id_mismatch'
  ],
  [LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE]: [
    'finalize_rejected',
    'malformed_finalize_result'
  ]
} as const;

const EVENT_FAILURE_CODES_BY_STAGE = {
  [INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE]: [
    'malformed_commit_input',
    'active_incident_source_error',
    'identity_mismatch',
    'no_active_incident',
    'incident_id_mismatch'
  ],
  [INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE]: [
    'finalize_rejected',
    'malformed_finalize_result'
  ]
} as const;

type ModelFailureStage = keyof typeof MODEL_FAILURE_CODES_BY_STAGE;
type EventFailureStage = keyof typeof EVENT_FAILURE_CODES_BY_STAGE;
type FailureStage = ModelFailureStage | EventFailureStage;
type CompleteEventType = typeof USER_MESSAGE | typeof INCIDENT_COMPLETION;

type SourceIdentity = IncidentSourceIdentity<CompleteEventType>;
type IncidentFailure = LifecycleIncidentFailure<FailureStage>;

export type CompletedIncidentSnapshot = Omit<ActiveIncidentSnapshot, 'status'> & {
  status: 'completed';
  actual_end_at: string;
};

export type LifeIncidentCompleteCommitRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  decision_action: typeof VISIBLE_REPLY_ACTION;
  life_action_type: typeof COMPLETE_INCIDENT_ACTION;
  incident_id: string;
  user_id?: string;
  conversation_id?: string;
};

export type LifeIncidentCompletionEventCommitRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof INCIDENT_COMPLETION;
  incident_id: string;
  user_id?: string;
  conversation_id?: string;
};

export type LifeIncidentCompletePrepareRequest =
  | (LifeIncidentCompleteCommitRequest & { commit_time: string })
  | (LifeIncidentCompletionEventCommitRequest & { commit_time: string });

export type LifeIncidentCompletedLogEntry = RawEventLogEntry & {
  kind: typeof LIFE_INCIDENT_COMPLETED_KIND;
};

export type LifeIncidentCompleteFinalizeRequest = LifeIncidentCompletePrepareRequest & {
  active_incident: ActiveIncidentSnapshot;
  completed_incident: CompletedIncidentSnapshot;
  committed_log_entry: LifeIncidentCompletedLogEntry;
};

export type LifeIncidentCompleteFinalizeResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: CompleteEventType;
  committed_log_entry_id: string;
};

export type LifeIncidentCompleteFinalizer = {
  finalizeLifeIncidentComplete: (request: LifeIncidentCompleteFinalizeRequest) => unknown;
  completeLifeIncidentCompleteAfterLogVisible: (
    request: LifeIncidentCompleteFinalizeRequest
  ) => void;
  requireLifeIncidentCompleteRawEventLog?: (rawEventLog: RawEventLog) => void;
  requireRawEventLog?: (rawEventLog: RawEventLog) => void;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type LifeIncidentCompleteCommitResult =
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: CompleteEventType;
      status: typeof LIFE_INCIDENT_COMPLETED_STATUS;
      completed_incident: CompletedIncidentSnapshot;
      committed_log_entry_id: string;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: CompleteEventType;
      status: typeof LIFE_INCIDENT_COMPLETE_REJECTED_STATUS;
      failure: IncidentFailure;
    };

export class LifeIncidentCompleteCommitValidationError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'malformed_commit_input' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentCompleteCommitValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LifeIncidentCompleteFinalizerError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'finalize_rejected' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentCompleteFinalizerError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function buildLifeIncidentCompleteCommitRequest(
  sourceEvent: unknown,
  roleModelResult: unknown
): LifeIncidentCompleteCommitRequest | undefined {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const lifeAction = result.decision.life_action;
  if (lifeAction === undefined) {
    return undefined;
  }
  if (lifeAction.type !== COMPLETE_INCIDENT_ACTION) {
    throw new LifeIncidentCompleteCommitValidationError(
      "life_action.type must be 'complete_incident'.",
      { code: 'unsupported_action' }
    );
  }
  const request: LifeIncidentCompleteCommitRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    decision_action: VISIBLE_REPLY_ACTION,
    life_action_type: COMPLETE_INCIDENT_ACTION,
    incident_id: lifeAction.incident_id
  };
  copyOptionalPayloadIdentityFields(event, request);
  return request;
}

export function buildLifeIncidentCompletionEventCommitRequest(
  sourceEvent: unknown
): LifeIncidentCompletionEventCommitRequest {
  const event = validateIncidentCompletionEvent(sourceEvent);
  const request: LifeIncidentCompletionEventCommitRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    incident_id: event.payload.incident_id
  };
  copyOptionalPayloadIdentityFields(event, request);
  return validateCompletionEventCommitRequest(request);
}

export function commitLifeIncidentComplete(
  sourceEvent: unknown,
  roleModelResult: unknown,
  {
    activeIncidentSource,
    lifeIncidentCompleteFinalizer,
    rawEventLog,
    idGenerator,
    clock
  }: {
    activeIncidentSource: ActiveIncidentSource;
    lifeIncidentCompleteFinalizer: LifeIncidentCompleteFinalizer;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): LifeIncidentCompleteCommitResult {
  const sourceIdentity = extractTrustedLifecycleSourceIdentity(sourceEvent);
  let request: LifeIncidentCompletePrepareRequest | undefined;
  let lifeActionSnapshot: unknown;
  let activeIncident: ActiveIncidentSnapshot | undefined;
  let completedIncident: CompletedIncidentSnapshot | undefined;
  let committedLogEntry: LifeIncidentCompletedLogEntry | undefined;
  let finalizeRequest: LifeIncidentCompleteFinalizeRequest | undefined;

  try {
    const commitRequest = buildLifeIncidentCompleteCommitRequest(sourceEvent, roleModelResult);
    if (commitRequest === undefined) {
      return {
        schema_version: SCHEMA_VERSION,
        trace_id: sourceIdentity.trace_id,
        event_id: sourceIdentity.event_id,
        event_type: USER_MESSAGE,
        status: LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS
      };
    }
    lifeActionSnapshot = {
      type: COMPLETE_INCIDENT_ACTION,
      incident_id: commitRequest.incident_id
    };
    activeIncident = readActiveIncidentForComplete(sourceEvent, activeIncidentSource);
    if (activeIncident.incident_id !== commitRequest.incident_id) {
      throw new LifeIncidentCompleteCommitValidationError(
        'life_action.incident_id must match the current active incident.',
        { code: 'incident_id_mismatch' }
      );
    }

    const commitTime = clockTimestamp(clock);
    request = { ...commitRequest, commit_time: commitTime };
    completedIncident = buildCompletedLifeIncidentSnapshot(activeIncident, request);
    committedLogEntry = buildLifeIncidentCompletedLogEntry(
      sourceEvent,
      roleModelResult,
      lifeActionSnapshot,
      activeIncident,
      completedIncident,
      { idGenerator, clock: clockAt(commitTime) }
    );
    finalizeRequest = buildLifeIncidentCompleteFinalizeRequest(request, {
      activeIncident,
      completedIncident,
      committedLogEntry
    });
    const validatedFinalizeResult = stageCompleteSuccess(
      lifeIncidentCompleteFinalizer,
      finalizeRequest,
      rawEventLog,
      { sourceIdentity, committedLogEntry }
    );
    return {
      ...buildIncidentStatusResult(sourceIdentity, LIFE_INCIDENT_COMPLETED_STATUS),
      completed_incident: structuredClone(completedIncident),
      committed_log_entry_id: validatedFinalizeResult.committed_log_entry_id
    };
  } catch (error) {
    if (error instanceof LifeIncidentCompleteFinalizerError) {
      const failure = buildModelFailure(
        LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentCompleteRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          lifeActionSnapshot,
          activeIncidentSnapshot: activeIncident,
          completedIncidentSnapshot: completedIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildIncidentRejectedResult(
        sourceIdentity,
        LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
        failure
      );
    }
    if (error instanceof LifeIncidentCompleteCommitValidationError) {
      const failure = buildModelFailure(
        LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentCompleteRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          lifeActionSnapshot,
          activeIncidentSnapshot: activeIncident,
          completedIncidentSnapshot: completedIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildIncidentRejectedResult(
        sourceIdentity,
        LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
        failure
      );
    }
    throw error;
  }
}

export function commitLifeIncidentCompletionEvent(
  sourceEvent: unknown,
  {
    activeIncidentSource,
    lifeIncidentCompleteFinalizer,
    rawEventLog,
    idGenerator,
    clock
  }: {
    activeIncidentSource: ActiveIncidentSource;
    lifeIncidentCompleteFinalizer: LifeIncidentCompleteFinalizer;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): LifeIncidentCompleteCommitResult {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent, INCIDENT_COMPLETION);
  let event: IncidentCompletionRuntimeEvent | undefined;
  let request: LifeIncidentCompletePrepareRequest | undefined;
  let activeIncident: ActiveIncidentSnapshot | undefined;
  let completedIncident: CompletedIncidentSnapshot | undefined;
  let committedLogEntry: LifeIncidentCompletedLogEntry | undefined;
  let finalizeRequest: LifeIncidentCompleteFinalizeRequest | undefined;

  try {
    event = validateIncidentCompletionEvent(sourceEvent);
    const commitRequest = buildLifeIncidentCompletionEventCommitRequest(event);
    activeIncident = readActiveIncidentForCompletionEvent(event, activeIncidentSource);
    if (activeIncident.incident_id !== commitRequest.incident_id) {
      throw new LifeIncidentCompleteCommitValidationError(
        'payload.incident_id must match the current active incident.',
        { code: 'incident_id_mismatch' }
      );
    }

    const commitTime = clockTimestamp(clock);
    request = { ...commitRequest, commit_time: commitTime };
    completedIncident = buildCompletedLifeIncidentSnapshot(activeIncident, request);
    committedLogEntry = buildLifeIncidentCompletionEventCompletedLogEntry(
      event,
      activeIncident,
      completedIncident,
      { idGenerator, clock: clockAt(commitTime) }
    );
    finalizeRequest = buildLifeIncidentCompleteFinalizeRequest(request, {
      activeIncident,
      completedIncident,
      committedLogEntry
    });
    const validatedFinalizeResult = stageCompleteSuccess(
      lifeIncidentCompleteFinalizer,
      finalizeRequest,
      rawEventLog,
      { sourceIdentity, committedLogEntry }
    );
    return {
      ...buildIncidentStatusResult(sourceIdentity, LIFE_INCIDENT_COMPLETED_STATUS),
      completed_incident: structuredClone(completedIncident),
      committed_log_entry_id: validatedFinalizeResult.committed_log_entry_id
    };
  } catch (error) {
    if (error instanceof LifeIncidentCompleteFinalizerError) {
      const failure = buildEventFailure(
        INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentCompletionEventRejectedLogEntry(sourceEvent, {
          activeIncidentSnapshot: activeIncident,
          completedIncidentSnapshot: completedIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildIncidentRejectedResult(
        sourceIdentity,
        LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
        failure
      );
    }
    if (error instanceof LifeIncidentCompleteCommitValidationError) {
      const failure = buildEventFailure(
        INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentCompletionEventRejectedLogEntry(sourceEvent, {
          activeIncidentSnapshot: activeIncident,
          completedIncidentSnapshot: completedIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildIncidentRejectedResult(
        sourceIdentity,
        LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
        failure
      );
    }
    throw error;
  }
}

export function buildCompletedLifeIncidentSnapshot(
  activeIncident: unknown,
  commitRequest: unknown
): CompletedIncidentSnapshot {
  const active = validateActiveIncidentForCommit(activeIncident);
  const request = validateCompletePrepareRequest(commitRequest);
  const snapshot: CompletedIncidentSnapshot = {
    schema_version: SCHEMA_VERSION,
    incident_id: active.incident_id,
    type: active.type,
    status: 'completed',
    title: active.title,
    interrupt_policy: active.interrupt_policy,
    resume_policy: active.resume_policy,
    actual_end_at: request.commit_time,
    source_event_ids: appendSourceEventIdOnce(active.source_event_ids, request.event_id)
  };
  copyOptionalIncidentFields(snapshot, active);
  return validateCompletedLifeIncidentSnapshot(snapshot, {
    activeIncident: active,
    commitRequest: request
  });
}

export function buildLifeIncidentCompletionEventCompletedLogEntry(
  sourceEvent: unknown,
  activeIncident: unknown,
  completedIncident: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): LifeIncidentCompletedLogEntry {
  const event = validateIncidentCompletionEvent(sourceEvent);
  const active = validateActiveIncidentForCommit(activeIncident);
  const commitRequest = {
    ...buildLifeIncidentCompletionEventCommitRequest(event),
    commit_time: getTransitionTime(completedIncident, 'actual_end_at')
  };
  const completed = validateCompletedLifeIncidentSnapshot(completedIncident, {
    activeIncident: active,
    commitRequest
  });
  const entry = buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: LIFE_INCIDENT_COMPLETED_KIND,
    data: {
      source_event: event,
      completion_source: INCIDENT_COMPLETION_EVENT_SOURCE,
      active_incident: active,
      completed_incident: completed
    },
    idGenerator,
    clock
  });
  return { ...entry, kind: LIFE_INCIDENT_COMPLETED_KIND };
}

export function buildLifeIncidentCompletedLogEntry(
  sourceEvent: unknown,
  roleModelResult: unknown,
  lifeAction: unknown,
  activeIncident: unknown,
  completedIncident: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): LifeIncidentCompletedLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const normalizedLifeAction = normalizeCompleteLifeAction(lifeAction);
  const active = validateActiveIncidentForCommit(activeIncident);
  const commitRequest: LifeIncidentCompletePrepareRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    decision_action: VISIBLE_REPLY_ACTION,
    life_action_type: COMPLETE_INCIDENT_ACTION,
    incident_id: normalizedLifeAction.incident_id,
    commit_time: getTransitionTime(completedIncident, 'actual_end_at')
  };
  const completed = validateCompletedLifeIncidentSnapshot(completedIncident, {
    activeIncident: active,
    commitRequest
  });
  const entry = buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: LIFE_INCIDENT_COMPLETED_KIND,
    data: {
      source_event: event,
      role_model_result: result,
      life_action: normalizedLifeAction,
      active_incident: active,
      completed_incident: completed
    },
    idGenerator,
    clock
  });
  return { ...entry, kind: LIFE_INCIDENT_COMPLETED_KIND };
}

export function buildLifeIncidentCompleteFinalizeRequest(
  commitRequest: unknown,
  {
    activeIncident,
    completedIncident,
    committedLogEntry
  }: {
    activeIncident: unknown;
    completedIncident: unknown;
    committedLogEntry: unknown;
  }
): LifeIncidentCompleteFinalizeRequest {
  const request = validateCompletePrepareRequest(commitRequest);
  const active = validateActiveIncidentForCommit(activeIncident);
  const completed = validateCompletedLifeIncidentSnapshot(completedIncident, {
    activeIncident: active,
    commitRequest: request
  });
  const entry = validateCommittedLogEntry(committedLogEntry, {
    sourceIdentity: request,
    kind: LIFE_INCIDENT_COMPLETED_KIND
  });
  return {
    ...structuredClone(request),
    active_incident: active,
    completed_incident: completed,
    committed_log_entry: { ...entry, kind: LIFE_INCIDENT_COMPLETED_KIND }
  };
}

export function validateLifeIncidentCompleteFinalizeResult(
  finalizeResult: unknown,
  {
    sourceIdentity,
    committedLogEntry
  }: {
    sourceIdentity: SourceIdentity;
    committedLogEntry: unknown;
  }
): LifeIncidentCompleteFinalizeResult {
  const result = asFinalizerRecord(finalizeResult, 'LifeIncidentCompleteFinalizeResult');
  wrapFinalizerContractError(() => {
    rejectExtraKeys(
      result,
      ['schema_version', 'trace_id', 'event_id', 'event_type', 'committed_log_entry_id'],
      'LifeIncidentCompleteFinalizeResult'
    );
  });
  const entry = asFinalizerRecord(committedLogEntry, 'committed_log_entry');
  const expectedLogId = wrapFinalizerContractError(() =>
    requireString(getOwnField(entry, 'log_id'), 'committed_log_entry.log_id')
  );
  const normalized: LifeIncidentCompleteFinalizeResult = {
    schema_version: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentCompleteFinalizeResult.schema_version'
      )
    ),
    trace_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'trace_id'), 'LifeIncidentCompleteFinalizeResult.trace_id')
    ),
    event_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'event_id'), 'LifeIncidentCompleteFinalizeResult.event_id')
    ),
    event_type: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'event_type'),
        sourceIdentity.event_type,
        'LifeIncidentCompleteFinalizeResult.event_type'
      )
    ),
    committed_log_entry_id: wrapFinalizerContractError(() =>
      requireString(
        getOwnField(result, 'committed_log_entry_id'),
        'LifeIncidentCompleteFinalizeResult.committed_log_entry_id'
      )
    )
  };
  if (normalized.trace_id !== sourceIdentity.trace_id) {
    throw new LifeIncidentCompleteFinalizerError(
      'LifeIncidentCompleteFinalizeResult.trace_id must match source_event.trace_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.event_id !== sourceIdentity.event_id) {
    throw new LifeIncidentCompleteFinalizerError(
      'LifeIncidentCompleteFinalizeResult.event_id must match source_event.event_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.committed_log_entry_id !== expectedLogId) {
    throw new LifeIncidentCompleteFinalizerError(
      'LifeIncidentCompleteFinalizeResult.committed_log_entry_id must match committed_log_entry.log_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  return normalized;
}

export function buildLifeIncidentCompleteRejectedLogEntry(
  sourceEvent: unknown,
  {
    roleModelResultSnapshot,
    lifeActionSnapshot,
    activeIncidentSnapshot,
    completedIncidentSnapshot,
    failure,
    idGenerator,
    clock
  }: {
    roleModelResultSnapshot: unknown;
    lifeActionSnapshot?: unknown;
    activeIncidentSnapshot?: unknown;
    completedIncidentSnapshot?: unknown;
    failure: IncidentFailure;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const sourceIdentity = extractTrustedLifecycleSourceIdentity(sourceEvent);
  const data: Record<string, unknown> = {
    source_event: snapshotRawValue(sourceEvent),
    role_model_result_snapshot: snapshotRawValue(roleModelResultSnapshot),
    failure: validateModelFailure(failure)
  };
  if (lifeActionSnapshot !== undefined) {
    data['life_action_snapshot'] = snapshotRawValue(lifeActionSnapshot);
  }
  if (activeIncidentSnapshot !== undefined) {
    data['active_incident_snapshot'] = snapshotRawValue(activeIncidentSnapshot);
  }
  if (completedIncidentSnapshot !== undefined) {
    data['completed_incident_snapshot'] = snapshotRawValue(completedIncidentSnapshot);
  }
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: LIFE_INCIDENT_COMPLETE_REJECTED_KIND,
    data,
    idGenerator,
    clock
  });
}

export function buildLifeIncidentCompletionEventRejectedLogEntry(
  sourceEvent: unknown,
  {
    activeIncidentSnapshot,
    completedIncidentSnapshot,
    failure,
    idGenerator,
    clock
  }: {
    activeIncidentSnapshot?: unknown;
    completedIncidentSnapshot?: unknown;
    failure: IncidentFailure;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent, INCIDENT_COMPLETION);
  const data: Record<string, unknown> = {
    source_event: snapshotRawValue(sourceEvent),
    completion_source: INCIDENT_COMPLETION_EVENT_SOURCE,
    failure: validateEventFailure(failure)
  };
  if (activeIncidentSnapshot !== undefined) {
    data['active_incident_snapshot'] = snapshotRawValue(activeIncidentSnapshot);
  }
  if (completedIncidentSnapshot !== undefined) {
    data['completed_incident_snapshot'] = snapshotRawValue(completedIncidentSnapshot);
  }
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: LIFE_INCIDENT_COMPLETE_REJECTED_KIND,
    data,
    idGenerator,
    clock
  });
}

export function validateCompletedLifeIncidentSnapshot(
  snapshot: unknown,
  {
    activeIncident,
    commitRequest
  }: {
    activeIncident: unknown;
    commitRequest: unknown;
  }
): CompletedIncidentSnapshot {
  const record = asCommitRecord(snapshot, 'CompletedLifeIncidentSnapshot');
  wrapCommitContractError(() => {
    rejectExtraKeys(
      record,
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
        'actual_end_at',
        'source_event_ids'
      ],
      'CompletedLifeIncidentSnapshot'
    );
  });
  const active = validateActiveIncidentForCommit(activeIncident);
  const request = validateCompletePrepareRequest(commitRequest);
  const normalized: CompletedIncidentSnapshot = {
    schema_version: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(record, 'schema_version'),
        SCHEMA_VERSION,
        'CompletedLifeIncidentSnapshot.schema_version'
      )
    ),
    incident_id: wrapCommitContractError(() =>
      requireString(
        getOwnField(record, 'incident_id'),
        'CompletedLifeIncidentSnapshot.incident_id'
      )
    ),
    type: requireMatchingField(record, active, 'type', 'completed_incident'),
    status: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(record, 'status'),
        'completed',
        'CompletedLifeIncidentSnapshot.status'
      )
    ),
    title: requireMatchingField(record, active, 'title', 'completed_incident'),
    interrupt_policy: requireMatchingField(
      record,
      active,
      'interrupt_policy',
      'completed_incident'
    ),
    resume_policy: requireMatchingField(record, active, 'resume_policy', 'completed_incident'),
    actual_end_at: wrapCommitContractError(() =>
      validateIso8601Timestamp(
        getOwnField(record, 'actual_end_at'),
        'CompletedLifeIncidentSnapshot.actual_end_at'
      )
    ),
    source_event_ids: validateTransitionSourceEventIds(record, active, request, 'completed_incident')
  };
  if (normalized.incident_id !== active.incident_id) {
    throw new LifeIncidentCompleteCommitValidationError(
      'completed_incident.incident_id must match active_incident.incident_id.'
    );
  }
  if (normalized.incident_id !== request.incident_id) {
    throw new LifeIncidentCompleteCommitValidationError(
      'completed_incident.incident_id must match LifeIncidentCompleteCommitRequest.incident_id.'
    );
  }
  if (normalized.actual_end_at !== request.commit_time) {
    throw new LifeIncidentCompleteCommitValidationError(
      'completed_incident.actual_end_at must match commit_time.'
    );
  }
  copyValidatedOptionalIncidentFields(normalized, record, active, 'completed_incident');
  return normalized;
}

function validateSourceEvent(sourceEvent: unknown): UserMessageRuntimeEvent {
  return wrapCommitContractError(() =>
    validateNormalizedUserMessageEvent(sourceEvent, 'source_event')
  );
}

function validateIncidentCompletionEvent(sourceEvent: unknown): IncidentCompletionRuntimeEvent {
  return wrapCommitContractError(() =>
    validateNormalizedIncidentCompletionEvent(sourceEvent, 'source_event')
  );
}

function validateRoleModelResult(
  roleModelResult: unknown,
  { sourceEvent }: { sourceEvent: UserMessageRuntimeEvent }
): RoleModelTurnResult {
  return wrapCommitContractError(() =>
    normalizeRoleModelTurnResult(roleModelResult, {
      sourceEvent,
      decisionNormalizer: (decision) =>
        normalizeVisibleReplyDecisionWithOptionalLifeAction(
          decision,
          {
            traceId: sourceEvent.trace_id,
            eventId: sourceEvent.event_id,
            requireAttachedIds: true,
            allowLifeAction: true,
            allowedLifeActionType: COMPLETE_INCIDENT_ACTION
          },
          'CharacterDecision'
        )
    })
  );
}

function normalizeCompleteLifeAction(lifeAction: unknown): {
  type: typeof COMPLETE_INCIDENT_ACTION;
  incident_id: string;
} {
  return wrapCommitContractError(() =>
    normalizeCompleteIncidentLifeAction(lifeAction, 'life_action')
  );
}

function validateCompletionEventCommitRequest(
  commitRequest: unknown
): LifeIncidentCompletionEventCommitRequest {
  const request = validateCompleteCommitRequest(commitRequest, { requireCommitTime: false });
  if (request.event_type !== INCIDENT_COMPLETION) {
    throw new LifeIncidentCompleteCommitValidationError(
      'LifeIncidentCompletionEventCommitRequest.event_type must be INCIDENT_COMPLETION.'
    );
  }
  const { commit_time: _commitTime, ...withoutCommitTime } = request;
  void _commitTime;
  return withoutCommitTime;
}

function validateCompletePrepareRequest(commitRequest: unknown): LifeIncidentCompletePrepareRequest {
  const request = validateCompleteCommitRequest(commitRequest, { requireCommitTime: true });
  if (request.commit_time === undefined) {
    throw new LifeIncidentCompleteCommitValidationError(
      'LifeIncidentCompleteCommitRequest.commit_time must be an ISO-8601 timestamp string.'
    );
  }
  return request as LifeIncidentCompletePrepareRequest;
}

function validateCompleteCommitRequest(
  commitRequest: unknown,
  { requireCommitTime }: { requireCommitTime: boolean }
): (LifeIncidentCompleteCommitRequest | LifeIncidentCompletionEventCommitRequest) & {
  commit_time?: string;
} {
  const request = asCommitRecord(commitRequest, 'LifeIncidentCompleteCommitRequest');
  wrapCommitContractError(() => {
    rejectExtraKeys(
      request,
      [
        'schema_version',
        'trace_id',
        'event_id',
        'event_type',
        'decision_action',
        'life_action_type',
        'incident_id',
        'commit_time',
        'user_id',
        'conversation_id'
      ],
      'LifeIncidentCompleteCommitRequest'
    );
  });
  const eventType = wrapCommitContractError(() =>
    requireOneOf(
      getOwnField(request, 'event_type'),
      [USER_MESSAGE, INCIDENT_COMPLETION],
      'LifeIncidentCompleteCommitRequest.event_type'
    )
  );
  const base = {
    schema_version: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentCompleteCommitRequest.schema_version'
      )
    ),
    trace_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'trace_id'), 'LifeIncidentCompleteCommitRequest.trace_id')
    ),
    event_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'event_id'), 'LifeIncidentCompleteCommitRequest.event_id')
    ),
    event_type: eventType,
    incident_id: wrapCommitContractError(() =>
      requireString(
        getOwnField(request, 'incident_id'),
        'LifeIncidentCompleteCommitRequest.incident_id'
      ).trim()
    )
  };
  const normalized:
    | (LifeIncidentCompleteCommitRequest & { commit_time?: string })
    | (LifeIncidentCompletionEventCommitRequest & { commit_time?: string }) =
    eventType === USER_MESSAGE
      ? {
          ...base,
          event_type: USER_MESSAGE,
          decision_action: wrapCommitContractError(() =>
            requireLiteral(
              getOwnField(request, 'decision_action'),
              VISIBLE_REPLY_ACTION,
              'LifeIncidentCompleteCommitRequest.decision_action'
            )
          ),
          life_action_type: wrapCommitContractError(() =>
            requireLiteral(
              getOwnField(request, 'life_action_type'),
              COMPLETE_INCIDENT_ACTION,
              'LifeIncidentCompleteCommitRequest.life_action_type'
            )
          )
        }
      : {
          ...base,
          event_type: INCIDENT_COMPLETION
        };
  if (eventType === INCIDENT_COMPLETION) {
    if (Object.hasOwn(request, 'decision_action') || Object.hasOwn(request, 'life_action_type')) {
      throw new LifeIncidentCompleteCommitValidationError(
        'Incident completion event requests must not include model decision fields.',
        { code: 'malformed_commit_input' }
      );
    }
  }
  if (requireCommitTime || Object.hasOwn(request, 'commit_time')) {
    normalized.commit_time = validateTimestampForCommit(
      getOwnField(request, 'commit_time'),
      'LifeIncidentCompleteCommitRequest.commit_time'
    );
  }
  copyOptionalIdentityFieldsFromRecord(
    request,
    normalized,
    {
      sourceName: 'LifeIncidentCompleteCommitRequest',
      makeError: (message) => new LifeIncidentCompleteCommitValidationError(message)
    }
  );
  return normalized;
}

function readActiveIncidentForComplete(
  sourceEvent: unknown,
  activeIncidentSource: ActiveIncidentSource
): ActiveIncidentSnapshot {
  const event = validateSourceEvent(sourceEvent);
  return readActiveIncidentForEvent(event, activeIncidentSource);
}

function readActiveIncidentForCompletionEvent(
  sourceEvent: unknown,
  activeIncidentSource: ActiveIncidentSource
): ActiveIncidentSnapshot {
  const event = validateIncidentCompletionEvent(sourceEvent);
  return readActiveIncidentForEvent(event, activeIncidentSource);
}

function readActiveIncidentForEvent(
  sourceEvent: UserMessageRuntimeEvent | IncidentCompletionRuntimeEvent,
  activeIncidentSource: ActiveIncidentSource
): ActiveIncidentSnapshot {
  const request = buildActiveIncidentRequest(sourceEvent);
  let activeIncident: unknown;
  try {
    activeIncident = activeIncidentSource.readActiveIncident(structuredClone(request));
  } catch (error) {
    throw new LifeIncidentCompleteCommitValidationError(
      `active_incident_source.read_active_incident failed unexpectedly: ${errorMessage(error)}`,
      { code: 'active_incident_source_error' }
    );
  }
  if (activeIncident === null || activeIncident === undefined) {
    throw new LifeIncidentCompleteCommitValidationError(
      'No active incident exists for this source-event scope.',
      { code: 'no_active_incident' }
    );
  }
  return validateActiveIncidentForCommit(activeIncident);
}

function validateActiveIncidentForCommit(activeIncident: unknown): ActiveIncidentSnapshot {
  try {
    return validateActiveIncidentSnapshot(activeIncident);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentCompleteCommitValidationError(error.message, { code: error.code });
    }
    throw error;
  }
}

function validateCommittedLogEntry(
  committedLogEntry: unknown,
  {
    sourceIdentity,
    kind
  }: {
    sourceIdentity: SourceIdentity | LifeIncidentCompletePrepareRequest;
    kind: string;
  }
): RawEventLogEntry {
  return validateCommittedIncidentLogEntry(committedLogEntry, {
    sourceIdentity,
    kind,
    makeError: (message) => new LifeIncidentCompleteCommitValidationError(message)
  });
}

function extractTrustedSourceIdentity(
  sourceEvent: unknown,
  eventType: CompleteEventType
): SourceIdentity {
  const sourceRecord = asCommitRecord(sourceEvent, 'source_event');
  const traceId = wrapCommitContractError(() =>
    requireString(getOwnField(sourceRecord, 'trace_id'), 'source_event.trace_id')
  );
  const eventId = wrapCommitContractError(() =>
    requireString(getOwnField(sourceRecord, 'event_id'), 'source_event.event_id')
  );
  wrapCommitContractError(() =>
    requireLiteral(getOwnField(sourceRecord, 'type'), eventType, 'source_event.type')
  );
  return {
    trace_id: traceId,
    event_id: eventId,
    event_type: eventType
  };
}

function extractTrustedLifecycleSourceIdentity(sourceEvent: unknown): SourceIdentity {
  const sourceRecord = asCommitRecord(sourceEvent, 'source_event');
  const traceId = wrapCommitContractError(() =>
    requireString(getOwnField(sourceRecord, 'trace_id'), 'source_event.trace_id')
  );
  const eventId = wrapCommitContractError(() =>
    requireString(getOwnField(sourceRecord, 'event_id'), 'source_event.event_id')
  );
  return {
    trace_id: traceId,
    event_id: eventId,
    event_type: USER_MESSAGE
  };
}

function buildModelFailure(stage: ModelFailureStage, code: string, message: string): IncidentFailure {
  return buildIncidentFailure({
    stage,
    code,
    message,
    supportedCodes: MODEL_FAILURE_CODES_BY_STAGE[stage],
    fallbackCode: fallbackModelCode(stage)
  });
}

function buildEventFailure(stage: EventFailureStage, code: string, message: string): IncidentFailure {
  return buildIncidentFailure({
    stage,
    code,
    message,
    supportedCodes: EVENT_FAILURE_CODES_BY_STAGE[stage],
    fallbackCode: fallbackEventCode(stage)
  });
}

function fallbackModelCode(stage: ModelFailureStage): string {
  return stage === LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE
    ? 'malformed_finalize_result'
    : 'malformed_commit_input';
}

function fallbackEventCode(stage: EventFailureStage): string {
  return stage === INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE
    ? 'malformed_finalize_result'
    : 'malformed_commit_input';
}

function validateModelFailure(failure: unknown): IncidentFailure {
  return validateIncidentFailure<ModelFailureStage, LifeIncidentCompleteCommitValidationError>(
    failure,
    {
      supportedByStage: MODEL_FAILURE_CODES_BY_STAGE,
      label: 'incident-complete',
      makeError: (message) => new LifeIncidentCompleteCommitValidationError(message)
    }
  );
}

function validateEventFailure(failure: unknown): IncidentFailure {
  return validateIncidentFailure<EventFailureStage, LifeIncidentCompleteCommitValidationError>(
    failure,
    {
      supportedByStage: EVENT_FAILURE_CODES_BY_STAGE,
      label: 'incident-completion-event',
      makeError: (message) => new LifeIncidentCompleteCommitValidationError(message)
    }
  );
}

function stageCompleteSuccess(
  finalizer: LifeIncidentCompleteFinalizer,
  finalizeRequest: LifeIncidentCompleteFinalizeRequest,
  rawEventLog: RawEventLog,
  {
    sourceIdentity,
    committedLogEntry
  }: {
    sourceIdentity: SourceIdentity;
    committedLogEntry: LifeIncidentCompletedLogEntry;
  }
): LifeIncidentCompleteFinalizeResult {
  return runStagedCommitTransaction({
    rawEventLog,
    committedLogEntry,
    finalizeRequest,
    requireRawEventLog: (candidateRawLog) => {
      const requireSpecific = finalizer.requireLifeIncidentCompleteRawEventLog;
      const requireGeneric = finalizer.requireRawEventLog;
      if (requireSpecific !== undefined) {
        requireSpecific.call(finalizer, candidateRawLog as RawEventLog);
      } else if (requireGeneric !== undefined) {
        requireGeneric.call(finalizer, candidateRawLog as RawEventLog);
      }
    },
    finalize: (candidateRequest) => finalizer.finalizeLifeIncidentComplete(candidateRequest),
    validateFinalizeResult: (candidateResult) =>
      validateLifeIncidentCompleteFinalizeResult(candidateResult, {
        sourceIdentity,
        committedLogEntry
      }),
    completeAfterLogVisible: (candidateRequest) => {
      finalizer.completeLifeIncidentCompleteAfterLogVisible(candidateRequest);
    },
    isTransactionError: (error): error is LifeIncidentCompleteFinalizerError =>
      error instanceof LifeIncidentCompleteFinalizerError,
    makeMalformedFinalizeError: (message) =>
      new LifeIncidentCompleteFinalizerError(message, { code: 'malformed_finalize_result' }),
    makeFinalizeRejectedError: (message) =>
      new LifeIncidentCompleteFinalizerError(message, { code: 'finalize_rejected' }),
    formatRequirementUnexpectedError: errorMessage,
    formatFinalizeUnexpectedError: (error) =>
      `finalize_life_incident_complete failed unexpectedly: ${errorMessage(error)}`,
    formatPostVisibleUnexpectedError: (error) =>
      `complete_life_incident_complete_after_log_visible failed unexpectedly: ${errorMessage(error)}`
  });
}

function copyOptionalIncidentFields(
  snapshot: CompletedIncidentSnapshot,
  activeIncident: ActiveIncidentSnapshot
): void {
  if (activeIncident.started_at !== undefined) {
    snapshot.started_at = activeIncident.started_at;
  }
  if (activeIncident.expected_end_at !== undefined) {
    snapshot.expected_end_at = activeIncident.expected_end_at;
  }
  if (activeIncident.remaining_seconds !== undefined) {
    snapshot.remaining_seconds = activeIncident.remaining_seconds;
  }
}

function copyValidatedOptionalIncidentFields(
  output: CompletedIncidentSnapshot,
  record: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  snapshotName: string
): void {
  const startedAt = activeIncident.started_at;
  if (startedAt !== undefined) {
    requireMatchingExact(record, startedAt, 'started_at', snapshotName);
    output.started_at = startedAt;
  } else if (Object.hasOwn(record, 'started_at')) {
    throw new LifeIncidentCompleteCommitValidationError(
      `${snapshotName}.started_at must be omitted when active_incident omits it.`
    );
  }
  const expectedEndAt = activeIncident.expected_end_at;
  if (expectedEndAt !== undefined) {
    requireMatchingExact(record, expectedEndAt, 'expected_end_at', snapshotName);
    output.expected_end_at = expectedEndAt;
  } else if (Object.hasOwn(record, 'expected_end_at')) {
    throw new LifeIncidentCompleteCommitValidationError(
      `${snapshotName}.expected_end_at must be omitted when active_incident omits it.`
    );
  }
  const remainingSeconds = activeIncident.remaining_seconds;
  if (remainingSeconds !== undefined) {
    requireMatchingExact(record, remainingSeconds, 'remaining_seconds', snapshotName);
    output.remaining_seconds = remainingSeconds;
  } else if (Object.hasOwn(record, 'remaining_seconds')) {
    throw new LifeIncidentCompleteCommitValidationError(
      `${snapshotName}.remaining_seconds must be omitted when active_incident omits it.`
    );
  }
}

function requireMatchingExact(
  snapshot: ValueRecord,
  expected: string | number,
  fieldName: string,
  snapshotName: string
): void {
  if (getOwnField(snapshot, fieldName) !== expected) {
    throw new LifeIncidentCompleteCommitValidationError(
      `${snapshotName}.${fieldName} must match active_incident.${fieldName}.`
    );
  }
}

function requireMatchingField<FieldName extends keyof ActiveIncidentSnapshot>(
  snapshot: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  fieldName: FieldName,
  snapshotName: string
): ActiveIncidentSnapshot[FieldName] {
  if (getOwnField(snapshot, fieldName) !== activeIncident[fieldName]) {
    throw new LifeIncidentCompleteCommitValidationError(
      `${snapshotName}.${fieldName} must match active_incident.${fieldName}.`
    );
  }
  return activeIncident[fieldName];
}

function validateTransitionSourceEventIds(
  snapshot: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  request: LifeIncidentCompletePrepareRequest,
  snapshotName: string
): string[] {
  const value = getOwnField(snapshot, 'source_event_ids');
  if (!Array.isArray(value)) {
    throw new LifeIncidentCompleteCommitValidationError(
      `${snapshotName}.source_event_ids must be a list.`
    );
  }
  const normalized = value.map((sourceEventId) =>
    wrapCommitContractError(() =>
      requireString(sourceEventId, `${snapshotName}.source_event_ids[]`)
    )
  );
  const expected = appendSourceEventIdOnce(activeIncident.source_event_ids, request.event_id);
  if (!arraysEqual(normalized, expected)) {
    throw new LifeIncidentCompleteCommitValidationError(
      `${snapshotName}.source_event_ids must preserve active IDs and append event_id once.`
    );
  }
  return normalized;
}

function appendSourceEventIdOnce(sourceEventIds: readonly string[], eventId: string): string[] {
  if (sourceEventIds.includes(eventId)) {
    return [...sourceEventIds];
  }
  return [...sourceEventIds, eventId];
}

function getTransitionTime(snapshot: unknown, fieldName: string): string {
  const record = asCommitRecord(snapshot, fieldName);
  return validateTimestampForCommit(getOwnField(record, fieldName), fieldName);
}

function validateTimestampForCommit(value: unknown, fieldName: string): string {
  return wrapCommitContractError(() => validateIso8601Timestamp(value, fieldName));
}

function clockAt(timestamp: string): Clock {
  return () => timestamp;
}

function asCommitRecord(value: unknown, fieldName: string): ValueRecord {
  return wrapCommitContractError(() => asRecord(value, fieldName));
}

function asFinalizerRecord(value: unknown, fieldName: string): ValueRecord {
  return wrapFinalizerContractError(() => asRecord(value, fieldName));
}

function wrapCommitContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      const code = error.code === 'invalid_contract' ? 'malformed_commit_input' : error.code;
      throw new LifeIncidentCompleteCommitValidationError(error.message, { code });
    }
    throw error;
  }
}

function wrapFinalizerContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentCompleteFinalizerError(error.message, {
        code: 'malformed_finalize_result'
      });
    }
    throw error;
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
