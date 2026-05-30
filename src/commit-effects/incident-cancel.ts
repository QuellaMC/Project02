import {
  CANCEL_INCIDENT_ACTION,
  USER_MESSAGE,
  VISIBLE_REPLY_ACTION,
  ContractValidationError,
  normalizeCancelIncidentLifeAction,
  normalizeRoleModelTurnResult,
  normalizeVisibleReplyDecisionWithOptionalLifeAction,
  validateNormalizedUserMessageEvent,
  type RoleModelTurnResult,
  type UserMessageRuntimeEvent
} from '../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../runtime/schema.ts';
import {
  RawEventLogQueryValidationError,
  buildRawLogEntry,
  clockTimestamp,
  confirmCommittedSuccessEntryVisibility,
  discardCommittedSuccessEntryVisibility,
  snapshotRawValue,
  type Clock,
  type IdGenerator,
  type RawEventLogEntry
} from '../runtime/logging.ts';
import { validateCommittedIncidentLogEntry } from './incident-lifecycle.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireOptionalString,
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

export const LIFE_INCIDENT_CANCELLED_STATUS = 'life_incident_cancelled';
export const LIFE_INCIDENT_CANCEL_SKIPPED_STATUS = 'life_incident_cancel_skipped';
export const LIFE_INCIDENT_CANCEL_REJECTED_STATUS = 'life_incident_cancel_rejected';
export const LIFE_INCIDENT_CANCELLED_KIND = 'life_incident_cancelled';
export const LIFE_INCIDENT_CANCEL_REJECTED_KIND = 'life_incident_cancel_rejected';
export const LIFE_INCIDENT_CANCEL_COMMIT_VALIDATION_STAGE =
  'life_incident_cancel_commit_validation';
export const LIFE_INCIDENT_CANCEL_FINALIZE_STAGE = 'life_incident_cancel_finalize';

const FAILURE_CODES_BY_STAGE = {
  [LIFE_INCIDENT_CANCEL_COMMIT_VALIDATION_STAGE]: [
    'malformed_commit_input',
    'active_incident_source_error',
    'identity_mismatch',
    'unsupported_result_status',
    'unsupported_action',
    'empty_reply_text',
    'no_active_incident',
    'incident_id_mismatch'
  ],
  [LIFE_INCIDENT_CANCEL_FINALIZE_STAGE]: [
    'finalize_rejected',
    'malformed_finalize_result'
  ]
} as const;

type FailureStage = keyof typeof FAILURE_CODES_BY_STAGE;
type SourceIdentity = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
};
type IncidentFailure = {
  stage: FailureStage;
  code: string;
  message: string;
};

export type CancelledIncidentSnapshot = Omit<ActiveIncidentSnapshot, 'status'> & {
  status: 'cancelled';
  cancelled_at: string;
  cancellation_reason: string;
};

export type LifeIncidentCancelCommitRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  decision_action: typeof VISIBLE_REPLY_ACTION;
  life_action_type: typeof CANCEL_INCIDENT_ACTION;
  incident_id: string;
  reason: string;
  user_id?: string;
  conversation_id?: string;
};

export type LifeIncidentCancelPrepareRequest = LifeIncidentCancelCommitRequest & {
  commit_time: string;
};

export type LifeIncidentCancelledLogEntry = RawEventLogEntry & {
  kind: typeof LIFE_INCIDENT_CANCELLED_KIND;
};

export type LifeIncidentCancelFinalizeRequest = LifeIncidentCancelPrepareRequest & {
  active_incident: ActiveIncidentSnapshot;
  cancelled_incident: CancelledIncidentSnapshot;
  committed_log_entry: LifeIncidentCancelledLogEntry;
};

export type LifeIncidentCancelFinalizeResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  committed_log_entry_id: string;
};

