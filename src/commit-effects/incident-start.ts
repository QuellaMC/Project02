import {
  START_INCIDENT_ACTION,
  USER_MESSAGE,
  VISIBLE_REPLY_ACTION,
  ContractValidationError,
  normalizeRoleModelTurnResult,
  normalizeStartIncidentLifeAction,
  normalizeVisibleReplyDecisionWithOptionalLifeAction,
  validateNormalizedUserMessageEvent,
  type RoleModelTurnResult,
  type StartIncidentLifeAction,
  type UserMessageRuntimeEvent
} from '../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../runtime/schema.ts';
import {
  RawEventLogQueryValidationError,
  buildRawLogEntry,
  clockTimestamp,
  confirmCommittedSuccessEntryVisibility,
  discardCommittedSuccessEntryVisibility,
  generateId,
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
  validateActiveIncidentSnapshot,
  type ActiveIncidentSnapshot
} from '../character/state/current.ts';

export const LIFE_INCIDENT_STARTED_STATUS = 'life_incident_started';
export const LIFE_INCIDENT_START_SKIPPED_STATUS = 'life_incident_start_skipped';
export const LIFE_INCIDENT_START_REJECTED_STATUS = 'life_incident_start_rejected';
export const LIFE_INCIDENT_STARTED_KIND = 'life_incident_started';
export const LIFE_INCIDENT_START_REJECTED_KIND = 'life_incident_start_rejected';
export const LIFE_INCIDENT_START_COMMIT_VALIDATION_STAGE =
  'life_incident_start_commit_validation';
export const LIFE_INCIDENT_START_FINALIZE_STAGE = 'life_incident_start_finalize';

const FAILURE_CODES_BY_STAGE = {
  [LIFE_INCIDENT_START_COMMIT_VALIDATION_STAGE]: [
    'malformed_commit_input',
    'identity_mismatch',
    'unsupported_result_status',
    'unsupported_action',
    'empty_reply_text'
  ],
  [LIFE_INCIDENT_START_FINALIZE_STAGE]: [
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

export type LifeIncidentStartCommitRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  decision_action: typeof VISIBLE_REPLY_ACTION;
  life_action_type: typeof START_INCIDENT_ACTION;
  draft: StartIncidentLifeAction['incident'];
  user_id?: string;
  conversation_id?: string;
};

export type LifeIncidentStartPrepareRequest = LifeIncidentStartCommitRequest & {
  commit_time: string;
};

export type LifeIncidentStartedLogEntry = RawEventLogEntry & {
  kind: typeof LIFE_INCIDENT_STARTED_KIND;
};

export type LifeIncidentStartFinalizeRequest = LifeIncidentStartPrepareRequest & {
  started_incident: ActiveIncidentSnapshot;
  committed_log_entry: LifeIncidentStartedLogEntry;
};

export type LifeIncidentStartFinalizeResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  committed_log_entry_id: string;
};

export type LifeIncidentStartFinalizer = {
  finalizeLifeIncidentStart: (request: LifeIncidentStartFinalizeRequest) => unknown;
  requireRawEventLog?: (rawEventLog: RawEventLog) => void;
  completeLifeIncidentStartAfterLogVisible?: (
    request: LifeIncidentStartFinalizeRequest
  ) => void;
  discardLifeIncidentStartAfterLogNotVisible?: (
    request: LifeIncidentStartFinalizeRequest
  ) => void;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type LifeIncidentStartCommitResult =
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_START_SKIPPED_STATUS;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_STARTED_STATUS;
      started_incident: ActiveIncidentSnapshot;
      committed_log_entry_id: string;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_START_REJECTED_STATUS;
      failure: IncidentFailure;
    };

