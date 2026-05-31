import {
  USER_MESSAGE,
  VISIBLE_REPLY_ACTION,
  ContractValidationError,
  normalizeLivingStatePatch,
  normalizeRoleModelTurnResult,
  normalizeVisibleReplyDecisionWithOptionalLivingStatePatch,
  validateNormalizedUserMessageEvent,
  type LivingStatePatch,
  type RoleModelTurnResult,
  type UserMessageRuntimeEvent
} from '../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../runtime/schema.ts';
import {
  asRecord,
  getOwnField,
  parseIso8601TimestampToUtcMicroseconds,
  rejectExtraKeys,
  requireLiteral,
  requireOptionalString,
  requireString,
  type ValueRecord
} from '../runtime/validation.ts';
import {
  buildRawLogEntry,
  clockTimestamp,
  snapshotRawValue,
  type Clock,
  type IdGenerator,
  type RawEventLogEntry
} from '../runtime/logging.ts';
import {
  validateCurrentCharacterStateSnapshot,
  type CharacterRuntimeStateSnapshot
} from '../character/state/current.ts';
import { runStagedCommitTransaction } from './incident-lifecycle.ts';

export const LIVING_STATE_PATCH_COMMITTED_STATUS = 'living_state_patch_committed';
export const LIVING_STATE_PATCH_SKIPPED_STATUS = 'living_state_patch_skipped';
export const LIVING_STATE_PATCH_REJECTED_STATUS = 'living_state_patch_rejected';
export const LIVING_STATE_PATCH_COMMITTED_KIND = 'living_state_patch_committed';
export const LIVING_STATE_PATCH_REJECTED_KIND = 'living_state_patch_rejected';
export const LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE =
  'living_state_patch_commit_validation';
export const LIVING_STATE_PATCH_STORE_STAGE = 'living_state_patch_store';
export const LIVING_STATE_PATCH_FINALIZE_STAGE = 'living_state_patch_finalize';

const COMMIT_VALIDATION_FAILURE_CODES = [
  'malformed_commit_input',
  'identity_mismatch',
  'unsupported_result_status',
  'unsupported_action',
  'empty_reply_text'
] as const;

const STORE_FAILURE_CODES = ['store_rejected', 'malformed_store_result'] as const;
const FINALIZE_FAILURE_CODES = ['finalize_rejected', 'malformed_finalize_result'] as const;
const LIVING_STATE_PATCH_FIELDS = ['current_activity', 'mood', 'toward_user'] as const;

type LivingStatePatchFailureStage =
  | typeof LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE
  | typeof LIVING_STATE_PATCH_STORE_STAGE
  | typeof LIVING_STATE_PATCH_FINALIZE_STAGE;

type LivingStatePatchFailure = {
  stage: LivingStatePatchFailureStage;
  code: string;
  message: string;
};

type SourceIdentity = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
};

export type LivingStatePatchCommitRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  decision_action: typeof VISIBLE_REPLY_ACTION;
  patch: LivingStatePatch;
  user_id?: string;
  conversation_id?: string;
};

export type LivingStatePatchPrepareRequest = LivingStatePatchCommitRequest & {
  commit_time: string;
};

export type LivingStatePatchCommittedLogEntry = RawEventLogEntry & {
  kind: typeof LIVING_STATE_PATCH_COMMITTED_KIND;
};

export type LivingStatePatchFinalizeRequest = LivingStatePatchPrepareRequest & {
  committed_snapshot: CharacterRuntimeStateSnapshot;
  committed_log_entry: LivingStatePatchCommittedLogEntry;
};

export type LivingStatePatchFinalizeResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  committed_log_entry_id: string;
};

export type LivingStatePatchStore = {
  prepareLivingStatePatchCommit: (request: LivingStatePatchPrepareRequest) => unknown;
};

export type LivingStatePatchFinalizer = {
  finalizeLivingStatePatchCommit: (request: LivingStatePatchFinalizeRequest) => unknown;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type LivingStatePatchCommittedResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: typeof LIVING_STATE_PATCH_COMMITTED_STATUS;
  committed_snapshot: CharacterRuntimeStateSnapshot;
  committed_log_entry_id: string;
};

export type LivingStatePatchSkippedResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: typeof LIVING_STATE_PATCH_SKIPPED_STATUS;
};

export type LivingStatePatchRejectedResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: typeof LIVING_STATE_PATCH_REJECTED_STATUS;
  failure: LivingStatePatchFailure;
};

