import {
  USER_MESSAGE,
  ContractValidationError,
  validateNormalizedUserMessageEvent,
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
  validateInterruptedIncidentSnapshot,
  type ActiveIncidentSnapshot,
  type ActiveIncidentSource,
  type InterruptedIncidentSnapshot
} from '../character/state/current.ts';

export const LIFE_INCIDENT_INTERRUPTED_STATUS = 'life_incident_interrupted';
export const LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS =
  'life_incident_continued_in_background';
export const LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS =
  'life_incident_protected_from_interruption';
export const LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS = 'life_incident_interrupt_skipped';
export const LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS = 'life_incident_interrupt_rejected';
export const LIFE_INCIDENT_INTERRUPTED_KIND = 'life_incident_interrupted';
export const LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND =
  'life_incident_continued_in_background';
export const LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_KIND =
  'life_incident_protected_from_interruption';
export const LIFE_INCIDENT_INTERRUPT_REJECTED_KIND = 'life_incident_interrupt_rejected';
export const LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE =
  'life_incident_interrupt_commit_validation';
export const LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE = 'life_incident_interrupt_finalize';

const FAILURE_CODES_BY_STAGE = {
  [LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE]: [
    'malformed_commit_input',
    'active_incident_source_error'
  ],
  [LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE]: [
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
type PolicyOutcome =
  | {
      status: typeof LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS;
      kind: typeof LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND;
      outcome: 'continued_in_background';
    }
  | {
      status: typeof LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS;
      kind: typeof LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_KIND;
      outcome: 'protected_from_interruption';
    };

export type LifeIncidentInterruptCommitRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  incident_id: string;
  user_id?: string;
  conversation_id?: string;
};

export type LifeIncidentInterruptPrepareRequest = LifeIncidentInterruptCommitRequest & {
  commit_time: string;
};

export type LifeIncidentInterruptedLogEntry = RawEventLogEntry & {
  kind: typeof LIFE_INCIDENT_INTERRUPTED_KIND;
};

export type LifeIncidentInterruptFinalizeRequest = LifeIncidentInterruptPrepareRequest & {
  active_incident: ActiveIncidentSnapshot;
  interrupted_incident: InterruptedIncidentSnapshot;
  committed_log_entry: LifeIncidentInterruptedLogEntry;
};

export type LifeIncidentInterruptFinalizeResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  committed_log_entry_id: string;
};

export type LifeIncidentInterruptFinalizer = {
  finalizeLifeIncidentInterrupt: (request: LifeIncidentInterruptFinalizeRequest) => unknown;
  completeLifeIncidentInterruptAfterLogVisible: (
    request: LifeIncidentInterruptFinalizeRequest
  ) => void;
  requireLifeIncidentInterruptRawEventLog?: (rawEventLog: RawEventLog) => void;
  requireRawEventLog?: (rawEventLog: RawEventLog) => void;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type LifeIncidentInterruptCommitResult =
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_INTERRUPTED_STATUS;
      interrupted_incident: InterruptedIncidentSnapshot;
      committed_log_entry_id: string;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status:
        | typeof LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS
        | typeof LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS;
      active_incident: ActiveIncidentSnapshot;
      committed_log_entry_id: string;
    }
  | {
      schema_version: SchemaVersion;
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      status: typeof LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS;
      failure: IncidentFailure;
    };

export class LifeIncidentInterruptCommitValidationError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'malformed_commit_input' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentInterruptCommitValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LifeIncidentInterruptFinalizerError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'finalize_rejected' }: { code?: string } = {}) {
    super(message);
    this.name = 'LifeIncidentInterruptFinalizerError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function buildLifeIncidentInterruptCommitRequest(
  sourceEvent: unknown,
  activeIncident: unknown
): LifeIncidentInterruptCommitRequest {
  const event = validateSourceEvent(sourceEvent);
  const active = validateActiveIncidentForCommit(activeIncident);
  const request: LifeIncidentInterruptCommitRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    incident_id: active.incident_id
  };
  copyOptionalPayloadIdentityFields(event, request);
  return validateInterruptCommitRequest(request, { requireCommitTime: false });
}

