import { sep } from 'node:path';

import type { RuntimePluginJsonValue } from '../types.ts';
import type { RuntimePluginFileStorePathMode } from './contracts.ts';

export const durableRevisionFileName =
  '.project02-plugin-store-revision';
export const durablePathModesFileName =
  '.project02-plugin-store-modes.json';

export function normalizeRuntimePluginFileStorePath(path: string): string {
  const normalized = path.trim();

  if (
    normalized.length === 0 ||
    normalized === durableRevisionFileName ||
    normalized === durablePathModesFileName ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized
      .split('/')
      .some((part) => part.length === 0 || part === '.' || part === '..') ||
    normalized.split('/').some((part) => part.includes(sep) && sep !== '/')
  ) {
    throw new TypeError('Plugin file path must be a safe relative path.');
  }

  return normalized;
}

export function freezeRuntimePluginFileStoreJsonValue(
  value: unknown
): RuntimePluginJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Plugin file values must contain finite JSON numbers.');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => freezeRuntimePluginFileStoreJsonValue(item))
    );
  }

  if (isPlainObject(value)) {
    const frozen: Record<string, RuntimePluginJsonValue> = Object.create(null) as Record<
      string,
      RuntimePluginJsonValue
    >;

    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(frozen, key, {
        value: freezeRuntimePluginFileStoreJsonValue(item),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }

    return Object.freeze(frozen);
  }

  throw new TypeError('Plugin file values must be JSON-compatible.');
}

export function parseRuntimePluginJsonlContent(
  content: string
): readonly RuntimePluginJsonValue[] {
  return Object.freeze(
    content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) =>
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
