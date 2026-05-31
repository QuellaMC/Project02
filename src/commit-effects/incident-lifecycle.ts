import {
  RawEventLogQueryValidationError,
  confirmCommittedSuccessEntryVisibility,
  discardCommittedSuccessEntryVisibility,
  validateRawEventLogEntry,
  type RawEventLogEntry
} from '../runtime/logging.ts';
import { ContractValidationError } from '../runtime/errors.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../runtime/schema.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireOptionalString,
  requireString,
  type ValueRecord
} from '../runtime/validation.ts';

export type IncidentSourceIdentity<EventType extends string = string> = {
  trace_id: string;
  event_id: string;
  event_type: EventType;
};

export type IncidentLogSourceIdentity = {
  trace_id: string;
  event_id: string;
};

export type IncidentFailure<Stage extends string = string> = {
  stage: Stage;
  code: string;
  message: string;
};

export type IncidentFailureCodeTable<Stage extends string = string> = Record<
  Stage,
  readonly string[]
>;

export type IncidentCommitErrorFactory<ErrorType extends Error> = (
  message: string
) => ErrorType;

export type IncidentOptionalIdentityFields = {
  user_id?: string;
  conversation_id?: string;
};

export type StagedCommitTransactionOptions<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
> = {
  rawEventLog: unknown;
  committedLogEntry: CommittedLogEntry;
  finalizeRequest: FinalizeRequest;
  finalize: (request: FinalizeRequest) => unknown;
  validateFinalizeResult: (finalizeResult: unknown) => FinalizeResult;
  isTransactionError: (error: unknown) => error is ErrorType;
  makeMalformedFinalizeError: (message: string) => ErrorType;
  makeFinalizeRejectedError: (message: string) => ErrorType;
  requireRawEventLog?: ((rawEventLog: unknown) => void) | undefined;
  completeAfterLogVisible?: ((request: FinalizeRequest) => void) | undefined;
  discardAfterLogNotVisible?: ((request: FinalizeRequest) => void) | undefined;
  formatFinalizeUnexpectedError?: ((error: unknown) => string) | undefined;
  formatRequirementUnexpectedError?: ((error: unknown) => string) | undefined;
  formatPostVisibleUnexpectedError?: ((error: unknown) => string) | undefined;
  formatDiscardUnexpectedError?: ((error: unknown) => string) | undefined;
  ignorePostVisibleTransactionError?: boolean;
  mapPostVisibleRawLogValidationAsMalformed?: boolean;
};

type IncidentPayloadIdentityEvent = {
  payload: {
    user_id?: string;
    conversation_id?: string;
  };
};

export function buildIncidentStatusResult<EventType extends string, Status extends string>(
  sourceIdentity: IncidentSourceIdentity<EventType>,
  status: Status
): {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: EventType;
  status: Status;
} {
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    event_type: sourceIdentity.event_type,
    status
  };
}

export function buildIncidentRejectedResult<
  EventType extends string,
  Status extends string,
  Stage extends string
>(
  sourceIdentity: IncidentSourceIdentity<EventType>,
  status: Status,
  failure: IncidentFailure<Stage>
): {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: EventType;
  status: Status;
  failure: IncidentFailure<Stage>;
} {
  return {
    ...buildIncidentStatusResult(sourceIdentity, status),
    failure: structuredClone(failure)
  };
}

export function buildIncidentFailure<Stage extends string>({
  stage,
  code,
  message,
  supportedCodes,
  fallbackCode
}: {
  stage: Stage;
  code: string;
  message: string;
  supportedCodes: readonly string[];
  fallbackCode: string;
}): IncidentFailure<Stage> {
  const normalizedCode = supportedCodes.includes(code) ? code : fallbackCode;
  return { stage, code: normalizedCode, message };
}