export function commitLifeIncidentInterruption(
  sourceEvent: unknown,
  {
    activeIncidentSource,
    lifeIncidentInterruptFinalizer,
    rawEventLog,
    idGenerator,
    clock
  }: {
    activeIncidentSource: ActiveIncidentSource;
    lifeIncidentInterruptFinalizer: LifeIncidentInterruptFinalizer;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): LifeIncidentInterruptCommitResult {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  let activeIncident: ActiveIncidentSnapshot | undefined;
  let interruptedIncident: InterruptedIncidentSnapshot | undefined;
  let committedLogEntry: LifeIncidentInterruptedLogEntry | undefined;
  let finalizeRequest: LifeIncidentInterruptFinalizeRequest | undefined;
  let successVisibilityConfirmed = false;

  try {
    const event = validateSourceEvent(sourceEvent);
    activeIncident = readActiveIncidentForInterruption(event, activeIncidentSource);
    if (activeIncident === undefined) {
      return buildStatusResult(sourceIdentity, LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS);
    }

    if (activeIncident.interrupt_policy === 'interruptible') {
      const commitRequest = buildLifeIncidentInterruptCommitRequest(event, activeIncident);
      const commitTime = clockTimestamp(clock);
      const request: LifeIncidentInterruptPrepareRequest = {
        ...commitRequest,
        commit_time: commitTime
      };
      interruptedIncident = buildInterruptedLifeIncidentSnapshot(activeIncident, request);
      committedLogEntry = buildLifeIncidentInterruptedLogEntry(
        event,
        activeIncident,
        interruptedIncident,
        { idGenerator, clock: clockAt(commitTime) }
      );
      finalizeRequest = buildLifeIncidentInterruptFinalizeRequest(request, {
        activeIncident,
        interruptedIncident,
        committedLogEntry
      });
      const validatedFinalizeResult = stageInterruptSuccess(
        lifeIncidentInterruptFinalizer,
        finalizeRequest,
        rawEventLog,
        { sourceIdentity, committedLogEntry }
      );
      try {
        confirmCommittedSuccessEntryVisibility(rawEventLog, committedLogEntry);
      } catch (error) {
        if (error instanceof RawEventLogQueryValidationError) {
          throw new LifeIncidentInterruptFinalizerError(error.message, {
            code: 'malformed_finalize_result'
          });
        }
        throw error;
      }
      successVisibilityConfirmed = true;
      try {
        completeAfterLogVisible(lifeIncidentInterruptFinalizer, finalizeRequest);
      } catch (error) {
        if (error instanceof LifeIncidentInterruptFinalizerError) {
          // Python parity: after success visibility, surface the completion
          // failure to the caller without appending a contradictory rejected log.
          return buildRejectedResult(
            sourceIdentity,
            buildFailure(LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE, error.code, error.message)
          );
        }
        throw error;
      }
      return {
        ...buildStatusResult(sourceIdentity, LIFE_INCIDENT_INTERRUPTED_STATUS),
        interrupted_incident: structuredClone(interruptedIncident),
        committed_log_entry_id: validatedFinalizeResult.committed_log_entry_id
      };
    }

    if (activeIncident.interrupt_policy === 'background') {
      return appendPolicyOutcomeLog(event, activeIncident, {
        rawEventLog,
        idGenerator,
        clock,
        status: LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS,
        kind: LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND,
        outcome: 'continued_in_background'
      });
    }

    return appendPolicyOutcomeLog(event, activeIncident, {
      rawEventLog,
      idGenerator,
      clock,
      status: LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS,
      kind: LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_KIND,
      outcome: 'protected_from_interruption'
    });
  } catch (error) {
    if (error instanceof LifeIncidentInterruptFinalizerError) {
      if (!successVisibilityConfirmed) {
        discardCommittedSuccessEntryVisibility(rawEventLog, committedLogEntry);
      }
      const failure = buildFailure(
        LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentInterruptRejectedLogEntry(sourceEvent, {
          activeIncidentSnapshot: activeIncident,
          interruptedIncidentSnapshot: interruptedIncident,
          failure,
          idGenerator,
          clock
        })
      );
      return buildRejectedResult(sourceIdentity, failure);
    }
    if (error instanceof LifeIncidentInterruptCommitValidationError) {
      const failure = buildFailure(
        LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLifeIncidentInterruptRejectedLogEntry(sourceEvent, {
          activeIncidentSnapshot: activeIncident,
          interruptedIncidentSnapshot: interruptedIncident,
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

export function buildInterruptedLifeIncidentSnapshot(
  activeIncident: unknown,
  commitRequest: unknown
): InterruptedIncidentSnapshot {
  const active = validateActiveIncidentForCommit(activeIncident);
  const request = validateInterruptPrepareRequest(commitRequest);
  if (active.interrupt_policy !== 'interruptible') {
    throw new LifeIncidentInterruptCommitValidationError(
      "active_incident.interrupt_policy must be 'interruptible'."
    );
  }
  const snapshot: InterruptedIncidentSnapshot = {
    schema_version: SCHEMA_VERSION,
    incident_id: active.incident_id,
    type: active.type,
    status: 'interrupted',
    title: active.title,
    interrupt_policy: 'interruptible',
    resume_policy: active.resume_policy,
    interrupted_at: request.commit_time,
    source_event_ids: appendSourceEventIdOnce(active.source_event_ids, request.event_id)
  };
  copyOptionalIncidentFields(snapshot, active);
  return validateInterruptedLifeIncidentSnapshot(snapshot, {
    activeIncident: active,
    commitRequest: request
  });
}

export function buildLifeIncidentInterruptedLogEntry(
  sourceEvent: unknown,
  activeIncident: unknown,
  interruptedIncident: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): LifeIncidentInterruptedLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const active = validateActiveIncidentForCommit(activeIncident);
  const commitRequest: LifeIncidentInterruptPrepareRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    incident_id: active.incident_id,
    commit_time: getTransitionTime(interruptedIncident, 'interrupted_at')
  };
  const interrupted = validateInterruptedLifeIncidentSnapshot(interruptedIncident, {
    activeIncident: active,
    commitRequest
  });
  const entry = buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: LIFE_INCIDENT_INTERRUPTED_KIND,
    data: {
      source_event: event,
      active_incident: active,
      interrupted_incident: interrupted
    },
    idGenerator,
    clock
  });
  return { ...entry, kind: LIFE_INCIDENT_INTERRUPTED_KIND };
}

export function buildLifeIncidentPolicyOutcomeLogEntry(
  sourceEvent: unknown,
  activeIncident: unknown,
  {
    kind,
    outcome,
    idGenerator,
    clock
  }: {
    kind: typeof LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND | typeof LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_KIND;
    outcome: 'continued_in_background' | 'protected_from_interruption';
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const active = validateActiveIncidentForCommit(activeIncident);
  if (kind === LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND) {
    if (active.interrupt_policy !== 'background' || outcome !== 'continued_in_background') {
      throw new LifeIncidentInterruptCommitValidationError(
        'background policy outcome must match active_incident.interrupt_policy.'
      );
    }
  } else {
    if (active.interrupt_policy !== 'protected' || outcome !== 'protected_from_interruption') {
      throw new LifeIncidentInterruptCommitValidationError(
        'protected policy outcome must match active_incident.interrupt_policy.'
      );
    }
  }
  return buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind,
    data: {
      source_event: event,
      active_incident: active,
      outcome
    },
    idGenerator,
    clock
  });
}

export function buildLifeIncidentInterruptFinalizeRequest(
  commitRequest: unknown,
  {
    activeIncident,
    interruptedIncident,
    committedLogEntry
  }: {
    activeIncident: unknown;
    interruptedIncident: unknown;
    committedLogEntry: unknown;
  }
): LifeIncidentInterruptFinalizeRequest {
  const request = validateInterruptPrepareRequest(commitRequest);
  const active = validateActiveIncidentForCommit(activeIncident);
  const interrupted = validateInterruptedLifeIncidentSnapshot(interruptedIncident, {
    activeIncident: active,
    commitRequest: request
  });
  const entry = validateCommittedLogEntry(committedLogEntry, {
    sourceIdentity: request,
    kind: LIFE_INCIDENT_INTERRUPTED_KIND
  });
  return {
    ...structuredClone(request),
    active_incident: active,
    interrupted_incident: interrupted,
    committed_log_entry: { ...entry, kind: LIFE_INCIDENT_INTERRUPTED_KIND }
  };
}

export function validateLifeIncidentInterruptFinalizeResult(
  finalizeResult: unknown,
  {
    sourceIdentity,
    committedLogEntry
  }: {
    sourceIdentity: SourceIdentity;
    committedLogEntry: unknown;
  }
): LifeIncidentInterruptFinalizeResult {
  const result = asFinalizerRecord(finalizeResult, 'LifeIncidentInterruptFinalizeResult');
  wrapFinalizerContractError(() => {
    rejectExtraKeys(
      result,
      ['schema_version', 'trace_id', 'event_id', 'event_type', 'committed_log_entry_id'],
      'LifeIncidentInterruptFinalizeResult'
    );
  });
  const entry = asFinalizerRecord(committedLogEntry, 'committed_log_entry');
  const expectedLogId = wrapFinalizerContractError(() =>
    requireString(getOwnField(entry, 'log_id'), 'committed_log_entry.log_id')
  );
  const normalized: LifeIncidentInterruptFinalizeResult = {
    schema_version: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentInterruptFinalizeResult.schema_version'
      )
    ),
    trace_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'trace_id'), 'LifeIncidentInterruptFinalizeResult.trace_id')
    ),
    event_id: wrapFinalizerContractError(() =>
      requireString(getOwnField(result, 'event_id'), 'LifeIncidentInterruptFinalizeResult.event_id')
    ),
    event_type: wrapFinalizerContractError(() =>
      requireLiteral(
        getOwnField(result, 'event_type'),
        sourceIdentity.event_type,
        'LifeIncidentInterruptFinalizeResult.event_type'
      )
    ),
    committed_log_entry_id: wrapFinalizerContractError(() =>
      requireString(
        getOwnField(result, 'committed_log_entry_id'),
        'LifeIncidentInterruptFinalizeResult.committed_log_entry_id'
      )
    )
  };
  if (normalized.trace_id !== sourceIdentity.trace_id) {
    throw new LifeIncidentInterruptFinalizerError(
      'LifeIncidentInterruptFinalizeResult.trace_id must match source_event.trace_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.event_id !== sourceIdentity.event_id) {
    throw new LifeIncidentInterruptFinalizerError(
      'LifeIncidentInterruptFinalizeResult.event_id must match source_event.event_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (normalized.committed_log_entry_id !== expectedLogId) {
    throw new LifeIncidentInterruptFinalizerError(
      'LifeIncidentInterruptFinalizeResult.committed_log_entry_id must match committed_log_entry.log_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  return normalized;
}

export function buildLifeIncidentInterruptRejectedLogEntry(
  sourceEvent: unknown,
  {
    activeIncidentSnapshot,
    interruptedIncidentSnapshot,
    failure,
    idGenerator,
    clock
  }: {
    activeIncidentSnapshot?: unknown;
    interruptedIncidentSnapshot?: unknown;
    failure: IncidentFailure;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  const data: Record<string, unknown> = {
    source_event: snapshotRawValue(sourceEvent),
    failure: validateFailure(failure)
  };
  if (activeIncidentSnapshot !== undefined) {
    data['active_incident_snapshot'] = snapshotRawValue(activeIncidentSnapshot);
  }
  if (interruptedIncidentSnapshot !== undefined) {
    data['interrupted_incident_snapshot'] = snapshotRawValue(interruptedIncidentSnapshot);
  }
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: LIFE_INCIDENT_INTERRUPT_REJECTED_KIND,
    data,
    idGenerator,
    clock
  });
}

export function validateInterruptedLifeIncidentSnapshot(
  snapshot: unknown,
  {
    activeIncident,
    commitRequest
  }: {
    activeIncident: unknown;
    commitRequest: unknown;
  }
): InterruptedIncidentSnapshot {
  let interrupted: InterruptedIncidentSnapshot;
  try {
    interrupted = validateInterruptedIncidentSnapshot(snapshot);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentInterruptCommitValidationError(error.message, { code: error.code });
    }
    throw error;
  }
  const active = validateActiveIncidentForCommit(activeIncident);
  const request = validateInterruptPrepareRequest(commitRequest);
  if (interrupted.incident_id !== active.incident_id) {
    throw new LifeIncidentInterruptCommitValidationError(
      'interrupted_incident.incident_id must match active_incident.incident_id.'
    );
  }
  if (interrupted.incident_id !== request.incident_id) {
    throw new LifeIncidentInterruptCommitValidationError(
      'interrupted_incident.incident_id must match LifeIncidentInterruptCommitRequest.incident_id.'
    );
  }
  if (interrupted.interrupted_at !== request.commit_time) {
    throw new LifeIncidentInterruptCommitValidationError(
      'interrupted_incident.interrupted_at must match commit_time.'
    );
  }
  const record = asCommitRecord(snapshot, 'InterruptedLifeIncidentSnapshot');
  requireMatchingField(record, active, 'type');
  requireMatchingField(record, active, 'title');
  requireMatchingField(record, active, 'interrupt_policy');
  requireMatchingField(record, active, 'resume_policy');
  interrupted.source_event_ids = validateTransitionSourceEventIds(
    record,
    active,
    request,
    'interrupted_incident'
  );
  copyValidatedOptionalIncidentFields(interrupted, record, active, 'interrupted_incident');
  return interrupted;
}

function validateSourceEvent(sourceEvent: unknown): UserMessageRuntimeEvent {
  return wrapCommitContractError(() =>
    validateNormalizedUserMessageEvent(sourceEvent, 'source_event')
  );
}

function validateInterruptPrepareRequest(
  commitRequest: unknown
): LifeIncidentInterruptPrepareRequest {
  const request = validateInterruptCommitRequest(commitRequest, { requireCommitTime: true });
  if (request.commit_time === undefined) {
    throw new LifeIncidentInterruptCommitValidationError(
      'LifeIncidentInterruptCommitRequest.commit_time must be an ISO-8601 timestamp string.'
    );
  }
  return request as LifeIncidentInterruptPrepareRequest;
}

function validateInterruptCommitRequest(
  commitRequest: unknown,
  { requireCommitTime }: { requireCommitTime: boolean }
): LifeIncidentInterruptCommitRequest & { commit_time?: string } {
  const request = asCommitRecord(commitRequest, 'LifeIncidentInterruptCommitRequest');
  const allowedKeys = [
    'schema_version',
    'trace_id',
    'event_id',
    'event_type',
    'incident_id',
    'user_id',
    'conversation_id'
  ];
  if (requireCommitTime || Object.hasOwn(request, 'commit_time')) {
    allowedKeys.push('commit_time');
  }
  wrapCommitContractError(() => {
    rejectExtraKeys(request, allowedKeys, 'LifeIncidentInterruptCommitRequest');
  });
  const normalized: LifeIncidentInterruptCommitRequest & { commit_time?: string } = {
    schema_version: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'schema_version'),
        SCHEMA_VERSION,
        'LifeIncidentInterruptCommitRequest.schema_version'
      )
    ),
    trace_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'trace_id'), 'LifeIncidentInterruptCommitRequest.trace_id')
    ),
    event_id: wrapCommitContractError(() =>
      requireString(getOwnField(request, 'event_id'), 'LifeIncidentInterruptCommitRequest.event_id')
    ),
    event_type: wrapCommitContractError(() =>
      requireLiteral(
        getOwnField(request, 'event_type'),
        USER_MESSAGE,
        'LifeIncidentInterruptCommitRequest.event_type'
      )
    ),
    incident_id: wrapCommitContractError(() =>
      requireString(
        getOwnField(request, 'incident_id'),
        'LifeIncidentInterruptCommitRequest.incident_id'
      ).trim()
    )
  };
  if (requireCommitTime || Object.hasOwn(request, 'commit_time')) {
    normalized.commit_time = validateTimestampForCommit(
      getOwnField(request, 'commit_time'),
      'LifeIncidentInterruptCommitRequest.commit_time'
    );
  }
  copyOptionalIdentityFieldsFromRecord(
    request,
    normalized,
    'LifeIncidentInterruptCommitRequest'
  );
  return normalized;
}