export type LifeIncidentCancelFinalizer = {
  finalizeLifeIncidentCancel: (request: LifeIncidentCancelFinalizeRequest) => unknown;
  completeLifeIncidentCancelAfterLogVisible: (
    request: LifeIncidentCancelFinalizeRequest
  ) => void;
  requireLifeIncidentCancelRawEventLog?: (rawEventLog: RawEventLog) => void;
  requireRawEventLog?: (rawEventLog: RawEventLog) => void;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type LifeIncidentCancelCommitResult =
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_CANCEL_SKIPPED_STATUS;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_CANCELLED_STATUS;
      cancelled_incident: CancelledIncidentSnapshot;
      committed_log_entry_id: string;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_CANCEL_REJECTED_STATUS;
      failure: IncidentFailure;
    };

export class LifeIncidentCancelCommitValidationError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'malformed_commit_input' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentCancelCommitValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LifeIncidentCancelFinalizerError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'finalize_rejected' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentCancelFinalizerError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function buildLifeIncidentCancelCommitRequest(
  sourceEvent: unknown,
  roleModelResult: unknown
): LifeIncidentCancelCommitRequest | undefined {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const lifeAction = result.decision.life_action;
  if (lifeAction === undefined) {
    return undefined;
  }
  if (lifeAction.type !== CANCEL_INCIDENT_ACTION) {
    throw new LifeIncidentCancelCommitValidationError(
      "life_action.type must be 'cancel_incident'.",
      { code: 'unsupported_action' }
    );
  }
  const request: LifeIncidentCancelCommitRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    decision_action: VISIBLE_REPLY_ACTION,
    life_action_type: CANCEL_INCIDENT_ACTION,
    incident_id: lifeAction.incident_id,
    reason: lifeAction.reason
  };
  copyOptionalPayloadIdentityFields(event, request);
  return request;
}

