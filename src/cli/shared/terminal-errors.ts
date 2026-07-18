import { ConversationRehydrationError } from '../../core/index.ts';
import {
  LocalRuntimeSessionStoreError,
  LocalRuntimeStorageContractError
} from '../../runtime/storage/index.ts';

export type LocalRuntimeTerminalError =
  | ConversationRehydrationError
  | LocalRuntimeSessionStoreError
  | LocalRuntimeStorageContractError;

export function isLocalRuntimeTerminalError(
  error: unknown
): error is LocalRuntimeTerminalError {
  return (
    error instanceof ConversationRehydrationError ||
    error instanceof LocalRuntimeSessionStoreError ||
    error instanceof LocalRuntimeStorageContractError
  );
}

export function formatLocalRuntimeTerminalError(
  error: LocalRuntimeTerminalError
): string {
  if (error instanceof LocalRuntimeStorageContractError) {
    return formatLocalRuntimeStorageContractError(error);
  }

  return error.message;
}

function formatLocalRuntimeStorageContractError(
  error: LocalRuntimeStorageContractError
): string {
  switch (error.code) {
    case 'missing_file':
      return 'Local runtime store is missing required files.';
    case 'partial_write':
      return 'Local runtime store write did not complete.';
    case 'read_failed':
      return 'Local runtime store could not be read.';
    case 'write_failed':
      return 'Local runtime store could not be written.';
    default:
      return error.message;
  }
}

/**
 * Single owner of the CLI fatal-error formatting shape (S-13): known CLI
 * errors surface their message; terminal store errors get the
 * user-facing formatter. The two sets are disjoint.
 */
export function formatCliTerminalErrorMessage(error: Error): string {
  // Read the fallback before narrowing: the terminal error classes add no
  // structural members, so the negated branch would otherwise be `never`.
  const fallbackMessage = error.message;

  return isLocalRuntimeTerminalError(error)
    ? formatLocalRuntimeTerminalError(error)
    : fallbackMessage;
}
