import { isDeepStrictEqual } from 'node:util';

import {
  buildLifeIncidentStartFinalizeRequest,
  LifeIncidentStartFinalizerError,
  type LifeIncidentStartFinalizeRequest,
  type LifeIncidentStartFinalizeResult
} from '../../commit-effects/incident-start.ts';
import {
  buildLifeIncidentCancelFinalizeRequest,
  LifeIncidentCancelFinalizerError,
  type LifeIncidentCancelFinalizeRequest,
  type LifeIncidentCancelFinalizeResult
} from '../../commit-effects/incident-cancel.ts';
import {
  buildLifeIncidentCompleteFinalizeRequest,
  LifeIncidentCompleteFinalizerError,
  type LifeIncidentCompleteFinalizeRequest,
  type LifeIncidentCompleteFinalizeResult
} from '../../commit-effects/incident-complete.ts';
import {
  buildLifeIncidentInterruptFinalizeRequest,
  LifeIncidentInterruptFinalizerError,
  type LifeIncidentInterruptFinalizeRequest,
  type LifeIncidentInterruptFinalizeResult
} from '../../commit-effects/incident-interrupt.ts';
import { USER_MESSAGE } from '../../runtime/contracts.ts';
import { validateRawEventLogEntry, type RawEventLogEntry } from '../../runtime/logging.ts';
import {
  asRecord,
  getOwnField,
  type ValueRecord
} from '../../runtime/validation.ts';
import { SCHEMA_VERSION } from '../../runtime/schema.ts';
import {
  validateActiveIncidentRequest,
  validateInterruptedIncidentRequest,
  type ActiveIncidentRequest,
  type ActiveIncidentSnapshot,
  type InterruptedIncidentRequest,
  type InterruptedIncidentSnapshot
} from './current.ts';

export const IDENTIFIED_SCOPE_MODE = 'identified';
export const SINGLE_USER_SELF_USE_SCOPE_MODE = 'single_user_self_use';

export type IncidentScope =
  | {
      mode: typeof SINGLE_USER_SELF_USE_SCOPE_MODE;
    }
  | {
      mode: typeof IDENTIFIED_SCOPE_MODE;
      user_id?: string;
      conversation_id?: string;
    };

type CommittedSuccessRawEventLog = {
  exposeCommittedSuccessEntry: (entry: RawEventLogEntry) => void;
};

type ScopedRequest = {
  user_id?: string;
  conversation_id?: string;
};
type NullableIdentityFields = {
  user_id?: string | null;
  conversation_id?: string | null;
};
type NullableActiveIncidentRequest = Omit<ActiveIncidentRequest, 'user_id' | 'conversation_id'> &
  NullableIdentityFields;
type NullableInterruptedIncidentRequest = Omit<
  InterruptedIncidentRequest,
  'user_id' | 'conversation_id'
> &
  NullableIdentityFields;

export class InMemoryLifeIncidentStore {
  readonly #rawEventLog: CommittedSuccessRawEventLog;
  readonly #activeIncidentsByScope = new Map<string, ActiveIncidentSnapshot>();
  readonly #interruptedIncidentsByScope = new Map<string, InterruptedIncidentSnapshot>();

  constructor({ rawEventLog }: { rawEventLog: CommittedSuccessRawEventLog }) {
    this.#rawEventLog = rawEventLog;
  }

  requireRawEventLog(rawEventLog: unknown): void {
    if (rawEventLog !== this.#rawEventLog) {
      throwRawEventLogMismatch(LifeIncidentStartFinalizerError);
    }
  }

  requireLifeIncidentCancelRawEventLog(rawEventLog: unknown): void {
    if (rawEventLog !== this.#rawEventLog) {
      throwRawEventLogMismatch(LifeIncidentCancelFinalizerError);
    }
  }

  requireLifeIncidentCompleteRawEventLog(rawEventLog: unknown): void {
    if (rawEventLog !== this.#rawEventLog) {
      throwRawEventLogMismatch(LifeIncidentCompleteFinalizerError);
    }
  }

  requireLifeIncidentInterruptRawEventLog(rawEventLog: unknown): void {
    if (rawEventLog !== this.#rawEventLog) {
      throwRawEventLogMismatch(LifeIncidentInterruptFinalizerError);
    }
  }