export function commitLifeIncidentCancel(
  sourceEvent: unknown,
  roleModelResult: unknown,
  {
    activeIncidentSource,
    lifeIncidentCancelFinalizer,
    rawEventLog,
    idGenerator,
    clock
  }: {
    activeIncidentSource: ActiveIncidentSource;
    lifeIncidentCancelFinalizer: LifeIncidentCancelFinalizer;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): LifeIncidentCancelCommitResult {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  let request: LifeIncidentCancelPrepareRequest | undefined;
  let lifeActionSnapshot: unknown;
  let activeIncident: ActiveIncidentSnapshot | undefined;
  let cancelledIncident: CancelledIncidentSnapshot | undefined;
  let committedLogEntry: LifeIncidentCancelledLogEntry | undefined;
  let finalizeRequest: LifeIncidentCancelFinalizeRequest | undefined;

  try {
    const commitRequest = buildLifeIncidentCancelCommitRequest(sourceEvent, roleModelResult);
    if (commitRequest === undefined) {
      return buildStatusResult(sourceIdentity, LIFE_INCIDENT_CANCEL_SKIPPED_STATUS);
    }
    lifeActionSnapshot = {
      type: CANCEL_INCIDENT_ACTION,
      incident_id: commitRequest.incident_id,
      reason: commitRequest.reason
    };
    activeIncident = readActiveIncidentForCancel(sourceEvent, activeIncidentSource);
    if (activeIncident.incident_id !== commitRequest.incident_id) {
      throw new LifeIncidentCancelCommitValidationError(
        'life_action.incident_id must match the current active incident.',
        { code: 'incident_id_mismatch' }
      );
    }

    const commitTime = clockTimestamp(clock);
    request = { ...commitRequest, commit_time: commitTime };
    cancelledIncident = buildCancelledLifeIncidentSnapshot(activeIncident, request);
    committedLogEntry = buildLifeIncidentCancelledLogEntry(
      sourceEvent,
      roleModelResult,
      lifeActionSnapshot,
      activeIncident,
      cancelledIncident,
      { idGenerator, clock: clockAt(commitTime) }
    );
    finalizeRequest = buildLifeIncidentCancelFinalizeRequest(request, {
      activeIncident,
      cancelledIncident,
      committedLogEntry
    });
    callCancelRawLogRequirement(lifeIncidentCancelFinalizer, rawEventLog);
    let finalizeResult: unknown;
    try {
      finalizeResult = lifeIncidentCancelFinalizer.finalizeLifeIncidentCancel(
        structuredClone(finalizeRequest)
      );
    } catch (error) {
      if (error instanceof LifeIncidentCancelFinalizerError) {
        throw error;
      }
      if (error instanceof RawEventLogQueryValidationError) {
        throw new LifeIncidentCancelFinalizerError(error.message, {
          code: 'malformed_finalize_result'
        });
      }
      throw new LifeIncidentCancelFinalizerError(
        `finalize_life_incident_cancel failed unexpectedly: ${errorMessage(error)}`,
        { code: 'finalize_rejected' }
      );
    }
    const validatedFinalizeResult = validateLifeIncidentCancelFinalizeResult(finalizeResult, {
      sourceIdentity,
      committedLogEntry
    });
    try {
      confirmCommittedSuccessEntryVisibility(rawEventLog, committedLogEntry);
    } catch (error) {
      if (error instanceof RawEventLogQueryValidationError) {
        throw new LifeIncidentCancelFinalizerError(error.message, {
          code: 'malformed_finalize_result'
        });
      }
      throw error;
    }
    try {
      lifeIncidentCancelFinalizer.completeLifeIncidentCancelAfterLogVisible(
        structuredClone(finalizeRequest)
      );
    } catch (error) {
      if (error instanceof LifeIncidentCancelFinalizerError) {
        throw error;
      }
      if (error instanceof RawEventLogQueryValidationError) {
        throw new LifeIncidentCancelFinalizerError(error.message, {
          code: 'malformed_finalize_result'
        });
      }
      throw new LifeIncidentCancelFinalizerError(
        `complete_life_incident_cancel_after_log_visible failed unexpectedly: ${errorMessage(error)}`,
        { code: 'finalize_rejected' }
      );
    }
    return {
      ...buildStatusResult(sourceIdentity, LIFE_INCIDENT_CANCELLED_STATUS),
      cancelled_incident: structuredClone(cancelledIncident),
      committed_log_entry_id: validatedFinalizeResult.committed_log_entry_id
    };
  } catch (error) {
    if (error instanceof LifeIncidentCancelFinalizerError) {
      discardCommittedSuccessEntryVisibility(rawEventLog, committedLogEntry);
      const failure = buildFailure(
        LIFE_INCIDENT_CANCEL_FINALIZE_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentCancelRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          lifeActionSnapshot,
          activeIncidentSnapshot: activeIncident,
          cancelledIncidentSnapshot: cancelledIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildRejectedResult(sourceIdentity, failure);
    }
    if (error instanceof LifeIncidentCancelCommitValidationError) {
      const failure = buildFailure(
        LIFE_INCIDENT_CANCEL_COMMIT_VALIDATION_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentCancelRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          lifeActionSnapshot,
          activeIncidentSnapshot: activeIncident,
          cancelledIncidentSnapshot: cancelledIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildRejectedResult(sourceIdentity, failure);
    }
    throw error;
  }
}

export function buildCancelledLifeIncidentSnapshot(
  activeIncident: unknown,
  commitRequest: unknown
): CancelledIncidentSnapshot {
  const active = validateActiveIncidentForCommit(activeIncident);
  const request = validateCancelCommitRequest(commitRequest);
  const snapshot: CancelledIncidentSnapshot = {
    schema_version: SCHEMA_VERSION,
    incident_id: active.incident_id,
    type: active.type,
    status: 'cancelled',
    title: active.title,
    interrupt_policy: active.interrupt_policy,
    resume_policy: active.resume_policy,
    cancelled_at: request.commit_time,
    cancellation_reason: request.reason,
    source_event_ids: appendSourceEventIdOnce(active.source_event_ids, request.event_id)
  };
  copyOptionalIncidentFields(snapshot, active);
  return validateCancelledLifeIncidentSnapshot(snapshot, {
    activeIncident: active,
    commitRequest: request
  });
}

export function buildLifeIncidentCancelledLogEntry(
  sourceEvent: unknown,
  roleModelResult: unknown,
  lifeAction: unknown,
  activeIncident: unknown,
  cancelledIncident: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): LifeIncidentCancelledLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const normalizedLifeAction = normalizeCancelLifeAction(lifeAction);
  const active = validateActiveIncidentForCommit(activeIncident);
  const commitRequest: LifeIncidentCancelPrepareRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    decision_action: VISIBLE_REPLY_ACTION,
    life_action_type: CANCEL_INCIDENT_ACTION,
    incident_id: normalizedLifeAction.incident_id,
    reason: normalizedLifeAction.reason,
    commit_time: getTransitionTime(cancelledIncident, 'cancelled_at')
  };
  const cancelled = validateCancelledLifeIncidentSnapshot(cancelledIncident, {
    activeIncident: active,
    commitRequest
  });
  const entry = buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: LIFE_INCIDENT_CANCELLED_KIND,
    data: {
      source_event: event,
      role_model_result: result,
      life_action: normalizedLifeAction,
      active_incident: active,
      cancelled_incident: cancelled
    },
    idGenerator,
    clock
  });
  return { ...entry, kind: LIFE_INCIDENT_CANCELLED_KIND };
}

