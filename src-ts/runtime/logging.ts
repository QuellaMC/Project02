import { isDeepStrictEqual } from 'node:util';

import { SCHEMA_VERSION, type SchemaVersion } from './schema.ts';
import { ContractValidationError } from './errors.ts';
import { validateIso8601Timestamp } from './validation.ts';

export const ATOMIC_FINALIZER_SUCCESS_KINDS = [
  'living_state_patch_committed',
  'life_incident_started',
  'life_incident_cancelled',
  'life_incident_completed',
  'life_incident_interrupted'
] as const;

export type RawEventLogEntry = {
  schema_version: SchemaVersion;
  log_id: string;
  trace_id: string;
  event_id: string;
  kind: string;
  created_at: string;
  data: Record<string, unknown>;
};

export type RawEventLogQuery = {
  trace_id: string;
  event_id?: string;
  kinds?: string[];
};

export type RawEventLogQueryResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  entries: RawEventLogEntry[];
};

export type IdGenerator = (kind: string) => string;
export type Clock = () => Date | string;
type SuccessConfirmingLog = {
  confirmCommittedSuccessEntry: (entry: RawEventLogEntry) => void;
};
type SuccessDiscardingLog = {
  discardCommittedSuccessEntry: (entry: RawEventLogEntry) => void;
};

export class RawEventLogQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawEventLogQueryValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InMemoryRawEventLog {
  #entryOrder: string[] = [];
  #entriesByLogId = new Map<string, RawEventLogEntry>();
  #pendingSuccessByLogId = new Map<string, RawEventLogEntry>();

  append(entry: RawEventLogEntry): void {
    const normalizedEntry = validateRawEventLogEntry(entry);
    if (isAtomicFinalizerSuccessKind(normalizedEntry.kind)) {
      const committedEntry = this.#entriesByLogId.get(normalizedEntry.log_id);
      if (committedEntry !== undefined) {
        if (!isDeepStrictEqual(committedEntry, normalizedEntry)) {
          throw new RawEventLogQueryValidationError(
            'RawEventLogEntry.log_id already exists with different data.'
          );
        }
        return;
      }
      throw new RawEventLogQueryValidationError(
        'Atomic finalizer success entries must be exposed and confirmed before append.'
      );
    }
    this.#recordEntry(normalizedEntry);
  }

  exposeCommittedSuccessEntry(entry: RawEventLogEntry): void {
    const normalizedEntry = validateAtomicFinalizerSuccessEntry(entry);
    const committedEntry = this.#entriesByLogId.get(normalizedEntry.log_id);
    if (committedEntry !== undefined) {
      if (!isDeepStrictEqual(committedEntry, normalizedEntry)) {
        throw new RawEventLogQueryValidationError(
          'RawEventLogEntry.log_id already exists with different data.'
        );
      }
      return;
    }
    const existingEntry = this.#pendingSuccessByLogId.get(normalizedEntry.log_id);
    if (existingEntry !== undefined && !isDeepStrictEqual(existingEntry, normalizedEntry)) {
      throw new RawEventLogQueryValidationError(
        'Pending RawEventLogEntry.log_id already exists with different data.'
      );
    }
    this.#pendingSuccessByLogId.set(normalizedEntry.log_id, normalizedEntry);
  }

  confirmCommittedSuccessEntry(entry: RawEventLogEntry): void {
    const normalizedEntry = validateAtomicFinalizerSuccessEntry(entry);
    const committedEntry = this.#entriesByLogId.get(normalizedEntry.log_id);
    if (committedEntry !== undefined) {
      if (!isDeepStrictEqual(committedEntry, normalizedEntry)) {
        throw new RawEventLogQueryValidationError(
          'Confirmed RawEventLogEntry.log_id already exists with different data.'
        );
      }
      return;
    }

    const pendingEntry = this.#pendingSuccessByLogId.get(normalizedEntry.log_id);
    if (pendingEntry === undefined) {
      throw new RawEventLogQueryValidationError(
        'Confirmed RawEventLogEntry was not staged by finalizer visibility.'
      );
    }
    if (!isDeepStrictEqual(pendingEntry, normalizedEntry)) {
      throw new RawEventLogQueryValidationError(
        'Confirmed RawEventLogEntry does not match pending success data.'
      );
    }
    this.#pendingSuccessByLogId.delete(normalizedEntry.log_id);
    this.#recordEntry(normalizedEntry);
  }