export type LivingStatePatchCommitResult =
  | LivingStatePatchCommittedResult
  | LivingStatePatchSkippedResult
  | LivingStatePatchRejectedResult;

export class LivingStatePatchCommitValidationError extends Error {
  readonly code: string;

  constructor(
    message: string,
    { code = 'malformed_commit_input' }: { code?: string } = {}
  ) {
    super(message);
    this.name = 'LivingStatePatchCommitValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LivingStatePatchStoreError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'store_rejected' }: { code?: string } = {}) {
    super(message);
    this.name = 'LivingStatePatchStoreError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LivingStatePatchFinalizerError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'finalize_rejected' }: { code?: string } = {}) {
    super(message);
    this.name = 'LivingStatePatchFinalizerError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function buildLivingStatePatchCommitRequest(
  sourceEvent: unknown,
  roleModelResult: unknown
): LivingStatePatchCommitRequest | undefined {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const patch = result.decision.state_patch;
  if (patch === undefined) {
    return undefined;
  }

  const request: LivingStatePatchCommitRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: event.type,
    decision_action: VISIBLE_REPLY_ACTION,
    patch: structuredClone(patch)
  };
  copyOptionalPayloadIdentityFields(event, request);
  return request;
}

export function commitLivingStatePatch(
  sourceEvent: unknown,
  roleModelResult: unknown,
  {
    livingStatePatchStore,
    livingStatePatchFinalizer,
    rawEventLog,
    idGenerator,
    clock
  }: {
    livingStatePatchStore: LivingStatePatchStore;
    livingStatePatchFinalizer: LivingStatePatchFinalizer;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): LivingStatePatchCommitResult {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  let request: LivingStatePatchPrepareRequest | undefined;
  let committedLogEntry: LivingStatePatchCommittedLogEntry | undefined;

  try {
    const requestWithoutCommitTime = buildLivingStatePatchCommitRequest(
      sourceEvent,
      roleModelResult
    );
    if (requestWithoutCommitTime === undefined) {
      return {
        schema_version: SCHEMA_VERSION,
        trace_id: sourceIdentity.trace_id,
        event_id: sourceIdentity.event_id,
        event_type: USER_MESSAGE,
        status: LIVING_STATE_PATCH_SKIPPED_STATUS
      };
    }

    const commitTime = clockTimestamp(clock);
    request = {
      ...requestWithoutCommitTime,
      commit_time: commitTime
    };
    const committedSnapshot = livingStatePatchStore.prepareLivingStatePatchCommit(
      structuredClone(request)
    );
    const validatedSnapshot = validateCommittedLivingStatePatch({
      sourceEvent,
      patch: request.patch,
      committedSnapshot,
      commitTime
    });
    committedLogEntry = buildLivingStatePatchCommittedLogEntry(
      sourceEvent,
      roleModelResult,
      request.patch,
      validatedSnapshot,
      {
        idGenerator,
        clock: clockAt(commitTime)
      }
    );
    const finalizeRequest = buildLivingStatePatchFinalizeRequest(request, {
      committedSnapshot: validatedSnapshot,
      committedLogEntry
    });
    const transactionLogEntry = committedLogEntry;

    const validatedFinalizeResult = runStagedCommitTransaction({
      rawEventLog,
      committedLogEntry: transactionLogEntry,
      finalizeRequest,
      finalize: (candidateRequest) =>
        livingStatePatchFinalizer.finalizeLivingStatePatchCommit(candidateRequest),
      validateFinalizeResult: (candidateResult) =>
        validateLivingStatePatchFinalizeResult(candidateResult, {
          sourceIdentity,
          committedLogEntry: transactionLogEntry
        }),
      isTransactionError: (error): error is LivingStatePatchFinalizerError =>
        error instanceof LivingStatePatchFinalizerError,
      makeMalformedFinalizeError: (message) =>
        new LivingStatePatchFinalizerError(message, { code: 'malformed_finalize_result' }),
      makeFinalizeRejectedError: (message) =>
        new LivingStatePatchFinalizerError(message, { code: 'finalize_rejected' })
    });

    return {
      schema_version: SCHEMA_VERSION,
      trace_id: sourceIdentity.trace_id,
      event_id: sourceIdentity.event_id,
      event_type: USER_MESSAGE,
      status: LIVING_STATE_PATCH_COMMITTED_STATUS,
      committed_snapshot: structuredClone(validatedSnapshot),
      committed_log_entry_id: validatedFinalizeResult.committed_log_entry_id
    };
  } catch (error) {
    if (error instanceof LivingStatePatchFinalizerError) {
      const failure = buildFailure(
        LIVING_STATE_PATCH_FINALIZE_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLivingStatePatchRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          patchSnapshot: request?.patch,
          failure,
          idGenerator,
          clock
        })
      );
      return buildRejectedResult(sourceIdentity, failure);
    }
    if (error instanceof LivingStatePatchStoreError) {
      const failure = buildFailure(
        LIVING_STATE_PATCH_STORE_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLivingStatePatchRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          patchSnapshot: request?.patch,
          failure,
          idGenerator,
          clock
        })
      );
      return buildRejectedResult(sourceIdentity, failure);
    }
    if (error instanceof LivingStatePatchCommitValidationError) {
      const failure = buildFailure(
        LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE,
        error.code,
        error.message
      );
      rawEventLog.append(
        buildLivingStatePatchRejectedLogEntry(sourceEvent, {
          roleModelResultSnapshot: roleModelResult,
          patchSnapshot: request?.patch,
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

export function validateCommittedLivingStatePatch({
  sourceEvent,
  patch,
  committedSnapshot,
  commitTime
}: {
  sourceEvent: unknown;
  patch: unknown;
  committedSnapshot: unknown;
  commitTime: string;
}): CharacterRuntimeStateSnapshot {
  const event = validateSourceEvent(sourceEvent);
  const normalizedPatch = wrapContractError(() => normalizeLivingStatePatch(patch));
  let validatedSnapshot: CharacterRuntimeStateSnapshot;
  try {
    validatedSnapshot = validateCurrentCharacterStateSnapshot(committedSnapshot);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LivingStatePatchStoreError(pythonizeContractMessage(error.message), {
        code: 'malformed_store_result'
      });
    }
    throw error;
  }
  const validatedCommitTime = wrapContractError(() =>
    validateTimestampForCommit(commitTime, 'commit_time')
  );
  validateCommittedSnapshotConsistency({
    event,
    patch: normalizedPatch,
    committedSnapshot: validatedSnapshot,
    commitTime: validatedCommitTime
  });
  return validatedSnapshot;
}

export function buildLivingStatePatchCommittedLogEntry(
  sourceEvent: unknown,
  roleModelResult: unknown,
  patch: unknown,
  committedSnapshot: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): LivingStatePatchCommittedLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const normalizedPatch = wrapContractError(() => normalizeLivingStatePatch(patch));
  const validatedSnapshot = wrapContractError(() =>
    validateCurrentCharacterStateSnapshot(committedSnapshot)
  );
  const entry = buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: LIVING_STATE_PATCH_COMMITTED_KIND,
    data: {
      source_event: event,
      role_model_result: result,
      patch: normalizedPatch,
      committed_snapshot: validatedSnapshot
    },
    idGenerator,
    clock
  });
  return {
    ...entry,
    kind: LIVING_STATE_PATCH_COMMITTED_KIND
  };
}