export function buildLifeIncidentCancelFinalizeRequest(
  commitRequest: unknown,
  {
    activeIncident,
    cancelledIncident,
    committedLogEntry
  }: {
    activeIncident: unknown;
    cancelledIncident: unknown;
    committedLogEntry: unknown;
  }
): LifeIncidentCancelFinalizeRequest {
  const request = validateCancelCommitRequest(commitRequest);
  const active = validateActiveIncidentForCommit(activeIncident);
  const cancelled = validateCancelledLifeIncidentSnapshot(cancelledIncident, {
    activeIncident: active,
    commitRequest: request
  });
  const entry = validateCommittedLogEntry(committedLogEntry, {
    sourceIdentity: request,
    kind: LIFE_INCIDENT_CANCELLED_KIND
  });
  return {
    ...structuredClone(request),
    active_incident: active,
    cancelled_incident: cancelled,
    committed_log_entry: { ...entry, kind: LIFE_INCIDENT_CANCELLED_KIND }
  };
}

export function validateLifeIncidentCancelFinalizeResult(
  finalizeResult: unknown,
  {
    sourceIdentity,
    committedLogEntry
  }: {
    sourceIdentity: SourceIdentity;
    committedLogEntry: unknown;
  }
): LifeIncidentCancelFinalizeResult {
  const result = asFinalizerRecord(finalizeResult, 'LifeIncidentCancelFinalizeResult');
  wrapFinalizerContractError(() => {
    rejectExtraKeys(
      result,
      ['schema_version', 'trace_id', 'event_id', 'event_type', 'committed_log_entry_id'],
      'LifeIncidentCancelFinalizeResult'
    );
  });
  const entry = asFinalizerRecord(committedLogEntry, 'committed_log_entry');
  const expectedLogId = wrapFinalizerContractError(() =>
    requireString(getOwnField(entry, 'log_id'), 'committed_log_entry.log_id')
  );
  const normalized: LifeIncidentCancelFinalizeResult = {
    schema_version: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentCancelFinalizeResult.schema_version'
      )
    ),
    trace_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'trace_id'), 'LifeIncidentCancelFinalizeResult.trace_id')
    ),
    event_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'event_id'), 'LifeIncidentCancelFinalizeResult.event_id')
    ),
    event_type: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'event_type'),
        sourceIdentity.event_type,
        'LifeIncidentCancelFinalizeResult.event_type'
      )
    ),
    committed_log_entry_id: wrapFinalizerContractError(() =>
      requireString(
        getOwnField(result, 'committed_log_entry_id'),
        'LifeIncidentCancelFinalizeResult.committed_log_entry_id'
      )
    )
  };
  if (normalized.trace_id !== sourceIdentity.trace_id) {
    throw new LifeIncidentCancelFinalizerError(
      'LifeIncidentCancelFinalizeResult.trace_id must match source_event.trace_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.event_id !== sourceIdentity.event_id) {
    throw new LifeIncidentCancelFinalizerError(
      'LifeIncidentCancelFinalizeResult.event_id must match source_event.event_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.committed_log_entry_id !== expectedLogId) {
    throw new LifeIncidentCancelFinalizerError(
      'LifeIncidentCancelFinalizeResult.committed_log_entry_id must match committed_log_entry.log_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  return normalized;
}

export function buildLifeIncidentCancelRejectedLogEntry(
  sourceEvent: unknown,
  {
    roleModelResultSnapshot,
    lifeActionSnapshot,
    activeIncidentSnapshot,
    cancelledIncidentSnapshot,
    failure,
    idGenerator,
    clock
  }: {
    roleModelResultSnapshot: unknown;
    lifeActionSnapshot?: unknown;
    activeIncidentSnapshot?: unknown;
    cancelledIncidentSnapshot?: unknown;
    failure: IncidentFailure;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  const data: Record<string, unknown> = {
    source_event: snapshotRawValue(sourceEvent),
    role_model_result_snapshot: snapshotRawValue(roleModelResultSnapshot),
    failure: validateFailure(failure)
  };
  if (lifeActionSnapshot !== undefined) {
    data['life_action_snapshot'] = snapshotRawValue(lifeActionSnapshot);
  }
  if (activeIncidentSnapshot !== undefined) {
    data['active_incident_snapshot'] = snapshotRawValue(activeIncidentSnapshot);
  }
  if (cancelledIncidentSnapshot !== undefined) {
    data['cancelled_incident_snapshot'] = snapshotRawValue(cancelledIncidentSnapshot);
  }
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: LIFE_INCIDENT_CANCEL_REJECTED_KIND,
    data,
    idGenerator,
    clock
  });
}

export function validateCancelledLifeIncidentSnapshot(
  snapshot: unknown,
  {
    activeIncident,
    commitRequest
  }: {
    activeIncident: unknown;
    commitRequest: unknown;
  }
): CancelledIncidentSnapshot {
  const record = asCommitRecord(snapshot, 'CancelledLifeIncidentSnapshot');
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
        'cancelled_at',
        'cancellation_reason',
        'source_event_ids'
      ],
      'CancelledLifeIncidentSnapshot'
    );
  });
  const active = validateActiveIncidentForCommit(activeIncident);
  const request = validateCancelCommitRequest(commitRequest);
  const normalized: CancelledIncidentSnapshot = {
    schema_version: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(record, 'schema_version'),
        SCHEMA_VERSION,
        'CancelledLifeIncidentSnapshot.schema_version'
      )
    ),
    incident_id: wrapCommitContractError(() =>
      requireString(
        getOwnField(record, 'incident_id'),
        'CancelledLifeIncidentSnapshot.incident_id'
      )
    ),
    type: requireMatchingField(record, active, 'type', 'cancelled_incident'),
    status: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(record, 'status'),
        'cancelled',
        'CancelledLifeIncidentSnapshot.status'
      )
    ),
    title: requireMatchingField(record, active, 'title', 'cancelled_incident'),
    interrupt_policy: requireMatchingField(
      record,
      active,
      'interrupt_policy',
      'cancelled_incident'
    ),
    resume_policy: requireMatchingField(record, active, 'resume_policy', 'cancelled_incident'),
    cancelled_at: wrapCommitContractError(() =>
      validateIso8601Timestamp(
        getOwnField(record, 'cancelled_at'),
        'CancelledLifeIncidentSnapshot.cancelled_at'
      )
    ),
    cancellation_reason: wrapCommitContractError(() =>
      requireString(
        getOwnField(record, 'cancellation_reason'),
        'CancelledLifeIncidentSnapshot.cancellation_reason'
      )
    ),
    source_event_ids: validateTransitionSourceEventIds(record, active, request, 'cancelled_incident')
  };
  if (normalized.incident_id !== active.incident_id) {
    throw new LifeIncidentCancelCommitValidationError(
      'cancelled_incident.incident_id must match active_incident.incident_id.'
    );
  }
  if (normalized.incident_id !== request.incident_id) {
    throw new LifeIncidentCancelCommitValidationError(
      'cancelled_incident.incident_id must match LifeIncidentCancelCommitRequest.incident_id.'
    );
  }
  if (normalized.cancelled_at !== request.commit_time) {
    throw new LifeIncidentCancelCommitValidationError(
      'cancelled_incident.cancelled_at must match commit_time.'
    );
  }
  if (normalized.cancellation_reason !== request.reason) {
    throw new LifeIncidentCancelCommitValidationError(
      'cancelled_incident.cancellation_reason must match reason.'
    );
  }
  copyValidatedOptionalIncidentFields(normalized, record, active, 'cancelled_incident');
  return normalized;
}

