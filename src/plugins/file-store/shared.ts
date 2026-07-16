import { sep } from 'node:path';

import { parseAtomicReplacementFileName } from '../../runtime/storage/atomic-file.ts';
import { createJsonBoundarySnapshot } from '../../shared/json-boundary.ts';
import { splitCompleteJsonLines } from '../../shared/json-lines.ts';
import type { RuntimePluginJsonValue } from '../types.ts';
import type { RuntimePluginFileStorePathMode } from './contracts.ts';

export const durableRevisionFileName =
  '.project02-plugin-store-revision';
export const durablePathModesFileName =
  '.project02-plugin-store-modes.json';
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
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        part === durableRevisionFileName ||
        part === durablePathModesFileName ||
        part === durableDirectMutationJournalFileName ||
        parseAtomicReplacementFileName(part) !== undefined
    ) ||
    parts.some((part) => part.includes(sep) && sep !== '/')
  ) {
    throw new TypeError('Plugin file path must be a safe relative path.');
  }

  return normalized;
}

export function freezeRuntimePluginFileStoreJsonValue(
  value: unknown
): RuntimePluginJsonValue {
  return createJsonBoundarySnapshot(value, {
    field: 'Plugin file value'
  });
}

export function parseRuntimePluginJsonlContent(
  content: string
): readonly RuntimePluginJsonValue[] {
  return Object.freeze(
    splitCompleteJsonLines(content).map((line) =>
      freezeRuntimePluginFileStoreJsonValue(JSON.parse(line) as unknown)
    )
  );
}

export function assertJsonlPathMode(
  mode: RuntimePluginFileStorePathMode | undefined
): void {
  if (mode === 'json') {
    throw new TypeError('Plugin JSONL path already stores non-array JSON.');
  }
}

export function assertJsonPathMode(
  mode: RuntimePluginFileStorePathMode | undefined
): void {
  if (mode === 'jsonl') {
    throw new TypeError('Plugin JSON path already stores JSONL.');
  }
}

export function isRuntimePluginFileStorePathMode(
  value: unknown
): value is RuntimePluginFileStorePathMode {
  return value === 'json' || value === 'jsonl';
}

export function isJsonArray(
  value: RuntimePluginJsonValue
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}

export function isPlainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