export function buildLivingStatePatchFinalizeRequest(
  commitRequest: unknown,
  {
    committedSnapshot,
    committedLogEntry
  }: {
    committedSnapshot: CharacterRuntimeStateSnapshot;
    committedLogEntry: LivingStatePatchCommittedLogEntry;
  }
): LivingStatePatchFinalizeRequest {
  const request = validateLivingStatePatchPrepareRequest(commitRequest);
  return {
    ...structuredClone(request),
    committed_snapshot: structuredClone(committedSnapshot),
    committed_log_entry: structuredClone(committedLogEntry)
  };
}

export function validateLivingStatePatchFinalizeResult(
  finalizeResult: unknown,
  {
    sourceIdentity,
    committedLogEntry
  }: {
    sourceIdentity: SourceIdentity;
    committedLogEntry: RawEventLogEntry;
  }
): LivingStatePatchFinalizeResult {
  const result = asFinalizerRecord(finalizeResult, 'LivingStatePatchFinalizeResult');
  wrapFinalizerContractError(() => {
    rejectExtraKeys(
      result,
      ['schema_version', 'trace_id', 'event_id', 'event_type', 'committed_log_entry_id'],
      'LivingStatePatchFinalizeResult'
    );
  });
  const schemaVersion = requireFinalizerLiteral(
    getOwnField(result, 'schema_version'),
    SCHEMA_VERSION,
    'LivingStatePatchFinalizeResult.schema_version'
  );
  const traceId = requireFinalizerString(
    getOwnField(result, 'trace_id'),
    'LivingStatePatchFinalizeResult.trace_id'
  );
  const eventId = requireFinalizerString(
    getOwnField(result, 'event_id'),
    'LivingStatePatchFinalizeResult.event_id'
  );
  const eventType = requireFinalizerLiteral(
    getOwnField(result, 'event_type'),
    USER_MESSAGE,
    'LivingStatePatchFinalizeResult.event_type'
  );
  const committedLogEntryId = requireFinalizerString(
    getOwnField(result, 'committed_log_entry_id'),
    'LivingStatePatchFinalizeResult.committed_log_entry_id'
  );

  if (traceId !== sourceIdentity.trace_id) {
    throw new LivingStatePatchFinalizerError(
      'LivingStatePatchFinalizeResult.trace_id must match source_event.trace_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  if (eventId !== sourceIdentity.event_id) {
    throw new LivingStatePatchFinalizerError(
      'LivingStatePatchFinalizeResult.event_id must match source_event.event_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  const expectedLogId = requireFinalizerString(
    getOwnField(asFinalizerRecord(committedLogEntry, 'committed_log_entry'), 'log_id'),
    'committed_log_entry.log_id'
  );
  if (committedLogEntryId !== expectedLogId) {
    throw new LivingStatePatchFinalizerError(
      'LivingStatePatchFinalizeResult.committed_log_entry_id must match committed_log_entry.log_id.',
      { code: 'malformed_finalize_result' }
    );
  }
  return {
    schema_version: schemaVersion,
    trace_id: traceId,
    event_id: eventId,
    event_type: eventType,
    committed_log_entry_id: committedLogEntryId
  };
}

export function buildLivingStatePatchRejectedLogEntry(
  sourceEvent: unknown,
  {
    roleModelResultSnapshot,
    patchSnapshot,
    failure,
    idGenerator,
    clock
  }: {
    roleModelResultSnapshot: unknown;
    patchSnapshot?: unknown;
    failure: unknown;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  const validatedFailure = validateFailure(failure);
  const data: Record<string, unknown> = {
    source_event: snapshotRawValue(sourceEvent),
    role_model_result_snapshot: snapshotRawValue(roleModelResultSnapshot),
    failure: validatedFailure
  };
  if (patchSnapshot !== undefined && patchSnapshot !== null) {
    data['patch_snapshot'] = snapshotRawValue(patchSnapshot);
  }
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: LIVING_STATE_PATCH_REJECTED_KIND,
    data,
    idGenerator,
    clock
  });
}

function validateSourceEvent(sourceEvent: unknown): UserMessageRuntimeEvent {
  return wrapContractError(() =>
    validateNormalizedUserMessageEvent(sourceEvent, 'source_event')
  );
}

function validateRoleModelResult(
  roleModelResult: unknown,
  { sourceEvent }: { sourceEvent: UserMessageRuntimeEvent }
): RoleModelTurnResult {
  return wrapContractError(() =>
    normalizeRoleModelTurnResult(roleModelResult, {
      sourceEvent,
      decisionNormalizer: (decision) =>
        normalizeVisibleReplyDecisionWithOptionalLivingStatePatch(
          decision,
          {
            traceId: sourceEvent.trace_id,
            eventId: sourceEvent.event_id,
            requireAttachedIds: true,
            allowStatePatch: true
          },
          'CharacterDecision'
        )
    })
  );
}

function validateLivingStatePatchPrepareRequest(
  commitRequest: unknown
): LivingStatePatchPrepareRequest {
  const request = asCommitRecord(commitRequest, 'commit_request');
  wrapContractError(() => {
    rejectExtraKeys(
      request,
      [
        'schema_version',
        'trace_id',
        'event_id',
        'event_type',
        'decision_action',
        'patch',
        'commit_time',
        'user_id',
        'conversation_id'
      ],
      'commit_request'
    );
  });
  const normalized: LivingStatePatchPrepareRequest = {
    schema_version: requireCommitLiteral(
      getOwnField(request, 'schema_version'),
      SCHEMA_VERSION,
      'commit_request.schema_version'
    ),
    trace_id: requireCommitString(getOwnField(request, 'trace_id'), 'commit_request.trace_id'),
    event_id: requireCommitString(getOwnField(request, 'event_id'), 'commit_request.event_id'),
    event_type: requireCommitLiteral(
      getOwnField(request, 'event_type'),
      USER_MESSAGE,
      'commit_request.event_type'
    ),
    decision_action: requireCommitLiteral(
      getOwnField(request, 'decision_action'),
      VISIBLE_REPLY_ACTION,
      'commit_request.decision_action'
    ),
    patch: wrapContractError(() =>
      normalizeLivingStatePatch(getOwnField(request, 'patch'), 'commit_request.patch')
    ),
    commit_time: wrapContractError(() =>
      validateTimestampForCommit(
        requireString(getOwnField(request, 'commit_time'), 'commit_request.commit_time'),
        'commit_request.commit_time'
      )
    )
  };
  if (Object.hasOwn(request, 'user_id')) {
    normalized.user_id = wrapContractError(() =>
      requireOptionalString(getOwnField(request, 'user_id'), 'commit_request.user_id')
    );
  }
  if (Object.hasOwn(request, 'conversation_id')) {
    normalized.conversation_id = wrapContractError(() =>
      requireOptionalString(
        getOwnField(request, 'conversation_id'),
        'commit_request.conversation_id'
      )
    );
  }
  return normalized;
}

function extractTrustedSourceIdentity(sourceEvent: unknown): SourceIdentity {
  const sourceRecord = asCommitRecord(sourceEvent, 'source_event');
  return {
    trace_id: wrapContractError(() => requireString(getOwnField(sourceRecord, 'trace_id'), 'trace_id')),
    event_id: wrapContractError(() => requireString(getOwnField(sourceRecord, 'event_id'), 'event_id')),
    event_type: USER_MESSAGE
  };
}

function validateFailure(failure: unknown): LivingStatePatchFailure {
  const failureRecord = asCommitRecord(failure, 'failure');
  wrapContractError(() => {
    rejectExtraKeys(failureRecord, ['stage', 'code', 'message'], 'failure');
  });
  const stage = wrapContractError(() =>
    requireString(getOwnField(failureRecord, 'stage'), 'failure.stage')
  );
  if (!isFailureStage(stage)) {
    throw new LivingStatePatchCommitValidationError(
      'failure.stage must be a supported living-state patch failure stage.'
    );
  }
  const code = wrapContractError(() =>
    requireString(getOwnField(failureRecord, 'code'), 'failure.code')
  );
  if (!supportedCodesForStage(stage).includes(code)) {
    throw new LivingStatePatchCommitValidationError(
      'failure.code must be supported for failure.stage.'
    );
  }
  return {
    stage,
    code,
    message: wrapContractError(() =>
      requireString(getOwnField(failureRecord, 'message'), 'failure.message')
    )
  };
}

function buildRejectedResult(
  sourceIdentity: SourceIdentity,
  failure: LivingStatePatchFailure
): LivingStatePatchRejectedResult {
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    event_type: USER_MESSAGE,
    status: LIVING_STATE_PATCH_REJECTED_STATUS,
    failure: structuredClone(failure)
  };
}