export function validateIncidentFailure<Stage extends string, ErrorType extends Error>(
  failure: unknown,
  {
    supportedByStage,
    label,
    makeError
  }: {
    supportedByStage: IncidentFailureCodeTable<Stage>;
    label: string;
    makeError: IncidentCommitErrorFactory<ErrorType>;
  }
): IncidentFailure<Stage> {
  const failureRecord = withIncidentValidationError(
    () => asRecord(failure, 'failure'),
    makeError
  );
  withIncidentValidationError(
    () => {
      rejectExtraKeys(failureRecord, ['stage', 'code', 'message'], 'failure');
    },
    makeError
  );
  const stage = withIncidentValidationError(
    () => requireString(getOwnField(failureRecord, 'stage'), 'failure.stage'),
    makeError
  );
  if (!Object.hasOwn(supportedByStage, stage)) {
    throw makeError(`failure.stage must be a supported ${label} failure stage.`);
  }
  const supportedCodes = supportedByStage[stage as Stage];
  const code = withIncidentValidationError(
    () => requireString(getOwnField(failureRecord, 'code'), 'failure.code'),
    makeError
  );
  if (!supportedCodes.includes(code)) {
    throw makeError('failure.code must be supported for failure.stage.');
  }
  return {
    stage: stage as Stage,
    code,
    message: withIncidentValidationError(
      () => requireString(getOwnField(failureRecord, 'message'), 'failure.message'),
      makeError
    )
  };
}

export function copyOptionalPayloadIdentityFields(
  event: IncidentPayloadIdentityEvent,
  request: IncidentOptionalIdentityFields
): void {
  if (event.payload.user_id !== undefined) {
    request.user_id = event.payload.user_id;
  }
  if (event.payload.conversation_id !== undefined) {
    request.conversation_id = event.payload.conversation_id;
  }
}

export function copyOptionalIdentityFieldsFromRecord<ErrorType extends Error>(
  input: ValueRecord,
  output: IncidentOptionalIdentityFields,
  {
    sourceName,
    makeError
  }: {
    sourceName: string;
    makeError: IncidentCommitErrorFactory<ErrorType>;
  }
): void {
  for (const fieldName of ['user_id', 'conversation_id'] as const) {
    if (Object.hasOwn(input, fieldName)) {
      const value = getOwnField(input, fieldName);
      if (value !== undefined && value !== null) {
        output[fieldName] = withIncidentValidationError(
          () => requireOptionalString(value, `${sourceName}.${fieldName}`),
          makeError
        );
      }
    }
  }
}

export function validateCommittedIncidentLogEntry<ErrorType extends Error>(
  committedLogEntry: unknown,
  {
    sourceIdentity,
    kind,
    makeError
  }: {
    sourceIdentity: IncidentLogSourceIdentity;
    kind: string;
    makeError: IncidentCommitErrorFactory<ErrorType>;
  }
): RawEventLogEntry {
  try {
    const entry = validateRawEventLogEntry(committedLogEntry);
    requireLiteral(entry.trace_id, sourceIdentity.trace_id, 'committed_log_entry.trace_id');
    requireLiteral(entry.event_id, sourceIdentity.event_id, 'committed_log_entry.event_id');
    requireLiteral(entry.kind, kind, 'committed_log_entry.kind');
    return entry;
  } catch (error) {
    if (
      error instanceof RawEventLogQueryValidationError ||
      error instanceof ContractValidationError
    ) {
      throw makeError(error.message);
    }
    throw error;
  }
}

export function runStagedCommitTransaction<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
>(
  options: StagedCommitTransactionOptions<
    FinalizeRequest,
    CommittedLogEntry,
    FinalizeResult,
    ErrorType
  >
): FinalizeResult {
  let successVisibilityConfirmed = false;
  try {
    callTransactionRawLogRequirement(options);
    const finalizeResult = callTransactionFinalizer(options);
    const validatedFinalizeResult = options.validateFinalizeResult(finalizeResult);
    confirmTransactionVisibility(options.rawEventLog, options.committedLogEntry, options);
    successVisibilityConfirmed = true;
    callTransactionPostVisibleHook(options);
    return validatedFinalizeResult;
  } catch (error) {
    if (!successVisibilityConfirmed && options.isTransactionError(error)) {
      discardCommittedSuccessEntryVisibility(options.rawEventLog, options.committedLogEntry);
      callTransactionDiscardHook(options);
    }
    throw error;
  }
}

function withIncidentValidationError<Value, ErrorType extends Error>(
  operation: () => Value,
  makeError: IncidentCommitErrorFactory<ErrorType>
): Value {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw makeError(error.message);
    }
    throw error;
  }
}