export class LifeIncidentStartCommitValidationError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'malformed_commit_input' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentStartCommitValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LifeIncidentStartFinalizerError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'finalize_rejected' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentStartFinalizerError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function buildLifeIncidentStartCommitRequest(
  sourceEvent: unknown,
  roleModelResult: unknown
): LifeIncidentStartCommitRequest | undefined {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const lifeAction = result.decision.life_action;
  if (lifeAction === undefined) {
    return undefined;
  }
  if (lifeAction.type !== START_INCIDENT_ACTION) {
    throw new LifeIncidentStartCommitValidationError(
      "life_action.type must be 'start_incident'.",
      { code: 'unsupported_action' }
    );
  }
  const request: LifeIncidentStartCommitRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    decision_action: VISIBLE_REPLY_ACTION,
    life_action_type: START_INCIDENT_ACTION,
    draft: structuredClone(lifeAction.incident)
  };
  copyOptionalPayloadIdentityFields(event, request);
  return request;
}

export function commitLifeIncidentStart(
  sourceEvent: unknown,
  roleModelResult: unknown,
  {
    lifeIncidentStartFinalizer,
    rawEventLog,
    idGenerator,
    clock
  }: {
    lifeIncidentStartFinalizer: LifeIncidentStartFinalizer;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): LifeIncidentStartCommitResult {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  let request: LifeIncidentStartPrepareRequest | undefined;
  let startedIncident: ActiveIncidentSnapshot | undefined;
  let committedLogEntry: LifeIncidentStartedLogEntry | undefined;
  let finalizeRequest: LifeIncidentStartFinalizeRequest | undefined;
  let successVisibilityConfirmed = false;

  try {
    const commitRequest = buildLifeIncidentStartCommitRequest(sourceEvent, roleModelResult);
    if (commitRequest === undefined) {
      return buildStatusResult(sourceIdentity, LIFE_INCIDENT_START_SKIPPED_STATUS);
    }

    const commitTime = clockTimestamp(clock);
    request = { ...commitRequest, commit_time: commitTime };
    startedIncident = buildStartedLifeIncidentSnapshot(sourceEvent, request.draft, {
      commitTime,
      idGenerator
    });
    committedLogEntry = buildLifeIncidentStartedLogEntry(
      sourceEvent,
      roleModelResult,
      request.draft,
      startedIncident,
      { idGenerator, clock: clockAt(commitTime) }
    );
    finalizeRequest = buildLifeIncidentStartFinalizeRequest(request, {
      startedIncident,
      committedLogEntry
    });
    callStartRawLogRequirement(lifeIncidentStartFinalizer, rawEventLog);
    let finalizeResult: unknown;
    try {
      finalizeResult = lifeIncidentStartFinalizer.finalizeLifeIncidentStart(
        structuredClone(finalizeRequest)
      );
    } catch (error) {
      if (error instanceof LifeIncidentStartFinalizerError) {
        throw error;
      }
      if (error instanceof RawEventLogQueryValidationError) {
        throw new LifeIncidentStartFinalizerError(error.message, {
          code: 'malformed_finalize_result'
        });
      }
      throw error;
    }
    const validatedFinalizeResult = validateLifeIncidentStartFinalizeResult(
      finalizeResult,
      {
        sourceIdentity,
        committedLogEntry
      }
    );
    try {
      confirmCommittedSuccessEntryVisibility(rawEventLog, committedLogEntry);
    } catch (error) {
      if (error instanceof RawEventLogQueryValidationError) {
        throw new LifeIncidentStartFinalizerError(error.message, {
          code: 'malformed_finalize_result'
        });
      }
      throw error;
    }
    successVisibilityConfirmed = true;
    try {
      completeStartAfterLogVisible(lifeIncidentStartFinalizer, finalizeRequest);
    } catch (error) {
      if (!(error instanceof LifeIncidentStartFinalizerError)) {
        throw error;
      }
    }
    return {
      ...buildStatusResult(sourceIdentity, LIFE_INCIDENT_STARTED_STATUS),
      started_incident: structuredClone(startedIncident),
      committed_log_entry_id: validatedFinalizeResult.committed_log_entry_id
    };
  } catch (error) {
    if (error instanceof LifeIncidentStartFinalizerError) {
      let failureError = error;
      if (!successVisibilityConfirmed) {
        discardCommittedSuccessEntryVisibility(rawEventLog, committedLogEntry);
        try {
          discardStartAfterLogNotVisible(lifeIncidentStartFinalizer, finalizeRequest);
        } catch (discardError) {
          if (discardError instanceof LifeIncidentStartFinalizerError) {
            failureError = discardError;
          } else {
            throw discardError;
          }
        }
      }
      const failure = buildFailure(
        LIFE_INCIDENT_START_FINALIZE_STAGE,
        failureError.code,
        failureError.message
      );
      rawEventLog.append(
        buildLifeIncidentStartRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          draftSnapshot: request?.draft,
          startedIncidentSnapshot: startedIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildRejectedResult(sourceIdentity, failure);
    }

    if (error instanceof LifeIncidentStartCommitValidationError) {
      const failure = buildFailure(
        LIFE_INCIDENT_START_COMMIT_VALIDATION_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentStartRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          draftSnapshot: request?.draft,
          startedIncidentSnapshot: startedIncident,
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

export function buildStartedLifeIncidentSnapshot(
  sourceEvent: unknown,
  draft: unknown,
  { commitTime, idGenerator }: { commitTime: string; idGenerator: IdGenerator }
): ActiveIncidentSnapshot {
  const event = validateSourceEvent(sourceEvent);
  const normalizedDraft = normalizeStartIncidentDraft(draft);
  const validatedCommitTime = validateTimestampForCommit(commitTime, 'commit_time');
  const snapshot: ActiveIncidentSnapshot = {
    schema_version: SCHEMA_VERSION,
    incident_id: generateId('incident', idGenerator),
    type: normalizedDraft.type,
    status: 'active',
    title: normalizedDraft.title,
    started_at: validatedCommitTime,
    interrupt_policy: normalizedDraft.interrupt_policy,
    resume_policy: normalizedDraft.resume_policy,
    source_event_ids: [event.event_id]
  };
  if (normalizedDraft.remaining_seconds !== undefined) {
    snapshot.remaining_seconds = normalizedDraft.remaining_seconds;
  }
  return validateStartedIncidentSnapshot(snapshot, {
    eventId: event.event_id,
    draft: normalizedDraft,
    commitTime: validatedCommitTime
  });
}

export function buildLifeIncidentStartedLogEntry(
  sourceEvent: unknown,
  roleModelResult: unknown,
  draft: unknown,
  startedIncident: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): LifeIncidentStartedLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const normalizedDraft = normalizeStartIncidentDraft(draft);
  const validatedStartedIncident = validateStartedIncidentSnapshot(startedIncident, {
    eventId: event.event_id,
    draft: normalizedDraft,
    commitTime: getStartedAt(startedIncident)
  });
  const entry = buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: LIFE_INCIDENT_STARTED_KIND,
    data: {
      source_event: event,
      role_model_result: result,
      draft: normalizedDraft,
      started_incident: validatedStartedIncident
    },
    idGenerator,
    clock
  });
  return { ...entry, kind: LIFE_INCIDENT_STARTED_KIND };
}

export function buildLifeIncidentStartFinalizeRequest(
  commitRequest: unknown,
  {
    startedIncident,
    committedLogEntry
  }: {
    startedIncident: unknown;
    committedLogEntry: unknown;
  }
): LifeIncidentStartFinalizeRequest {
  const request = validateStartCommitRequest(commitRequest, { requireCommitTime: true });
  const validatedStartedIncident = validateStartedIncidentSnapshot(startedIncident, {
    eventId: request.event_id,
    draft: request.draft,
    commitTime: request.commit_time
  });
  const validatedLogEntry = validateCommittedLogEntry(committedLogEntry, {
    sourceIdentity: request,
    kind: LIFE_INCIDENT_STARTED_KIND
  });
  return {
    ...structuredClone(request),
    started_incident: validatedStartedIncident,
    committed_log_entry: { ...validatedLogEntry, kind: LIFE_INCIDENT_STARTED_KIND }
  };
}

export function validateLifeIncidentStartFinalizeResult(
  finalizeResult: unknown,
  {
    sourceIdentity,
    committedLogEntry
  }: {
    sourceIdentity: SourceIdentity;
    committedLogEntry: unknown;
  }
): LifeIncidentStartFinalizeResult {
  const result = asFinalizerRecord(finalizeResult, 'LifeIncidentStartFinalizeResult');
  wrapFinalizerContractError(() => {
    rejectExtraKeys(
      result,
      ['schema_version', 'trace_id', 'event_id', 'event_type', 'committed_log_entry_id'],
      'LifeIncidentStartFinalizeResult'
    );
  });
  const committedLogEntryRecord = asFinalizerRecord(
    committedLogEntry,
    'committed_log_entry'
  );
  const expectedLogId = wrapFinalizerContractError(() =>
    requireString(getOwnField(committedLogEntryRecord, 'log_id'), 'committed_log_entry.log_id')
  );
  const normalized: LifeIncidentStartFinalizeResult = {
    schema_version: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentStartFinalizeResult.schema_version'
      )
    ),
    trace_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'trace_id'), 'LifeIncidentStartFinalizeResult.trace_id')
    ),
    event_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'event_id'), 'LifeIncidentStartFinalizeResult.event_id')
    ),
    event_type: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'event_type'),
        sourceIdentity.event_type,
        'LifeIncidentStartFinalizeResult.event_type'
      )
    ),
    committed_log_entry_id: wrapFinalizerContractError(() =>
      requireString(
        getOwnField(result, 'committed_log_entry_id'),
        'LifeIncidentStartFinalizeResult.committed_log_entry_id'
      )
    )
  };
  if (normalized.trace_id !== sourceIdentity.trace_id) {
    throw new LifeIncidentStartFinalizerError(
      'LifeIncidentStartFinalizeResult.trace_id must match source_event.trace_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.event_id !== sourceIdentity.event_id) {
    throw new LifeIncidentStartFinalizerError(
      'LifeIncidentStartFinalizeResult.event_id must match source_event.event_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.committed_log_entry_id !== expectedLogId) {
    throw new LifeIncidentStartFinalizerError(
      'LifeIncidentStartFinalizeResult.committed_log_entry_id must match committed_log_entry.log_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  return normalized;
}

export function buildLifeIncidentStartRejectedLogEntry(
  sourceEvent: unknown,
  {
    roleModelResultSnapshot,
    draftSnapshot,
    startedIncidentSnapshot,
    failure,
    idGenerator,
    clock
  }: {
    roleModelResultSnapshot: unknown;
    draftSnapshot?: unknown;
    startedIncidentSnapshot?: unknown;
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
  if (draftSnapshot !== undefined) {
    data['draft_snapshot'] = snapshotRawValue(draftSnapshot);
  }
  if (startedIncidentSnapshot !== undefined) {
    data['started_incident_snapshot'] = snapshotRawValue(startedIncidentSnapshot);
  }
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: LIFE_INCIDENT_START_REJECTED_KIND,
    data,
    idGenerator,
    clock
  });
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
            allowedLifeActionType: START_INCIDENT_ACTION
          },
          'CharacterDecision'
        )
    })
  );
}