function buildFailure(
  stage: LivingStatePatchFailureStage,
  code: string,
  message: string
): LivingStatePatchFailure {
  let supportedCode = code;
  if (!supportedCodesForStage(stage).includes(supportedCode)) {
    if (stage === LIVING_STATE_PATCH_STORE_STAGE) {
      supportedCode = 'malformed_store_result';
    } else if (stage === LIVING_STATE_PATCH_FINALIZE_STAGE) {
      supportedCode = 'malformed_finalize_result';
    } else {
      supportedCode = 'malformed_commit_input';
    }
  }
  return {
    stage,
    code: supportedCode,
    message: pythonizeContractMessage(message)
  };
}

function validateCommittedSnapshotConsistency({
  event,
  patch,
  committedSnapshot,
  commitTime
}: {
  event: UserMessageRuntimeEvent;
  patch: LivingStatePatch;
  committedSnapshot: CharacterRuntimeStateSnapshot;
  commitTime: string;
}): void {
  if (!committedSnapshot.source_event_ids.includes(event.event_id)) {
    throw new LivingStatePatchStoreError(
      'committed_snapshot.source_event_ids must include source_event.event_id.',
      { code: 'malformed_store_result' }
    );
  }

  for (const fieldName of LIVING_STATE_PATCH_FIELDS) {
    const patchValue = patch.living_state[fieldName];
    if (
      patchValue !== undefined &&
      committedSnapshot.living_state[fieldName] !== patchValue
    ) {
      throw new LivingStatePatchStoreError(
        `committed_snapshot.living_state.${fieldName} must match patch.living_state.${fieldName}.`,
        { code: 'malformed_store_result' }
      );
    }
  }

  const updatedAt = committedSnapshot.updated_at;
  const updatedAtMicros = parseTimestampForStore(updatedAt, 'committed_snapshot.updated_at');
  const eventCreatedAtMicros = parseTimestampForStore(event.created_at, 'source_event.created_at');
  if (updatedAtMicros < eventCreatedAtMicros) {
    throw new LivingStatePatchStoreError(
      'committed_snapshot.updated_at must not be older than source_event.created_at.',
      { code: 'malformed_store_result' }
    );
  }
  if (updatedAt !== commitTime) {
    throw new LivingStatePatchStoreError(
      'committed_snapshot.updated_at must match the runtime commit timestamp.',
      { code: 'malformed_store_result' }
    );
  }
}

