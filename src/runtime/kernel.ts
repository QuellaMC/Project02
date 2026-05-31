import { randomUUID } from 'node:crypto';

import {
  ContractValidationError,
  INCIDENT_COMPLETION,
  USER_MESSAGE,
  validateNormalizedIncidentCompletionEvent,
  validateNormalizedUserMessageEvent,
  type IncidentCompletionPayload,
  type RuntimeEvent,
  type UserMessagePayload
} from './contracts.ts';
import {
  buildRawLogEntry,
  clockTimestamp,
  generateId,
  type Clock,
  type IdGenerator,
  type RawEventLogEntry
} from './logging.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { validateIso8601Timestamp } from './validation.ts';

export const RAW_EVENT_RECEIVED_KIND = 'runtime_event_received';

export type RuntimeRouteResult =
  | {
      trace_id: string;
      event_id: string;
      event_type: typeof USER_MESSAGE;
      model_needed: true;
      next_step: 'user_turn';
    }
  | {
      trace_id: string;
      event_id: string;
      event_type: typeof INCIDENT_COMPLETION;
      model_needed: false;
      next_step: 'incident_completion_commit';
    };

export type RuntimeEventIntakeResult = {
  event: RuntimeEvent;
  route: RuntimeRouteResult;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

type PayloadNormalizer = (payload: unknown) => Record<string, unknown>;
type EventValidator = (event: unknown) => RuntimeEvent;
type ValueRecord = Record<string, unknown>;
export type RuntimeRouteInput = {
  event_id: string;
  trace_id: string;
  type: string;
  [key: string]: unknown;
};

type RuntimeDependencies = {
  idGenerator?: IdGenerator;
  clock?: Clock;
};

type IntakeDependencies = RuntimeDependencies & {
  rawEventLog: RawEventLog;
};

export class RuntimeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function defaultIdGenerator(kind: string): string {
  return `${kind}_${randomUUID().replaceAll('-', '')}`;
}

export function defaultClock(): Date {
  return new Date();
}

export class RuntimeKernel {
  readonly #rawEventLog: RawEventLog;
  readonly #idGenerator: IdGenerator;
  readonly #clock: Clock;

  constructor(
    rawEventLog: RawEventLog,
    { idGenerator = defaultIdGenerator, clock = defaultClock }: RuntimeDependencies = {}
  ) {
    this.#rawEventLog = rawEventLog;
    this.#idGenerator = idGenerator;
    this.#clock = clock;
  }

  handleEvent(eventInput: unknown): RuntimeRouteResult {
    return intakeRuntimeEvent(eventInput, {
      rawEventLog: this.#rawEventLog,
      idGenerator: this.#idGenerator,
      clock: this.#clock
    }).route;
  }
}

export function intakeRuntimeEvent(
  eventInput: unknown,
  {
    rawEventLog,
    idGenerator = defaultIdGenerator,
    clock = defaultClock
  }: IntakeDependencies
): RuntimeEventIntakeResult {
  const event = normalizeRuntimeEvent(eventInput, { idGenerator, clock });
  rawEventLog.append(buildRawEventLogEntry(event, { idGenerator, clock }));
  const route = routeRuntimeEvent(event);
  return { event, route };
}

export function normalizeRuntimeEvent(
  eventInput: unknown,
  { idGenerator = defaultIdGenerator, clock = defaultClock }: RuntimeDependencies = {}
): RuntimeEvent {
  const eventRecord = requireRecord(eventInput, 'Runtime event input');
  const eventType = normalizeEventType(getOwnField(eventRecord, 'type'));
  const payload = normalizePayloadForEventType(eventType, getOwnField(eventRecord, 'payload'));
  const normalizedEvent = {
    event_id: normalizeOptionalId(getOwnField(eventRecord, 'event_id'), {
      fieldName: 'event_id',
      generatedKind: 'event',
      idGenerator
    }),
    trace_id: normalizeOptionalId(getOwnField(eventRecord, 'trace_id'), {
      fieldName: 'trace_id',
      generatedKind: 'trace',
      idGenerator
    }),
    type: eventType,
    created_at: normalizeCreatedAt(
      Object.hasOwn(eventRecord, 'created_at') ? eventRecord['created_at'] : undefined,
      { clock, wasProvided: Object.hasOwn(eventRecord, 'created_at') }
    ),
    schema_version: normalizeSchemaVersion(eventRecord),
    payload
  };

  try {
    return EVENT_VALIDATORS[eventType](normalizedEvent);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new RuntimeValidationError(error.message);
    }
    throw error;
  }
}

export function buildRawEventLogEntry(
  event: RuntimeEvent,
  { idGenerator = defaultIdGenerator, clock = defaultClock }: RuntimeDependencies = {}
): RawEventLogEntry {
  return buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: RAW_EVENT_RECEIVED_KIND,
    data: { event },
    idGenerator,
    clock
  });
}

export function routeRuntimeEvent(event: unknown): RuntimeRouteResult {
  const routeInput = requireRecord(event, 'Runtime route input');
  const eventType = getOwnField(routeInput, 'type');

  switch (eventType) {
    case USER_MESSAGE:
      return routeUserMessageEvent(routeInput);
    case INCIDENT_COMPLETION:
      return routeIncidentCompletionEvent(routeInput);
    default:
      throw new RuntimeValidationError(
        `Unsupported event type for routing: ${repr(eventType)}.`
      );
  }
}

function routeUserMessageEvent(event: ValueRecord): RuntimeRouteResult {
  const identity = requireRouteIdentity(event);
  return {
    trace_id: identity.traceId,
    event_id: identity.eventId,
    event_type: USER_MESSAGE,
    model_needed: true,
    next_step: 'user_turn'
  };
}

