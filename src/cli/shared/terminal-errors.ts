import {ConversationRehydrationError} from '../../core/index.ts';
import {RoleModelProviderSelectionError} from '../../role-model/index.ts';
import {
  RuntimeConfigLocationError,
  RuntimeConfigMutationError,
  RuntimeEnvFileError,
} from '../../runtime/config/index.ts';
import {
  LocalRuntimeSessionStoreError,
  LocalRuntimeStorageContractError,
} from '../../runtime/storage/index.ts';
import {Project02StoreConsentError} from './store-consent.ts';
import {CliUsageError} from './usage-error.ts';

/** Chat rejects its own startup; the terminal set below carries it. */
export class ChatCliStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatCliStartupError';
  }
}

type LocalRuntimeTerminalError =
  | ConversationRehydrationError
  | RuntimeConfigLocationError
  | LocalRuntimeSessionStoreError
  | LocalRuntimeStorageContractError;

function isLocalRuntimeTerminalError(
  error: unknown,
): error is LocalRuntimeTerminalError {
  return (
    error instanceof ConversationRehydrationError ||
    error instanceof RuntimeConfigLocationError ||
    error instanceof LocalRuntimeSessionStoreError ||
    error instanceof LocalRuntimeStorageContractError
  );
}

/**
 * The one membership list: every CLI reports exactly these as a message and
 * exit code 1, and lets anything else escape as the fault it is.
 */
export function isCliTerminalError(error: unknown): error is Error {
  return (
    error instanceof CliUsageError ||
    error instanceof ChatCliStartupError ||
    error instanceof Project02StoreConsentError ||
    error instanceof RoleModelProviderSelectionError ||
    error instanceof RuntimeConfigMutationError ||
    error instanceof RuntimeEnvFileError ||
    isLocalRuntimeTerminalError(error)
  );
}

function formatLocalRuntimeTerminalError(
  error: LocalRuntimeTerminalError,
): string {
  if (error instanceof LocalRuntimeStorageContractError) {
    return formatLocalRuntimeStorageContractError(error);
  }

  return error.message;
}

function formatLocalRuntimeStorageContractError(
  error: LocalRuntimeStorageContractError,
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

/** Single owner of the CLI fatal-error formatting shape. */
export function formatCliTerminalErrorMessage(error: Error): string {
  // Read before narrowing: the negated branch would otherwise be `never`.
  const fallbackMessage = error.message;

  return isLocalRuntimeTerminalError(error)
    ? formatLocalRuntimeTerminalError(error)
    : fallbackMessage;
}