function validateSourceEvent(sourceEvent: unknown): UserMessageRuntimeEvent {
  return wrapCommitContractError(() =>
    validateNormalizedUserMessageEvent(sourceEvent, 'source_event')
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
            allowedLifeActionType: CANCEL_INCIDENT_ACTION
          },
          'CharacterDecision'
        )
    })
  );
}

function normalizeCancelLifeAction(lifeAction: unknown): {
  type: typeof CANCEL_INCIDENT_ACTION;
  incident_id: string;
  reason: string;
} {
  return wrapCommitContractError(() => normalizeCancelIncidentLifeAction(lifeAction, 'life_action'));
}

function validateCancelCommitRequest(commitRequest: unknown): LifeIncidentCancelPrepareRequest {
  const request = asCommitRecord(commitRequest, 'LifeIncidentCancelCommitRequest');
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
        'reason',
        'commit_time',
        'user_id',
        'conversation_id'
      ],
      'LifeIncidentCancelCommitRequest'
    );
  });
  const normalized: LifeIncidentCancelPrepareRequest = {
    schema_version: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentCancelCommitRequest.schema_version'
      )
    ),
    trace_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'trace_id'), 'LifeIncidentCancelCommitRequest.trace_id')
    ),
    event_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'event_id'), 'LifeIncidentCancelCommitRequest.event_id')
    ),
    event_type: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'event_type'),
        USER_MESSAGE,
        'LifeIncidentCancelCommitRequest.event_type'
      )
    ),
    decision_action: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'decision_action'),
        VISIBLE_REPLY_ACTION,
        'LifeIncidentCancelCommitRequest.decision_action'
      )
    ),
    life_action_type: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'life_action_type'),
        CANCEL_INCIDENT_ACTION,
        'LifeIncidentCancelCommitRequest.life_action_type'
      )
    ),
    incident_id: wrapCommitContractError(() =>
      requireString(
        getOwnField(request, 'incident_id'),
        'LifeIncidentCancelCommitRequest.incident_id'
      ).trim()
    ),
    reason: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'reason'), 'LifeIncidentCancelCommitRequest.reason').trim()
    ),
    commit_time: validateTimestampForCommit(
      getOwnField(request, 'commit_time'),
      'LifeIncidentCancelCommitRequest.commit_time'
    )
  };
  copyOptionalIdentityFieldsFromRecord(
    request,
    normalized,
    'LifeIncidentCancelCommitRequest'
  );
  return normalized;
}