  finalizeLifeIncidentStart(request: unknown): LifeIncidentStartFinalizeResult {
    const validatedRequest = validateStartFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    if (this.#activeIncidentsByScope.has(scopeKey)) {
      throw new LifeIncidentStartFinalizerError(
        'Active incident already exists for this scope.',
        { code: 'finalize_rejected' }
      );
    }
    exposeCommittedSuccessEntry(
      this.#rawEventLog,
      validatedRequest.committed_log_entry,
      LifeIncidentStartFinalizerError
    );
    this.#activeIncidentsByScope.set(
      scopeKey,
      structuredClone(validatedRequest.started_incident)
    );
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: validatedRequest.trace_id,
      event_id: validatedRequest.event_id,
      event_type: USER_MESSAGE,
      committed_log_entry_id: validatedRequest.committed_log_entry.log_id
    };
  }

  completeLifeIncidentStartAfterLogVisible(request: unknown): void {
    const validatedRequest = validateStartFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (!isDeepStrictEqual(currentActiveIncident, validatedRequest.started_incident)) {
      throw new LifeIncidentStartFinalizerError(
        'Active incident changed before start could be completed.',
        { code: 'finalize_rejected' }
      );
    }
    this.#interruptedIncidentsByScope.delete(scopeKey);
  }

  discardLifeIncidentStartAfterLogNotVisible(request: unknown): void {
    const validatedRequest = validateStartFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (isDeepStrictEqual(currentActiveIncident, validatedRequest.started_incident)) {
      this.#activeIncidentsByScope.delete(scopeKey);
    }
  }

  finalizeLifeIncidentCancel(request: unknown): LifeIncidentCancelFinalizeResult {
    const validatedRequest = validateCancelFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (currentActiveIncident === undefined) {
      throw new LifeIncidentCancelFinalizerError(
        'No active incident exists for this scope.',
        { code: 'finalize_rejected' }
      );
    }
    if (!isDeepStrictEqual(currentActiveIncident, validatedRequest.active_incident)) {
      throw new LifeIncidentCancelFinalizerError(
        'Active incident changed before cancellation could be finalized.',
        { code: 'finalize_rejected' }
      );
    }
    exposeCommittedSuccessEntry(
      this.#rawEventLog,
      validatedRequest.committed_log_entry,
      LifeIncidentCancelFinalizerError
    );
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: validatedRequest.trace_id,
      event_id: validatedRequest.event_id,
      event_type: USER_MESSAGE,
      committed_log_entry_id: validatedRequest.committed_log_entry.log_id
    };
  }

  completeLifeIncidentCancelAfterLogVisible(request: unknown): void {
    const validatedRequest = validateCancelFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (!isDeepStrictEqual(currentActiveIncident, validatedRequest.active_incident)) {
      throw new LifeIncidentCancelFinalizerError(
        'Active incident changed before cancellation could be completed.',
        { code: 'finalize_rejected' }
      );
    }
    this.#activeIncidentsByScope.delete(scopeKey);
    this.#interruptedIncidentsByScope.delete(scopeKey);
  }

  finalizeLifeIncidentComplete(request: unknown): LifeIncidentCompleteFinalizeResult {
    const validatedRequest = validateCompleteFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (currentActiveIncident === undefined) {
      throw new LifeIncidentCompleteFinalizerError(
        'No active incident exists for this scope.',
        { code: 'finalize_rejected' }
      );
    }
    if (!isDeepStrictEqual(currentActiveIncident, validatedRequest.active_incident)) {
      throw new LifeIncidentCompleteFinalizerError(
        'Active incident changed before completion could be finalized.',
        { code: 'finalize_rejected' }
      );
    }
    exposeCommittedSuccessEntry(
      this.#rawEventLog,
      validatedRequest.committed_log_entry,
      LifeIncidentCompleteFinalizerError
    );
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: validatedRequest.trace_id,
      event_id: validatedRequest.event_id,
      event_type: validatedRequest.event_type,
      committed_log_entry_id: validatedRequest.committed_log_entry.log_id
    };
  }

  completeLifeIncidentCompleteAfterLogVisible(request: unknown): void {
    const validatedRequest = validateCompleteFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (!isDeepStrictEqual(currentActiveIncident, validatedRequest.active_incident)) {
      throw new LifeIncidentCompleteFinalizerError(
        'Active incident changed before completion could be completed.',
        { code: 'finalize_rejected' }
      );
    }
    this.#activeIncidentsByScope.delete(scopeKey);
    this.#interruptedIncidentsByScope.delete(scopeKey);
  }

  finalizeLifeIncidentInterrupt(request: unknown): LifeIncidentInterruptFinalizeResult {
    const validatedRequest = validateInterruptFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (currentActiveIncident === undefined) {
      throw new LifeIncidentInterruptFinalizerError(
        'No active incident exists for this scope.',
        { code: 'finalize_rejected' }
      );
    }
    if (!isDeepStrictEqual(currentActiveIncident, validatedRequest.active_incident)) {
      throw new LifeIncidentInterruptFinalizerError(
        'Active incident changed before interruption could be finalized.',
        { code: 'finalize_rejected' }
      );
    }
    exposeCommittedSuccessEntry(
      this.#rawEventLog,
      validatedRequest.committed_log_entry,
      LifeIncidentInterruptFinalizerError
    );
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: validatedRequest.trace_id,
      event_id: validatedRequest.event_id,
      event_type: USER_MESSAGE,
      committed_log_entry_id: validatedRequest.committed_log_entry.log_id
    };
  }

  completeLifeIncidentInterruptAfterLogVisible(request: unknown): void {
    const validatedRequest = validateInterruptFinalizeRequest(request);
    const scopeKey = scopeKeyFromRequest(validatedRequest);
    const currentActiveIncident = this.#activeIncidentsByScope.get(scopeKey);
    if (!isDeepStrictEqual(currentActiveIncident, validatedRequest.active_incident)) {
      throw new LifeIncidentInterruptFinalizerError(
        'Active incident changed before interruption could be completed.',
        { code: 'finalize_rejected' }
      );
    }
    this.#activeIncidentsByScope.delete(scopeKey);
    this.#interruptedIncidentsByScope.set(
      scopeKey,
      structuredClone(validatedRequest.interrupted_incident)
    );
  }

  readActiveIncident(request: NullableActiveIncidentRequest): ActiveIncidentSnapshot | undefined {
    const validatedRequest = validateActiveIncidentRequest(dropNullIdentityFields(request));
    const incident = this.#activeIncidentsByScope.get(scopeKeyFromRequest(validatedRequest));
    return incident === undefined ? undefined : structuredClone(incident);
  }

  readInterruptedIncident(
    request: NullableInterruptedIncidentRequest
  ): InterruptedIncidentSnapshot | undefined {
    const validatedRequest = validateInterruptedIncidentRequest(dropNullIdentityFields(request));
    const incident = this.#interruptedIncidentsByScope.get(scopeKeyFromRequest(validatedRequest));
    return incident === undefined ? undefined : structuredClone(incident);
  }
}