  discardCommittedSuccessEntry(entry: RawEventLogEntry): void {
    const normalizedEntry = validateAtomicFinalizerSuccessEntry(entry);
    this.#pendingSuccessByLogId.delete(normalizedEntry.log_id);
  }

  query(query: unknown): RawEventLogQueryResult {
    return queryRawEventLogEntries(this.#entries(), query);
  }

  #entries(): RawEventLogEntry[] {
    return this.#entryOrder.map((logId) => {
      const entry = this.#entriesByLogId.get(logId);
      if (entry === undefined) {
        throw new RawEventLogQueryValidationError('RawEventLogEntry order is corrupt.');
      }
      return entry;
    });
  }

  #recordEntry(entry: RawEventLogEntry): void {
    const normalizedEntry = validateRawEventLogEntry(entry);
    const existingEntry = this.#entriesByLogId.get(normalizedEntry.log_id);
    if (existingEntry !== undefined) {
      if (!isDeepStrictEqual(existingEntry, normalizedEntry)) {
        throw new RawEventLogQueryValidationError(
          'RawEventLogEntry.log_id already exists with different data.'
        );
      }
      return;
    }
    this.#entryOrder.push(normalizedEntry.log_id);
    this.#entriesByLogId.set(normalizedEntry.log_id, normalizedEntry);
  }
}

export function buildRawLogEntry({
  trace_id,
  event_id,
  kind,
  data,
  idGenerator,
  clock
}: {
  trace_id: string;
  event_id: string;
  kind: string;
  data: Record<string, unknown>;
  idGenerator: IdGenerator;
  clock: Clock;
}): RawEventLogEntry {
  return {
    log_id: generateId('log', idGenerator),
    trace_id,
    event_id,
    kind,
    created_at: clockTimestamp(clock),
    schema_version: SCHEMA_VERSION,
    data: cloneRecord(data)
  };
}

export function snapshotRawValue(value: unknown): unknown {
  if (isPlainRecord(value)) {
    return snapshotCloneableRecord(value, new WeakSet<object>());
  }
  return { raw_value: pythonLikeRepr(value, new WeakSet<object>()) };
}

export function generateId(kind: string, idGenerator: IdGenerator): string {
  const generated = idGenerator(kind);
  if (typeof generated !== 'string' || generated.trim().length === 0) {
    throw new Error(`ID generator returned an invalid ${kind} id.`);
  }
  return generated;
}

export function clockTimestamp(clock: Clock): string {
  const timestamp = clock();
  if (typeof timestamp === 'string') {
    return normalizeExplicitClockTimestamp(timestamp);
  }
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new Error('Clock returned a non-datetime value.');
  }
  return timestamp.toISOString().replace('.000Z', '+00:00').replace('Z', '+00:00');
}

export function queryRawEventLogEntries(
  entries: Iterable<unknown>,
  query: unknown
): RawEventLogQueryResult {
  const normalizedQuery = validateRawEventLogQuery(query);
  const queriedEntries = Array.from(entries, (entry) => validateRawEventLogEntry(entry)).filter(
    (entry) => entryMatchesQuery(entry, normalizedQuery)
  );
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: normalizedQuery.trace_id,
    entries: queriedEntries.map((entry) => cloneRawLogEntry(entry))
  };
}