function readActiveIncidentForInterruption(
  sourceEvent: UserMessageRuntimeEvent,
  activeIncidentSource: ActiveIncidentSource
): ActiveIncidentSnapshot | undefined {
  const request = buildActiveIncidentRequest(sourceEvent);
  let activeIncident: unknown;
  try {
    activeIncident = activeIncidentSource.readActiveIncident(structuredClone(request));
  } catch (error) {
    throw new LifeIncidentInterruptCommitValidationError(
      `active_incident_source.read_active_incident failed unexpectedly: ${errorMessage(error)}`,
      { code: 'active_incident_source_error' }
    );
  }
  if (activeIncident === null || activeIncident === undefined) {
    return undefined;
  }
  return validateActiveIncidentForCommit(activeIncident);
}

function appendPolicyOutcomeLog(
  event: UserMessageRuntimeEvent,
  activeIncident: ActiveIncidentSnapshot,
  {
    rawEventLog,
    idGenerator,
    clock,
    status,
    kind,
    outcome
  }: {
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  } & PolicyOutcome
): Extract<
  LifeIncidentInterruptCommitResult,
  {
    status:
      | typeof LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS
      | typeof LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS;
  }
> {
  const committedLogEntry = buildLifeIncidentPolicyOutcomeLogEntry(event, activeIncident, {
    kind,
    outcome,
    idGenerator,
    clock
  });
  try {
    rawEventLog.append(committedLogEntry);
  } catch (error) {
    if (error instanceof RawEventLogQueryValidationError) {
      throw new LifeIncidentInterruptCommitValidationError(error.message, {
        code: 'malformed_commit_input'
      });
    }
    throw error;
  }
  return {
    ...buildStatusResult(extractTrustedSourceIdentity(event), status),
    active_incident: structuredClone(activeIncident),
    committed_log_entry_id: committedLogEntry.log_id
  };
}