function readActiveIncidentForCancel(
  sourceEvent: unknown,
  activeIncidentSource: ActiveIncidentSource
): ActiveIncidentSnapshot {
  const event = validateSourceEvent(sourceEvent);
  const request = buildActiveIncidentRequest(event);
  let activeIncident: unknown;
  try {
    activeIncident = activeIncidentSource.readActiveIncident(structuredClone(request));
  } catch (error) {
    throw new LifeIncidentCancelCommitValidationError(
      `active_incident_source.read_active_incident failed unexpectedly: ${errorMessage(error)}`,
      { code: 'active_incident_source_error' }
    );
  }
  if (activeIncident === null || activeIncident === undefined) {
    throw new LifeIncidentCancelCommitValidationError(
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
      throw new LifeIncidentCancelCommitValidationError(error.message, { code: error.code });
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
    sourceIdentity: SourceIdentity | LifeIncidentCancelPrepareRequest;
    kind: string;
  }
): RawEventLogEntry {
  return validateCommittedIncidentLogEntry(committedLogEntry, {
    sourceIdentity,
    kind,
    makeError: (message) => new LifeIncidentCancelCommitValidationError(message)
  });
}

function extractTrustedSourceIdentity(sourceEvent: unknown): SourceIdentity {
  const sourceRecord = asCommitRecord(sourceEvent, 'source_event');
  return {
    trace_id: wrapCommitContractError(() =>
      requireString(getOwnField(sourceRecord, 'trace_id'), 'trace_id')
    ),
    event_id: wrapCommitContractError(() =>
      requireString(getOwnField(sourceRecord, 'event_id'), 'event_id')
    ),
    event_type: USER_MESSAGE
  };
}

function buildStatusResult<Status extends string>(
  sourceIdentity: SourceIdentity,
  status: Status
): {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: Status;
} {
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    event_type: USER_MESSAGE,
    status
  };
}

