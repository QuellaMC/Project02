/**
 * The one file-access seam for the runtime store. `runtime/config`,
 * `shared/package-*.ts`, and `plugin-file-store` deliberately stay outside
 * it and report failures in their own terms.
 */
import {MalformedJsonLineError, readCompleteJsonLines} from './json-lines.ts';
import {readTextFileSync} from '../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';

import {LocalRuntimeStorageContractError} from './layout-contract.ts';

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

export function readStoreText(path: string): string {
  try {
    return readTextFileSync(path);
  } catch (error: unknown) {
    throw storeReadFailed(path, error);
  }
}

function storeReadFailed(
  path: string,
  cause: unknown,
): LocalRuntimeStorageContractError {
  return new LocalRuntimeStorageContractError(
    'read_failed',
    `Could not read local runtime store file: ${path}.`,
    {cause},
  );
}

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