function normalizeStartIncidentDraft(draft: unknown): StartIncidentLifeAction['incident'] {
  return wrapCommitContractError(
    () =>
      normalizeStartIncidentLifeAction(
        { type: START_INCIDENT_ACTION, incident: draft },
        'life_action'
      ).incident
  );
}

function validateStartCommitRequest(
  commitRequest: unknown,
  { requireCommitTime }: { requireCommitTime: true }
): LifeIncidentStartPrepareRequest {
  const request = asCommitRecord(commitRequest, 'LifeIncidentStartCommitRequest');
  const allowedKeys = [
    'schema_version',
    'trace_id',
    'event_id',
    'event_type',
    'decision_action',
    'life_action_type',
    'draft',
    'user_id',
    'conversation_id',
    'commit_time'
  ];
  wrapCommitContractError(() => {
    rejectExtraKeys(request, allowedKeys, 'LifeIncidentStartCommitRequest');
  });
  const normalized: LifeIncidentStartPrepareRequest = {
    schema_version: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentStartCommitRequest.schema_version'
      )
    ),
    trace_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'trace_id'), 'LifeIncidentStartCommitRequest.trace_id')
    ),
    event_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'event_id'), 'LifeIncidentStartCommitRequest.event_id')
    ),
    event_type: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'event_type'),
        USER_MESSAGE,
        'LifeIncidentStartCommitRequest.event_type'
      )
    ),
    decision_action: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'decision_action'),
        VISIBLE_REPLY_ACTION,
        'LifeIncidentStartCommitRequest.decision_action'
      )
    ),
    life_action_type: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'life_action_type'),
        START_INCIDENT_ACTION,
        'LifeIncidentStartCommitRequest.life_action_type'
      )
    ),
    draft: normalizeStartIncidentDraft(getOwnField(request, 'draft')),
    commit_time: validateTimestampForCommit(
      getOwnField(request, 'commit_time'),
      'LifeIncidentStartCommitRequest.commit_time'
    )
  };
  void requireCommitTime;
  copyOptionalIdentityFieldsFromRecord(
    request,
    normalized,
    'LifeIncidentStartCommitRequest'
  );
  return normalized;
}