function callTransactionRawLogRequirement<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
>(
  options: StagedCommitTransactionOptions<
    FinalizeRequest,
    CommittedLogEntry,
    FinalizeResult,
    ErrorType
  >
): void {
  if (options.requireRawEventLog === undefined) {
    return;
  }
  try {
    options.requireRawEventLog(options.rawEventLog);
  } catch (error) {
    if (options.isTransactionError(error)) {
      throw error;
    }
    if (error instanceof RawEventLogQueryValidationError) {
      throw options.makeMalformedFinalizeError(error.message);
    }
    if (options.formatRequirementUnexpectedError === undefined) {
      throw error;
    }
    throw options.makeFinalizeRejectedError(options.formatRequirementUnexpectedError(error));
  }
}

function callTransactionFinalizer<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
>(
  options: StagedCommitTransactionOptions<
    FinalizeRequest,
    CommittedLogEntry,
    FinalizeResult,
    ErrorType
  >
): unknown {
  try {
    return options.finalize(structuredClone(options.finalizeRequest));
  } catch (error) {
    if (options.isTransactionError(error)) {
      throw error;
    }
    if (error instanceof RawEventLogQueryValidationError) {
      throw options.makeMalformedFinalizeError(error.message);
    }
    if (options.formatFinalizeUnexpectedError === undefined) {
      throw error;
    }
    throw options.makeFinalizeRejectedError(options.formatFinalizeUnexpectedError(error));
  }
}

function confirmTransactionVisibility<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
>(
  rawEventLog: unknown,
  committedLogEntry: CommittedLogEntry,
  options: StagedCommitTransactionOptions<
    FinalizeRequest,
    CommittedLogEntry,
    FinalizeResult,
    ErrorType
  >
): void {
  try {
    confirmCommittedSuccessEntryVisibility(rawEventLog, committedLogEntry);
  } catch (error) {
    if (error instanceof RawEventLogQueryValidationError) {
      throw options.makeMalformedFinalizeError(error.message);
    }
    throw error;
  }
}

function callTransactionPostVisibleHook<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
>(
  options: StagedCommitTransactionOptions<
    FinalizeRequest,
    CommittedLogEntry,
    FinalizeResult,
    ErrorType
  >
): void {
  if (options.completeAfterLogVisible === undefined) {
    return;
  }
  try {
    options.completeAfterLogVisible(structuredClone(options.finalizeRequest));
  } catch (error) {
    if (options.isTransactionError(error)) {
      if (options.ignorePostVisibleTransactionError === true) {
        return;
      }
      throw error;
    }
    const transactionError = buildPostVisibleTransactionError(error, options);
    if (options.ignorePostVisibleTransactionError === true) {
      return;
    }
    throw transactionError;
  }
}

function buildPostVisibleTransactionError<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
>(
  error: unknown,
  options: StagedCommitTransactionOptions<
    FinalizeRequest,
    CommittedLogEntry,
    FinalizeResult,
    ErrorType
  >
): ErrorType {
  if (
    error instanceof RawEventLogQueryValidationError &&
    options.mapPostVisibleRawLogValidationAsMalformed !== false
  ) {
    return options.makeMalformedFinalizeError(error.message);
  }
  if (options.formatPostVisibleUnexpectedError === undefined) {
    throw error;
  }
  return options.makeFinalizeRejectedError(options.formatPostVisibleUnexpectedError(error));
}

function callTransactionDiscardHook<
  FinalizeRequest,
  CommittedLogEntry extends RawEventLogEntry,
  FinalizeResult,
  ErrorType extends Error
>(
  options: StagedCommitTransactionOptions<
    FinalizeRequest,
    CommittedLogEntry,
    FinalizeResult,
    ErrorType
  >
): void {
  if (options.discardAfterLogNotVisible === undefined) {
    return;
  }
  try {
    options.discardAfterLogNotVisible(structuredClone(options.finalizeRequest));
  } catch (error) {
    if (options.isTransactionError(error)) {
      throw error;
    }
    if (options.formatDiscardUnexpectedError === undefined) {
      throw error;
    }
    throw options.makeFinalizeRejectedError(options.formatDiscardUnexpectedError(error));
  }
}