function buildRejectedResult(
  sourceIdentity: SourceIdentity,
  failure: IncidentFailure
): Extract<LifeIncidentCancelCommitResult, { status: typeof LIFE_INCIDENT_CANCEL_REJECTED_STATUS }> {
  return {
    ...buildStatusResult(sourceIdentity, LIFE_INCIDENT_CANCEL_REJECTED_STATUS),
    failure: structuredClone(failure)
  };
}

function buildFailure(stage: FailureStage, code: string, message: string): IncidentFailure {
  const supportedCodes = FAILURE_CODES_BY_STAGE[stage];
  const normalizedCode = includesString(supportedCodes, code) ? code : fallbackCode(stage);
  return { stage, code: normalizedCode, message };
}

function fallbackCode(stage: FailureStage): string {
  return stage === LIFE_INCIDENT_CANCEL_FINALIZE_STAGE
    ? 'malformed_finalize_result'
    : 'malformed_commit_input';
}

function validateFailure(failure: unknown): IncidentFailure {
  const failureRecord = asCommitRecord(failure, 'failure');
  wrapCommitContractError(() => {
    rejectExtraKeys(failureRecord, ['stage', 'code', 'message'], 'failure');
  });
  const stage = wrapCommitContractError(() =>
    requireString(getOwnField(failureRecord, 'stage'), 'failure.stage')
  );
  if (!Object.hasOwn(FAILURE_CODES_BY_STAGE, stage)) {
    throw new LifeIncidentCancelCommitValidationError(
      'failure.stage must be a supported incident-cancel failure stage.'
    );
  }
  const typedStage = stage as FailureStage;
  const code = wrapCommitContractError(() =>
    requireString(getOwnField(failureRecord, 'code'), 'failure.code')
  );
  if (!includesString(FAILURE_CODES_BY_STAGE[typedStage], code)) {
    throw new LifeIncidentCancelCommitValidationError(
      'failure.code must be supported for failure.stage.'
    );
  }
  return {
    stage: typedStage,
    code,
    message: wrapCommitContractError(() =>
      requireString(getOwnField(failureRecord, 'message'), 'failure.message')
    )
  };
}

function copyOptionalPayloadIdentityFields(
  event: UserMessageRuntimeEvent,
  request: LifeIncidentCancelCommitRequest
): void {
  if (event.payload.user_id !== undefined) {
    request.user_id = event.payload.user_id;
  }
  if (event.payload.conversation_id !== undefined) {
    request.conversation_id = event.payload.conversation_id;
  }
}