export function confirmCommittedSuccessEntryVisibility(
  rawEventLog: unknown,
  entry: RawEventLogEntry
): void {
  if (hasConfirmCommittedSuccessEntry(rawEventLog)) {
    rawEventLog.confirmCommittedSuccessEntry(entry);
  }
}

export function discardCommittedSuccessEntryVisibility(
  rawEventLog: unknown,
  entry: RawEventLogEntry | undefined
): void {
  if (entry === undefined) {
    return;
  }
  if (hasDiscardCommittedSuccessEntry(rawEventLog)) {
    rawEventLog.discardCommittedSuccessEntry(entry);
  }
}

export function validateRawEventLogQuery(query: unknown): RawEventLogQuery {
  if (!isPlainRecord(query)) {
    throw new RawEventLogQueryValidationError('RawEventLogQuery must be a mapping.');
  }
  rejectExtraKeys(query, ['trace_id', 'event_id', 'kinds'], 'RawEventLogQuery');
  const normalizedQuery: RawEventLogQuery = {
    trace_id: requireNonEmptyString(query['trace_id'], 'RawEventLogQuery.trace_id')
  };
  if (Object.hasOwn(query, 'event_id')) {
    normalizedQuery.event_id = requireNonEmptyString(
      query['event_id'],
      'RawEventLogQuery.event_id'
    );
  }
  if (Object.hasOwn(query, 'kinds')) {
    const kinds = query['kinds'];
    if (!Array.isArray(kinds)) {
      throw new RawEventLogQueryValidationError('RawEventLogQuery.kinds must be a list.');
    }
    if (kinds.length === 0) {
      throw new RawEventLogQueryValidationError(
        'RawEventLogQuery.kinds must not be empty when provided.'
      );
    }
    normalizedQuery.kinds = kinds.map((kind) =>
      requireNonEmptyString(kind, 'RawEventLogQuery.kinds[]')
    );
  }
  return normalizedQuery;
}

export function validateRawEventLogEntry(entry: unknown): RawEventLogEntry {
  if (!isPlainRecord(entry)) {
    throw new RawEventLogQueryValidationError('RawEventLogEntry must be a mapping.');
  }
  rejectExtraKeys(
    entry,
    ['schema_version', 'log_id', 'trace_id', 'event_id', 'kind', 'created_at', 'data'],
    'RawEventLogEntry'
  );
  if (entry['schema_version'] !== SCHEMA_VERSION) {
    throw new RawEventLogQueryValidationError(
      `RawEventLogEntry.schema_version must be ${JSON.stringify(SCHEMA_VERSION)}.`
    );
  }
  const data = entry['data'];
  if (!isPlainRecord(data)) {
    throw new RawEventLogQueryValidationError('RawEventLogEntry.data must be a mapping.');
  }
  return {
    schema_version: SCHEMA_VERSION,
    log_id: requireNonEmptyString(entry['log_id'], 'RawEventLogEntry.log_id'),
    trace_id: requireNonEmptyString(entry['trace_id'], 'RawEventLogEntry.trace_id'),
    event_id: requireNonEmptyString(entry['event_id'], 'RawEventLogEntry.event_id'),
    kind: requireNonEmptyString(entry['kind'], 'RawEventLogEntry.kind'),
    created_at: requireNonEmptyString(entry['created_at'], 'RawEventLogEntry.created_at'),
    data: cloneRecord(data)
  };
}

function validateAtomicFinalizerSuccessEntry(entry: unknown): RawEventLogEntry {
  const normalizedEntry = validateRawEventLogEntry(entry);
  if (!isAtomicFinalizerSuccessKind(normalizedEntry.kind)) {
    throw new RawEventLogQueryValidationError(
      'RawEventLogEntry.kind must be an atomic finalizer success kind.'
    );
  }
  return normalizedEntry;
}

