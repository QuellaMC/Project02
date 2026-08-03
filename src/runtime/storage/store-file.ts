/**
 * The one file-access seam for the runtime store.
 *
 * One rule: a filesystem failure under the store is a storage contract
 * error — `read_failed` when we were reading, `write_failed` when we were
 * writing — and the path goes in the message. Callers do not each invent
 * their own mapping, because the CLI collapses every one of them to a
 * single sentence anyway (cli/shared/terminal-errors.ts) and nothing in
 * the codebase branches on those two codes.
 *
 * "Not there" is not a failure. `readOptionalStoreText` returns undefined
 * for a missing file, the way every hand-written variant of this did, so
 * absence stays a value and only real breakage throws.
 *
 * Three places deliberately do NOT use this seam:
 *
 * - `runtime/config` reports diagnostics instead of throwing. Its messages
 *   name the operator's own file and reach them intact; collapsing those
 *   into `read_failed` would trade a fixable complaint for a generic one.
 * - `shared/package-*.ts` reads user-supplied package directories, where
 *   "unreadable" is an expected answer rather than a broken store, and it
 *   is a leaf module that cannot import storage (arch rule 2b).
 * - `plugin-file-store` raises TypeError for plugin contract violations.
 *   Those are "the plugin asked for something invalid", not "the store is
 *   damaged", and the plugin host branches on them.
 */
import {MalformedJsonLineError, readCompleteJsonLines} from './json-lines.ts';
import {readTextFileSync} from '../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';

import {LocalRuntimeStorageContractError} from './layout-contract.ts';

/**
 * Read a store file that may not exist yet. Missing reads as undefined;
 * anything else that stops the read is a `read_failed`.
 */
export function readOptionalStoreText(path: string): string | undefined {
  try {
    return readTextFileSync(path);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw storeReadFailed(path, error);
  }
}

/**
 * Read a store file that has to be there. A missing file is as much a
 * failure as an unreadable one, so both raise.
 */
export function readStoreText(path: string): string {
  try {
    return readTextFileSync(path);
  } catch (error: unknown) {
    throw storeReadFailed(path, error);
  }
}

export function storeReadFailed(
  path: string,
  cause: unknown,
): LocalRuntimeStorageContractError {
  return new LocalRuntimeStorageContractError(
    'read_failed',
    `Could not read local runtime store file: ${path}.`,
    {cause},
  );
}

/**
 * A store file's committed records, with a damaged one named as a store
 * contract failure.
 *
 * `readCompleteJsonLines` answers a framing question and raises a plain
 * TypeError; the CLI branches on LocalRuntimeStorageContractError to tell
 * an operator which file is broken. Translating in one place keeps every
 * store reader giving the same answer.
 */
export function readStoreJsonLines(
  filePath: string,
  content: string,
): readonly string[] {
  try {
    return readCompleteJsonLines(content);
  } catch (error: unknown) {
    if (!(error instanceof MalformedJsonLineError)) {
      throw error;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Local runtime log file has a malformed record on line ${String(error.lineNumber)}: ${filePath}.`,
      {cause: error},
    );
  }
}

export function storeWriteFailed(
  path: string,
  cause: unknown,
): LocalRuntimeStorageContractError {
  return new LocalRuntimeStorageContractError(
    'write_failed',
    `Could not write local runtime store file: ${path}.`,
    {cause},
  );
}
