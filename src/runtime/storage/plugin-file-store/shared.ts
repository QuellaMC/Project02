import {sep} from 'node:path';

import {parseAtomicReplacementFileName} from '../atomic-file.ts';
import {createJsonBoundarySnapshot} from '../../../shared/json-boundary.ts';
import {isNodeErrorWithCode} from '../../../shared/node-error.ts';
import {readCompleteJsonLines} from '../json-lines.ts';
import type {RuntimePluginJsonValue} from '../../../plugins/api/index.ts';
import type {RuntimePluginFileStorePathMode} from '../../../plugins/api/index.ts';

export const durableRevisionFileName = '.project02-plugin-store-revision';
export const durablePathModesFileName = '.project02-plugin-store-modes.json';
export const durableDirectMutationJournalFileName =
  '.project02-plugin-store-direct-mutation.json';

export function normalizeRuntimePluginFileStorePath(path: string): string {
  const normalized = path.trim();
  const parts = normalized.split('/');

  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    parts.some(
      part =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        part === durableRevisionFileName ||
        part === durablePathModesFileName ||
        part === durableDirectMutationJournalFileName ||
        parseAtomicReplacementFileName(part) !== undefined,
    ) ||
    parts.some(part => part.includes(sep) && sep !== '/')
  ) {
    throw new TypeError('Plugin file path must be a safe relative path.');
  }

  return normalized;
}

export function freezeRuntimePluginFileStoreJsonValue(
  value: unknown,
): RuntimePluginJsonValue {
  return createJsonBoundarySnapshot(value, {
    field: 'Plugin file value',
  });
}

export function parseRuntimePluginJsonlContent(
  content: string,
): readonly RuntimePluginJsonValue[] {
  return Object.freeze(
    readCompleteJsonLines(content).map(line =>
      freezeRuntimePluginFileStoreJsonValue(JSON.parse(line) as unknown),
    ),
  );
}

export function assertJsonlPathMode(
  mode: RuntimePluginFileStorePathMode | undefined,
): void {
  if (mode === 'json') {
    throw new TypeError('Plugin JSONL path already stores non-array JSON.');
  }
}

export function assertJsonPathMode(
  mode: RuntimePluginFileStorePathMode | undefined,
): void {
  if (mode === 'jsonl') {
    throw new TypeError('Plugin JSON path already stores JSONL.');
  }
}

export function isRuntimePluginFileStorePathMode(
  value: unknown,
): value is RuntimePluginFileStorePathMode {
  return value === 'json' || value === 'jsonl';
}

export function isJsonArray(
  value: RuntimePluginJsonValue,
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}

export function isMissingFileError(error: unknown): boolean {
  return (
    isNodeErrorWithCode(error, 'ENOENT') ||
    isNodeErrorWithCode(error, 'ENOTDIR')
  );
}