function cloneRawLogEntry(entry: RawEventLogEntry): RawEventLogEntry {
  return {
    schema_version: entry.schema_version,
    log_id: entry.log_id,
    trace_id: entry.trace_id,
    event_id: entry.event_id,
    kind: entry.kind,
    created_at: entry.created_at,
    data: cloneRecord(entry.data)
  };
}

function entryMatchesQuery(entry: RawEventLogEntry, query: RawEventLogQuery): boolean {
  if (entry.trace_id !== query.trace_id) {
    return false;
  }
  if (query.event_id !== undefined && entry.event_id !== query.event_id) {
    return false;
  }
  if (query.kinds !== undefined && !query.kinds.includes(entry.kind)) {
    return false;
  }
  return true;
}

function isAtomicFinalizerSuccessKind(kind: string): boolean {
  return ATOMIC_FINALIZER_SUCCESS_KINDS.some((successKind) => successKind === kind);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotCloneableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (isPlainRecord(value)) {
    return snapshotCloneableRecord(value, seen);
  }
  if (Array.isArray(value)) {
    return snapshotCloneableArray(value, seen);
  }
  if (isCloneSafeScalar(value)) {
    return value;
  }
  return { raw_value: pythonLikeRepr(value, seen) };
}

function snapshotCloneableRecord(
  value: Record<string, unknown>,
  seen: WeakSet<object>
): Record<string, unknown> {
  if (seen.has(value)) {
    return { raw_value: '{...}' };
  }
  seen.add(value);
  const snapshot: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    snapshot[key] = snapshotCloneableValue(entryValue, seen);
  }
  seen.delete(value);
  return snapshot;
}

function snapshotCloneableArray(
  value: unknown[],
  seen: WeakSet<object>
): unknown[] | Record<string, string> {
  if (seen.has(value)) {
    return { raw_value: '[...]' };
  }
  seen.add(value);
  const snapshot = value.map((entryValue) => snapshotCloneableValue(entryValue, seen));
  seen.delete(value);
  return snapshot;
}

function isCloneSafeScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  );
}

function pythonLikeRepr(value: unknown, seen: WeakSet<object>): string {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[...]';
    }
    seen.add(value);
    const body = value.map((item) => pythonLikeRepr(item, seen)).join(', ');
    seen.delete(value);
    return `[${body}]`;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) {
      return '{...}';
    }
    seen.add(value);
    const entries = Object.entries(value).map(
      ([key, entryValue]) => `${pythonLikeStringRepr(key)}: ${pythonLikeRepr(entryValue, seen)}`
    );
    seen.delete(value);
    return `{${entries.join(', ')}}`;
  }
  if (typeof value === 'string') {
    return pythonLikeStringRepr(value);
  }
  if (value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'symbol') {
    return value.description === undefined ? 'Symbol()' : `Symbol(${value.description})`;
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  try {
    const jsonValue: unknown = JSON.stringify(value);
    if (typeof jsonValue === 'string') {
      return jsonValue;
    }
    return Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function pythonLikeStringRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let body = '';
  for (const character of value) {
    body += pythonLikeEscapedCharacter(character, quote);
  }
  return `${quote}${body}${quote}`;
}

function pythonLikeEscapedCharacter(character: string, quote: string): string {
  if (character === quote || character === '\\') {
    return `\\${character}`;
  }
  if (character === '\n') {
    return '\\n';
  }
  if (character === '\r') {
    return '\\r';
  }
  if (character === '\t') {
    return '\\t';
  }
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return character;
  }
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return `\\x${codePoint.toString(16).padStart(2, '0')}`;
  }
  if (codePoint === 0x2028 || codePoint === 0x2029) {
    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }
  return character;
}

function isCallableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectExtraKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  sourceName: string
): void {
  const allowed = new Set(allowedKeys);
  const extraKeys = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (extraKeys.length > 0) {
    throw new RawEventLogQueryValidationError(
      `${sourceName} has unsupported keys: ${JSON.stringify(extraKeys)}.`
    );
  }
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RawEventLogQueryValidationError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return clonePlainRecord(value, new WeakMap<object, unknown>());
}

