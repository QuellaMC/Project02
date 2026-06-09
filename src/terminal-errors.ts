import { ConversationRehydrationError } from './conversation.ts';
import { LocalRuntimeStorageContractError } from './local-storage.ts';
import { LocalRuntimeSessionStoreError } from './session-store.ts';

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