function routeIncidentCompletionEvent(event: ValueRecord): RuntimeRouteResult {
  const identity = requireRouteIdentity(event);
  return {
    trace_id: identity.traceId,
    event_id: identity.eventId,
    event_type: INCIDENT_COMPLETION,
    model_needed: false,
    next_step: 'incident_completion_commit'
  };
}

function requireRouteIdentity(event: ValueRecord): { eventId: string; traceId: string } {
  return {
    eventId: requireRouteString(getOwnField(event, 'event_id'), 'event_id'),
    traceId: requireRouteString(getOwnField(event, 'trace_id'), 'trace_id')
  };
}

function requireRouteString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeValidationError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function normalizeEventType(value: unknown): RuntimeEvent['type'] {
  if (value === USER_MESSAGE || value === INCIDENT_COMPLETION) {
    return value;
  }
  throw new RuntimeValidationError(`Unsupported event type: ${repr(value)}.`);
}

function normalizePayloadForEventType(
  eventType: RuntimeEvent['type'],
  payload: unknown
): Record<string, unknown> {
  return EVENT_PAYLOAD_NORMALIZERS[eventType](payload);
}

function normalizeUserMessagePayload(payload: unknown): UserMessagePayload {
  const payloadRecord = requireRecord(payload, 'payload');
  const text = getOwnField(payloadRecord, 'text');
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new RuntimeValidationError('payload.text must be a non-empty string.');
  }
  const normalized: UserMessagePayload = { text };
  for (const fieldName of ['user_id', 'conversation_id'] as const) {
    if (Object.hasOwn(payloadRecord, fieldName)) {
      const value = payloadRecord[fieldName];
      if (value === null) {
        continue;
      }
      if (typeof value !== 'string') {
        throw new RuntimeValidationError(`payload.${fieldName} must be a string.`);
      }
      normalized[fieldName] = value;
    }
  }
  return normalized;
}

function normalizeIncidentCompletionPayload(payload: unknown): IncidentCompletionPayload {
  const payloadRecord = requireRecord(payload, 'payload');
  const extraKeys = Object.keys(payloadRecord)
    .filter((key) => !['incident_id', 'user_id', 'conversation_id'].includes(key))
    .sort();
  if (extraKeys.length > 0) {
    throw new RuntimeValidationError(
      `payload contains extra field(s): ${extraKeys.join(', ')}.`
    );
  }

  const incidentId = getOwnField(payloadRecord, 'incident_id');
  if (typeof incidentId !== 'string' || incidentId.trim().length === 0) {
    throw new RuntimeValidationError('payload.incident_id must be a non-empty string.');
  }

  const normalized: IncidentCompletionPayload = { incident_id: incidentId.trim() };
  for (const fieldName of ['user_id', 'conversation_id'] as const) {
    if (Object.hasOwn(payloadRecord, fieldName)) {
      const value = payloadRecord[fieldName];
      if (value === null) {
        continue;
      }
      if (typeof value !== 'string') {
        throw new RuntimeValidationError(`payload.${fieldName} must be a string.`);
      }
      normalized[fieldName] = value;
    }
  }
  return normalized;
}

function normalizeOptionalId(
  value: unknown,
  {
    fieldName,
    generatedKind,
    idGenerator
  }: {
    fieldName: string;
    generatedKind: string;
    idGenerator: IdGenerator;
  }
): string {
  if (value === undefined || value === null) {
    return generateId(generatedKind, idGenerator);
  }
  if (typeof value !== 'string') {
    throw new RuntimeValidationError(`${fieldName} must be a string when provided.`);
  }
  if (value.trim().length === 0) {
    return generateId(generatedKind, idGenerator);
  }
  return value;
}

function normalizeCreatedAt(
  value: unknown,
  { clock, wasProvided }: { clock: Clock; wasProvided: boolean }
): string {
  if (!wasProvided) {
    return clockTimestamp(clock);
  }
  if (typeof value !== 'string') {
    throw new RuntimeValidationError('created_at must be an ISO-8601 timestamp string.');
  }
  try {
    validateIso8601Timestamp(value, 'created_at');
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new RuntimeValidationError('created_at must be an ISO-8601 timestamp string.');
    }
    throw error;
  }
  return value;
}

function normalizeSchemaVersion(eventRecord: ValueRecord): typeof SCHEMA_VERSION {
  if (!Object.hasOwn(eventRecord, 'schema_version')) {
    return SCHEMA_VERSION;
  }
  if (getOwnField(eventRecord, 'schema_version') !== SCHEMA_VERSION) {
    throw new RuntimeValidationError(`schema_version must be ${repr(SCHEMA_VERSION)}.`);
  }
  return SCHEMA_VERSION;
}

function requireRecord(value: unknown, fieldName: string): ValueRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeValidationError(`${fieldName} must be a mapping.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RuntimeValidationError(`${fieldName} must be a mapping.`);
  }
  return value as ValueRecord;
}

function getOwnField(record: ValueRecord, fieldName: string): unknown {
  if (!Object.hasOwn(record, fieldName)) {
    return undefined;
  }
  return record[fieldName];
}

function repr(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  return String(value);
}

const EVENT_PAYLOAD_NORMALIZERS = {
  [USER_MESSAGE]: normalizeUserMessagePayload,
  [INCIDENT_COMPLETION]: normalizeIncidentCompletionPayload
} satisfies Record<RuntimeEvent['type'], PayloadNormalizer>;

const EVENT_VALIDATORS = {
  [USER_MESSAGE]: validateNormalizedUserMessageEvent,
  [INCIDENT_COMPLETION]: validateNormalizedIncidentCompletionEvent
} satisfies Record<RuntimeEvent['type'], EventValidator>;