function validateStartedIncidentSnapshot(
  snapshot: unknown,
  {
    eventId,
    draft,
    commitTime
  }: {
    eventId: string;
    draft: StartIncidentLifeAction['incident'];
    commitTime: unknown;
  }
): ActiveIncidentSnapshot {
  let validated: ActiveIncidentSnapshot;
  try {
    validated = validateActiveIncidentSnapshot(snapshot);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentStartCommitValidationError(error.message, { code: error.code });
    }
    throw error;
  }
  const validatedCommitTime = validateTimestampForCommit(commitTime, 'commit_time');
  if (validated.source_event_ids.length !== 1 || validated.source_event_ids[0] !== eventId) {
    throw new LifeIncidentStartCommitValidationError(
      'started_incident.source_event_ids must equal [source_event.event_id].'
    );
  }
  if (validated.started_at !== validatedCommitTime) {
    throw new LifeIncidentStartCommitValidationError(
      'started_incident.started_at must match commit_time.'
    );
  }
  for (const fieldName of ['type', 'title', 'interrupt_policy', 'resume_policy'] as const) {
    if (validated[fieldName] !== draft[fieldName]) {
      throw new LifeIncidentStartCommitValidationError(
        `started_incident.${fieldName} must match draft.${fieldName}.`
      );
    }
  }
  if (draft.remaining_seconds !== undefined) {
    if (validated.remaining_seconds !== draft.remaining_seconds) {
      throw new LifeIncidentStartCommitValidationError(
        'started_incident.remaining_seconds must match draft.remaining_seconds.'
      );
    }
  } else if (validated.remaining_seconds !== undefined) {
    throw new LifeIncidentStartCommitValidationError(
      'started_incident.remaining_seconds must be omitted when draft omits it.'
    );
  }
  return validated;
}