function validateActiveIncidentForCommit(activeIncident: unknown): ActiveIncidentSnapshot {
  try {
    return validateActiveIncidentSnapshot(activeIncident);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentInterruptCommitValidationError(error.message, { code: error.code });
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
    sourceIdentity: SourceIdentity | LifeIncidentInterruptPrepareRequest;
    kind: string;
  }
): RawEventLogEntry {
  return validateCommittedIncidentLogEntry(committedLogEntry, {
    sourceIdentity,
    kind,
    makeError: (message) => new LifeIncidentInterruptCommitValidationError(message)
  });
}

function extractTrustedSourceIdentity(sourceEvent: unknown): SourceIdentity {
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
): Extract<LifeIncidentInterruptCommitResult, { status: typeof LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS }> {
  return {
    ...buildStatusResult(sourceIdentity, LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS),
    failure: structuredClone(failure)
  };
}

function buildFailure(stage: FailureStage, code: string, message: string): IncidentFailure {
  const supportedCodes = FAILURE_CODES_BY_STAGE[stage];
  const normalizedCode = includesString(supportedCodes, code) ? code : fallbackCode(stage);
  return { stage, code: normalizedCode, message };
}

function fallbackCode(stage: FailureStage): string {
  return stage === LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE
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
    throw new LifeIncidentInterruptCommitValidationError(
      'failure.stage must be a supported incident-interrupt failure stage.'
    );
  }
  const typedStage = stage as FailureStage;
  const code = wrapCommitContractError(() =>
    requireString(getOwnField(failureRecord, 'code'), 'failure.code')
  );
  if (!includesString(FAILURE_CODES_BY_STAGE[typedStage], code)) {
    throw new LifeIncidentInterruptCommitValidationError(
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

function stageInterruptSuccess(
  finalizer: LifeIncidentInterruptFinalizer,
  finalizeRequest: LifeIncidentInterruptFinalizeRequest,
  rawEventLog: RawEventLog,
  {
    sourceIdentity,
    committedLogEntry
  }: {
    sourceIdentity: SourceIdentity;
    committedLogEntry: LifeIncidentInterruptedLogEntry;
  }
): LifeIncidentInterruptFinalizeResult {
  callInterruptRawLogRequirement(finalizer, rawEventLog);
  let finalizeResult: unknown;
  try {
    finalizeResult = finalizer.finalizeLifeIncidentInterrupt(structuredClone(finalizeRequest));
  } catch (error) {
    if (error instanceof LifeIncidentInterruptFinalizerError) {
      throw error;
    }
    if (error instanceof RawEventLogQueryValidationError) {
      throw new LifeIncidentInterruptFinalizerError(error.message, {
        code: 'malformed_finalize_result'
      });
    }
    throw new LifeIncidentInterruptFinalizerError(
      `finalize_life_incident_interrupt failed unexpectedly: ${errorMessage(error)}`,
      { code: 'finalize_rejected' }
    );
  }
  return validateLifeIncidentInterruptFinalizeResult(finalizeResult, {
    sourceIdentity,
    committedLogEntry
  });
}

function completeAfterLogVisible(
  finalizer: LifeIncidentInterruptFinalizer,
  finalizeRequest: LifeIncidentInterruptFinalizeRequest
): void {
  try {
    finalizer.completeLifeIncidentInterruptAfterLogVisible(structuredClone(finalizeRequest));
  } catch (error) {
    if (error instanceof LifeIncidentInterruptFinalizerError) {
      throw error;
    }
    throw new LifeIncidentInterruptFinalizerError(
      `complete_life_incident_interrupt_after_log_visible failed unexpectedly: ${errorMessage(error)}`,
      { code: 'finalize_rejected' }
    );
  }
}

function callInterruptRawLogRequirement(
  finalizer: LifeIncidentInterruptFinalizer,
  rawEventLog: RawEventLog
): void {
  const requireSpecific = finalizer.requireLifeIncidentInterruptRawEventLog;
  const requireGeneric = finalizer.requireRawEventLog;
  try {
    if (requireSpecific !== undefined) {
      requireSpecific.call(finalizer, rawEventLog);
    } else if (requireGeneric !== undefined) {
      requireGeneric.call(finalizer, rawEventLog);
    }
  } catch (error) {
    if (error instanceof LifeIncidentInterruptFinalizerError) {
      throw error;
    }
    throw new LifeIncidentInterruptFinalizerError(errorMessage(error), {
      code:
        error instanceof RawEventLogQueryValidationError
          ? 'malformed_finalize_result'
          : 'finalize_rejected'
    });
  }
}

function copyOptionalPayloadIdentityFields(
  event: UserMessageRuntimeEvent,
  request: LifeIncidentInterruptCommitRequest
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
  output: LifeIncidentInterruptCommitRequest & { commit_time?: string },
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
  snapshot: InterruptedIncidentSnapshot,
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
  output: InterruptedIncidentSnapshot,
  record: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  snapshotName: string
): void {
  const startedAt = activeIncident.started_at;
  if (startedAt !== undefined) {
    requireMatchingExact(record, startedAt, 'started_at', snapshotName);
    output.started_at = startedAt;
  } else if (Object.hasOwn(record, 'started_at')) {
    throw new LifeIncidentInterruptCommitValidationError(
      `${snapshotName}.started_at must be omitted when active_incident omits it.`
    );
  }
  const expectedEndAt = activeIncident.expected_end_at;
  if (expectedEndAt !== undefined) {
    requireMatchingExact(record, expectedEndAt, 'expected_end_at', snapshotName);
    output.expected_end_at = expectedEndAt;
  } else if (Object.hasOwn(record, 'expected_end_at')) {
    throw new LifeIncidentInterruptCommitValidationError(
      `${snapshotName}.expected_end_at must be omitted when active_incident omits it.`
    );
  }
  const remainingSeconds = activeIncident.remaining_seconds;
  if (remainingSeconds !== undefined) {
    requireMatchingExact(record, remainingSeconds, 'remaining_seconds', snapshotName);
    output.remaining_seconds = remainingSeconds;
  } else if (Object.hasOwn(record, 'remaining_seconds')) {
    throw new LifeIncidentInterruptCommitValidationError(
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
    throw new LifeIncidentInterruptCommitValidationError(
      `${snapshotName}.${fieldName} must match active_incident.${fieldName}.`
    );
  }
}

function requireMatchingField<FieldName extends keyof ActiveIncidentSnapshot>(
  snapshot: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  fieldName: FieldName
): ActiveIncidentSnapshot[FieldName] {
  if (getOwnField(snapshot, fieldName) !== activeIncident[fieldName]) {
    throw new LifeIncidentInterruptCommitValidationError(
      `interrupted_incident.${fieldName} must match active_incident.${fieldName}.`
    );
  }
  return activeIncident[fieldName];
}

function validateTransitionSourceEventIds(
  snapshot: ValueRecord,
  activeIncident: ActiveIncidentSnapshot,
  request: LifeIncidentInterruptPrepareRequest,
  snapshotName: string
): string[] {
  const value = getOwnField(snapshot, 'source_event_ids');
  if (!Array.isArray(value)) {
    throw new LifeIncidentInterruptCommitValidationError(
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
    throw new LifeIncidentInterruptCommitValidationError(
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
      throw new LifeIncidentInterruptCommitValidationError(error.message, { code });
    }
    throw error;
  }
}

function wrapFinalizerContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LifeIncidentInterruptFinalizerError(error.message, {
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