function copyOptionalIdentityFieldsFromRecord(
  input: ValueRecord,
  output: LifeIncidentCancelCommitRequest | LifeIncidentCancelPrepareRequest,
  sourceName: string
): void {
  for (const fieldName of ['user_id', 'conversation_id'] as const) {
    if (Object.hasOwn(input, fieldName)) {
      const value = getOwnField(input, fieldName);
      if (value !== undefined && value !== null) {
        output[fieldName] = wrapCommitContractError(() =>
          requireOptionalString(value, `${sourceName}.${fieldName}`)
        );
      }
    }
  }
}

function copyOptionalIncidentFields(
  snapshot: CancelledIncidentSnapshot,
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
  output: CancelledIncidentSnapshot,
  record: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  snapshotName: string
): void {
  const startedAt = activeIncident.started_at;
  if (startedAt !== undefined) {
    requireMatchingExact(record, startedAt, 'started_at', snapshotName);
    output.started_at = startedAt;
  } else if (Object.hasOwn(record, 'started_at')) {
    throw new LifeIncidentCancelCommitValidationError(
      `${snapshotName}.started_at must be omitted when active_incident omits it.`
    );
  }
  const expectedEndAt = activeIncident.expected_end_at;
  if (expectedEndAt !== undefined) {
    requireMatchingExact(record, expectedEndAt, 'expected_end_at', snapshotName);
    output.expected_end_at = expectedEndAt;
  } else if (Object.hasOwn(record, 'expected_end_at')) {
    throw new LifeIncidentCancelCommitValidationError(
      `${snapshotName}.expected_end_at must be omitted when active_incident omits it.`
    );
  }
  const remainingSeconds = activeIncident.remaining_seconds;
  if (remainingSeconds !== undefined) {
    requireMatchingExact(record, remainingSeconds, 'remaining_seconds', snapshotName);
    output.remaining_seconds = remainingSeconds;
  } else if (Object.hasOwn(record, 'remaining_seconds')) {
      throw new LifeIncidentCancelCommitValidationError(
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
    throw new LifeIncidentCancelCommitValidationError(
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
    throw new LifeIncidentCancelCommitValidationError(
      `${snapshotName}.${fieldName} must match active_incident.${fieldName}.`
    );
  }
  return activeIncident[fieldName];
}

function validateTransitionSourceEventIds(
  snapshot: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  request: LifeIncidentCancelPrepareRequest,
  snapshotName: string
): string[] {
  const value = getOwnField(snapshot, 'source_event_ids');
  if (!Array.isArray(value)) {
    throw new LifeIncidentCancelCommitValidationError(
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
    throw new LifeIncidentCancelCommitValidationError(
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

function callCancelRawLogRequirement(
  finalizer: LifeIncidentCancelFinalizer,
  rawEventLog: RawEventLog
): void {
  const requireSpecific = finalizer.requireLifeIncidentCancelRawEventLog;
  const requireGeneric = finalizer.requireRawEventLog;
  try {
    if (requireSpecific !== undefined) {
      requireSpecific.call(finalizer, rawEventLog);
    } else if (requireGeneric !== undefined) {
      requireGeneric.call(finalizer, rawEventLog);
    }
  } catch (error) {
    if (error instanceof LifeIncidentCancelFinalizerError) {
      throw error;
    }
    throw new LifeIncidentCancelFinalizerError(errorMessage(error), {
      code:
        error instanceof RawEventLogQueryValidationError
          ? 'malformed_finalize_result'
          : 'finalize_rejected'
    });
  }
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
      throw new LifeIncidentCancelCommitValidationError(error.message, { code });
    }
    throw error;
  }
}

function wrapFinalizerContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentCancelFinalizerError(error.message, {
        code: 'malformed_finalize_result'
      });
    }
    throw error;
  }
}

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