function validateCommittedLogEntry(
  committedLogEntry: unknown,
  {
    sourceIdentity,
    kind
  }: {
    sourceIdentity: SourceIdentity | LifeIncidentStartPrepareRequest;
    kind: string;
  }
): RawEventLogEntry {
  return validateCommittedIncidentLogEntry(committedLogEntry, {
    sourceIdentity,
    kind,
    makeError: (message) => new LifeIncidentStartCommitValidationError(message)
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
): Extract<LifeIncidentStartCommitResult, { status: typeof LIFE_INCIDENT_START_REJECTED_STATUS }> {
  return {
    ...buildStatusResult(sourceIdentity, LIFE_INCIDENT_START_REJECTED_STATUS),
    failure: structuredClone(failure)
  };
}

function buildFailure(stage: FailureStage, code: string, message: string): IncidentFailure {
  const supportedCodes = FAILURE_CODES_BY_STAGE[stage];
  const normalizedCode = includesString(supportedCodes, code) ? code : fallbackCode(stage);
  return { stage, code: normalizedCode, message };
}

function fallbackCode(stage: FailureStage): string {
  return stage === LIFE_INCIDENT_START_FINALIZE_STAGE
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
    throw new LifeIncidentStartCommitValidationError(
      'failure.stage must be a supported incident-start failure stage.'
    );
  }
  const code = wrapCommitContractError(() =>
    requireString(getOwnField(failureRecord, 'code'), 'failure.code')
  );
  const typedStage = stage as FailureStage;
  if (!includesString(FAILURE_CODES_BY_STAGE[typedStage], code)) {
    throw new LifeIncidentStartCommitValidationError(
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

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function copyOptionalPayloadIdentityFields(
  event: UserMessageRuntimeEvent,
  request: LifeIncidentStartCommitRequest
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
  output: LifeIncidentStartCommitRequest | LifeIncidentStartPrepareRequest,
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

function getStartedAt(snapshot: unknown): unknown {
  if (typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)) {
    return (snapshot as Record<string, unknown>)['started_at'];
  }
  return undefined;
}

function validateTimestampForCommit(value: unknown, fieldName: string): string {
  return wrapCommitContractError(() => validateIso8601Timestamp(value, fieldName));
}

function callStartRawLogRequirement(
  finalizer: LifeIncidentStartFinalizer,
  rawEventLog: RawEventLog
): void {
  if (finalizer.requireRawEventLog === undefined) {
    return;
  }
  try {
    finalizer.requireRawEventLog(rawEventLog);
  } catch (error) {
    if (error instanceof RawEventLogQueryValidationError) {
      throw new LifeIncidentStartFinalizerError(error.message, {
        code: 'malformed_finalize_result'
      });
    }
    throw error;
  }
}

function completeStartAfterLogVisible(
  finalizer: LifeIncidentStartFinalizer,
  finalizeRequest: LifeIncidentStartFinalizeRequest
): void {
  if (finalizer.completeLifeIncidentStartAfterLogVisible === undefined) {
    return;
  }
  try {
    finalizer.completeLifeIncidentStartAfterLogVisible(structuredClone(finalizeRequest));
  } catch (error) {
    if (error instanceof LifeIncidentStartFinalizerError) {
      throw error;
    }
    throw new LifeIncidentStartFinalizerError(
      `complete_life_incident_start_after_log_visible failed unexpectedly: ${errorMessage(error)}`,
      { code: 'finalize_rejected' }
    );
  }
}

function discardStartAfterLogNotVisible(
  finalizer: LifeIncidentStartFinalizer,
  finalizeRequest: LifeIncidentStartFinalizeRequest | undefined
): void {
  if (
    finalizer.discardLifeIncidentStartAfterLogNotVisible === undefined ||
    finalizeRequest === undefined
  ) {
    return;
  }
  try {
    finalizer.discardLifeIncidentStartAfterLogNotVisible(structuredClone(finalizeRequest));
  } catch (error) {
    if (error instanceof LifeIncidentStartFinalizerError) {
      throw error;
    }
    throw new LifeIncidentStartFinalizerError(
      `discard_life_incident_start_after_log_not_visible failed unexpectedly: ${errorMessage(error)}`,
      { code: 'finalize_rejected' }
    );
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
      throw new LifeIncidentStartCommitValidationError(error.message, { code });
    }
    throw error;
  }
}

function wrapFinalizerContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentStartFinalizerError(error.message, {
        code: 'malformed_finalize_result'
      });
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