function validateStartFinalizeRequest(request: unknown): LifeIncidentStartFinalizeRequest {
  return wrapAsFinalizerError(LifeIncidentStartFinalizerError, () => {
    const record = asRecord(request, 'LifeIncidentStartFinalizeRequest');
    const finalized = buildLifeIncidentStartFinalizeRequest(
      omitOwnFields(record, ['started_incident', 'committed_log_entry']),
      {
      startedIncident: getOwnField(record, 'started_incident'),
      committedLogEntry: getOwnField(record, 'committed_log_entry')
      }
    );
    requireEntryDataMatches(
      finalized.committed_log_entry,
      'started_incident',
      finalized.started_incident,
      LifeIncidentStartFinalizerError
    );
    return finalized;
  });
}

function validateCancelFinalizeRequest(request: unknown): LifeIncidentCancelFinalizeRequest {
  return wrapAsFinalizerError(LifeIncidentCancelFinalizerError, () => {
    const record = asRecord(request, 'LifeIncidentCancelFinalizeRequest');
    const finalized = buildLifeIncidentCancelFinalizeRequest(
      omitOwnFields(record, ['active_incident', 'cancelled_incident', 'committed_log_entry']),
      {
        activeIncident: getOwnField(record, 'active_incident'),
        cancelledIncident: getOwnField(record, 'cancelled_incident'),
        committedLogEntry: getOwnField(record, 'committed_log_entry')
      }
    );
    requireEntryDataMatches(
      finalized.committed_log_entry,
      'active_incident',
      finalized.active_incident,
      LifeIncidentCancelFinalizerError
    );
    requireEntryDataMatches(
      finalized.committed_log_entry,
      'cancelled_incident',
      finalized.cancelled_incident,
      LifeIncidentCancelFinalizerError
    );
    return finalized;
  });
}

function validateCompleteFinalizeRequest(request: unknown): LifeIncidentCompleteFinalizeRequest {
  return wrapAsFinalizerError(LifeIncidentCompleteFinalizerError, () => {
    const record = asRecord(request, 'LifeIncidentCompleteFinalizeRequest');
    const finalized = buildLifeIncidentCompleteFinalizeRequest(
      omitOwnFields(record, ['active_incident', 'completed_incident', 'committed_log_entry']),
      {
        activeIncident: getOwnField(record, 'active_incident'),
        completedIncident: getOwnField(record, 'completed_incident'),
        committedLogEntry: getOwnField(record, 'committed_log_entry')
      }
    );
    requireEntryDataMatches(
      finalized.committed_log_entry,
      'active_incident',
      finalized.active_incident,
      LifeIncidentCompleteFinalizerError
    );
    requireEntryDataMatches(
      finalized.committed_log_entry,
      'completed_incident',
      finalized.completed_incident,
      LifeIncidentCompleteFinalizerError
    );
    return finalized;
  });
}