function copyOptionalPayloadIdentityFields(
  event: UserMessageRuntimeEvent,
  request: LivingStatePatchCommitRequest
): void {
  if (event.payload.user_id !== undefined) {
    request.user_id = event.payload.user_id;
  }
  if (event.payload.conversation_id !== undefined) {
    request.conversation_id = event.payload.conversation_id;
  }
}

function validateTimestampForCommit(value: string, fieldName: string): string {
  parseIso8601TimestampToUtcMicroseconds(value, fieldName);
  return value;
}

function parseTimestampForStore(value: string, fieldName: string): bigint {
  try {
    return parseIso8601TimestampToUtcMicroseconds(value, fieldName);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LivingStatePatchStoreError(pythonizeContractMessage(error.message), {
        code: 'malformed_store_result'
      });
    }
    throw error;
  }
}

function clockAt(timestamp: string): Clock {
  return () => timestamp;
}

function asCommitRecord(value: unknown, fieldName: string): ValueRecord {
  return wrapContractError(() => asRecord(value, fieldName));
}

function asFinalizerRecord(value: unknown, fieldName: string): ValueRecord {
  return wrapFinalizerContractError(() => asRecord(value, fieldName));
}

function wrapContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      const code = error.code === 'invalid_contract' ? 'malformed_commit_input' : error.code;
      throw new LivingStatePatchCommitValidationError(
        pythonizeContractMessage(error.message),
        { code }
      );
    }
    throw error;
  }
}

function wrapFinalizerContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new LivingStatePatchFinalizerError(pythonizeContractMessage(error.message), {
        code: 'malformed_finalize_result'
      });
    }
    throw error;
  }
}

function requireCommitString(value: unknown, fieldName: string): string {
  return wrapContractError(() => requireString(value, fieldName));
}

function requireCommitLiteral<const Expected extends string>(
  value: unknown,
  expected: Expected,
  fieldName: string
): Expected {
  return wrapContractError(() => requireLiteral(value, expected, fieldName));
}

function requireFinalizerString(value: unknown, fieldName: string): string {
  return wrapFinalizerContractError(() => requireString(value, fieldName));
}

function requireFinalizerLiteral<const Expected extends string>(
  value: unknown,
  expected: Expected,
  fieldName: string
): Expected {
  return wrapFinalizerContractError(() => requireLiteral(value, expected, fieldName));
}

function pythonizeContractMessage(message: string): string {
  return message.replace(/"([^"]+)"/g, "'$1'");
}

function isFailureStage(stage: string): stage is LivingStatePatchFailureStage {
  return (
    stage === LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE ||
    stage === LIVING_STATE_PATCH_STORE_STAGE ||
    stage === LIVING_STATE_PATCH_FINALIZE_STAGE
  );
}

function supportedCodesForStage(stage: LivingStatePatchFailureStage): readonly string[] {
  switch (stage) {
    case LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE:
      return COMMIT_VALIDATION_FAILURE_CODES;
    case LIVING_STATE_PATCH_STORE_STAGE:
      return STORE_FAILURE_CODES;
    case LIVING_STATE_PATCH_FINALIZE_STAGE:
      return FINALIZE_FAILURE_CODES;
  }
}