function clonePlainRecord(
  value: Record<string, unknown>,
  seen: WeakMap<object, unknown>
): Record<string, unknown> {
  const existing = seen.get(value);
  if (isPlainRecord(existing)) {
    return existing;
  }
  const cloned: Record<string, unknown> = {};
  seen.set(value, cloned);
  for (const [key, entryValue] of Object.entries(value)) {
    cloned[key] = cloneRawValue(entryValue, seen);
  }
  return cloned;
}

function cloneRawValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (isPlainRecord(value)) {
    return clonePlainRecord(value, seen);
  }
  if (Array.isArray(value)) {
    return cloneArray(value, seen);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Map) {
    return cloneMap(value, seen);
  }
  if (value instanceof Set) {
    return cloneSet(value, seen);
  }
  if (typeof value !== 'object' || value === null || typeof value === 'function') {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function cloneArray(value: unknown[], seen: WeakMap<object, unknown>): unknown[] {
  const existing = seen.get(value);
  if (Array.isArray(existing)) {
    return existing;
  }
  const cloned: unknown[] = [];
  seen.set(value, cloned);
  for (const entryValue of value) {
    cloned.push(cloneRawValue(entryValue, seen));
  }
  return cloned;
}

function cloneMap(value: Map<unknown, unknown>, seen: WeakMap<object, unknown>): Map<unknown, unknown> {
  const existing = seen.get(value);
  if (existing instanceof Map) {
    return existing;
  }
  const cloned = new Map<unknown, unknown>();
  seen.set(value, cloned);
  for (const [key, entryValue] of value.entries()) {
    cloned.set(cloneRawValue(key, seen), cloneRawValue(entryValue, seen));
  }
  return cloned;
}

function cloneSet(value: Set<unknown>, seen: WeakMap<object, unknown>): Set<unknown> {
  const existing = seen.get(value);
  if (existing instanceof Set) {
    return existing;
  }
  const cloned = new Set<unknown>();
  seen.set(value, cloned);
  for (const entryValue of value.values()) {
    cloned.add(cloneRawValue(entryValue, seen));
  }
  return cloned;
}

function normalizeExplicitClockTimestamp(timestamp: string): string {
  let normalized: string;
  try {
    normalized = validateIso8601Timestamp(timestamp, 'Clock timestamp');
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new Error('Clock returned a non-datetime value.', { cause: error });
    }
    throw error;
  }
  if (normalized.endsWith('Z')) {
    return `${normalized.slice(0, -1)}+00:00`;
  }
  if (hasExplicitTimezoneOffset(normalized)) {
    return normalized;
  }
  return `${normalized}+00:00`;
}

function hasExplicitTimezoneOffset(timestamp: string): boolean {
  const separatorIndex = timestampDatetimeSeparatorIndex(timestamp);
  if (separatorIndex < 0) {
    return false;
  }
  const timeComponent = timestamp.slice(separatorIndex + 1);
  return /[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?$/.test(timeComponent);
}

function timestampDatetimeSeparatorIndex(timestamp: string): number {
  const upperT = timestamp.indexOf('T');
  const lowerT = timestamp.indexOf('t');
  const space = timestamp.length > 10 && /\s/.test(timestamp[10] ?? '') ? 10 : -1;
  return (
    [upperT, lowerT, space]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1
  );
}

function hasConfirmCommittedSuccessEntry(value: unknown): value is SuccessConfirmingLog {
  return (
    isCallableRecord(value) &&
    typeof value['confirmCommittedSuccessEntry'] === 'function'
  );
}

function hasDiscardCommittedSuccessEntry(value: unknown): value is SuccessDiscardingLog {
  return (
    isCallableRecord(value) &&
    typeof value['discardCommittedSuccessEntry'] === 'function'
  );
}
