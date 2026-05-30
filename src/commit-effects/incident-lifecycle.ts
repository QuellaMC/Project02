import {
  RawEventLogQueryValidationError,
  validateRawEventLogEntry,
  type RawEventLogEntry
} from '../runtime/logging.ts';
import { ContractValidationError } from '../runtime/errors.ts';
import { requireLiteral } from '../runtime/validation.ts';

export type IncidentLogSourceIdentity = {
  trace_id: string;
  event_id: string;
};

export type IncidentCommitErrorFactory<ErrorType extends Error> = (
  message: string
) => ErrorType;

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