function validateInterruptFinalizeRequest(request: unknown): LifeIncidentInterruptFinalizeRequest {
  return wrapAsFinalizerError(LifeIncidentInterruptFinalizerError, () => {
    const record = asRecord(request, 'LifeIncidentInterruptFinalizeRequest');
    const finalized = buildLifeIncidentInterruptFinalizeRequest(
      omitOwnFields(record, ['active_incident', 'interrupted_incident', 'committed_log_entry']),
      {
        activeIncident: getOwnField(record, 'active_incident'),
        interruptedIncident: getOwnField(record, 'interrupted_incident'),
        committedLogEntry: getOwnField(record, 'committed_log_entry')
      }
    );
    requireEntryDataMatches(
      finalized.committed_log_entry,
      'active_incident',
      finalized.active_incident,
      LifeIncidentInterruptFinalizerError
    );
    requireEntryDataMatches(
      finalized.committed_log_entry,
      'interrupted_incident',
      finalized.interrupted_incident,
      LifeIncidentInterruptFinalizerError
    );
    return finalized;
  });
}

function requireEntryDataMatches(
  entry: RawEventLogEntry,
  dataKey: string,
  expectedValue: unknown,
  ErrorType: FinalizerErrorConstructor
): void {
  const validatedEntry = validateRawEventLogEntry(entry);
  if (!isDeepStrictEqual(validatedEntry.data[dataKey], expectedValue)) {
    throw new ErrorType(
      `committed_log_entry.data.${dataKey} must match ${dataKey}.`,
      { code: 'malformed_finalize_result' }
    );
  }
}

function exposeCommittedSuccessEntry(
  rawEventLog: CommittedSuccessRawEventLog,
  entry: RawEventLogEntry,
  ErrorType: FinalizerErrorConstructor
): void {
  try {
    rawEventLog.exposeCommittedSuccessEntry(entry);
  } catch (error) {
    throw new ErrorType(errorMessage(error), {
      code: 'malformed_finalize_result'
    });
  }
}

function scopeKeyFromRequest(request: ScopedRequest): string {
  const scope = incidentScopeFromRequest(request);
  if (scope.mode === SINGLE_USER_SELF_USE_SCOPE_MODE) {
    return scope.mode;
  }
  return JSON.stringify([
    scope.mode,
    Object.hasOwn(scope, 'user_id') ? scope.user_id : null,
    Object.hasOwn(scope, 'conversation_id') ? scope.conversation_id : null
  ]);
}

function incidentScopeFromRequest(request: ScopedRequest): IncidentScope {
  const userId = request.user_id;
  const conversationId = request.conversation_id;
  if (userId === undefined && conversationId === undefined) {
    return { mode: SINGLE_USER_SELF_USE_SCOPE_MODE };
  }
  const scope: IncidentScope = { mode: IDENTIFIED_SCOPE_MODE };
  if (userId !== undefined) {
    scope.user_id = userId;
  }
  if (conversationId !== undefined) {
    scope.conversation_id = conversationId;
  }
  return scope;
}

function omitOwnFields(record: ValueRecord, fieldNames: readonly string[]): ValueRecord {
  const omitted = new Set(fieldNames);
  const output: ValueRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (!omitted.has(key)) {
      output[key] = value;
    }
  }
  return output;
}

type FinalizerErrorConstructor = new (
  message: string,
  options?: { code?: string }
) =>
  | LifeIncidentStartFinalizerError
  | LifeIncidentCancelFinalizerError
  | LifeIncidentCompleteFinalizerError
  | LifeIncidentInterruptFinalizerError;

function wrapAsFinalizerError<T>(
  ErrorType: FinalizerErrorConstructor,
  callback: () => T
): T {
  try {
    return callback();
  } catch (error) {
    if (
      error instanceof LifeIncidentStartFinalizerError ||
      error instanceof LifeIncidentCancelFinalizerError ||
      error instanceof LifeIncidentCompleteFinalizerError ||
      error instanceof LifeIncidentInterruptFinalizerError
    ) {
      throw error;
    }
    const code = errorCode(error, 'malformed_finalize_result');
    throw new ErrorType(errorMessage(error), {
      code: normalizeFinalizerCode(code)
    });
  }
}

function normalizeFinalizerCode(code: string): string {
  return code === 'finalize_rejected' ? code : 'malformed_finalize_result';
}

function dropNullIdentityFields(
  request: NullableActiveIncidentRequest | NullableInterruptedIncidentRequest
): ValueRecord {
  const record = asRecord(request, 'IncidentReadRequest');
  const output: ValueRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if ((key === 'user_id' || key === 'conversation_id') && value === null) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function throwRawEventLogMismatch(ErrorType: FinalizerErrorConstructor): never {
  throw new ErrorType(
    'LifeIncidentStore must finalize against the same Raw Event Log instance that will confirm visibility.',
    { code: 'malformed_finalize_result' }
  );
}

function errorCode(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim().length > 0) {
      return code;
    }
  }
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
