import {
  normalizeOneLineMessage,
  oneLineMessageMissingErrorMessage,
  oneLineMessageMultilineErrorMessage,
  OneLineMessageValidationError,
  type OneLineMessageValidationReason
} from './message-validation.ts';

export const runtimeEventTypeValues = ['USER_MESSAGE'] as const;

export type RuntimeEventType = (typeof runtimeEventTypeValues)[number];

export type RuntimeEventIdentity = {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
};

export function runtimeEventIdentityKey(
  identity: RuntimeEventIdentity
): string {
  return `${identity.eventId}\u0000${identity.traceId}\u0000${identity.createdAt}`;
}

export type UserMessageRuntimeEventPayload = {
  readonly currentUserMessage: string;
};

export type UserMessageRuntimeEvent = RuntimeEventIdentity & {
  readonly type: 'USER_MESSAGE';
  readonly payload: UserMessageRuntimeEventPayload;
};

export type RuntimeEventIdentityOptions = {
  readonly eventId?: string;
  readonly traceId?: string;
  readonly createdAt?: string;
};

export class RuntimeEventInputError extends Error {
  readonly reason: OneLineMessageValidationReason;
  readonly identity: RuntimeEventIdentity;

  constructor(reason: OneLineMessageValidationReason, identity: RuntimeEventIdentity) {
    super(
      reason === 'empty'
        ? oneLineMessageMissingErrorMessage
        : oneLineMessageMultilineErrorMessage
    );
    this.name = 'RuntimeEventInputError';
    this.reason = reason;
    this.identity = createRuntimeEventIdentitySnapshot(identity);
  }
}

export function createRuntimeEventIdentity(
  options: RuntimeEventIdentityOptions = {}
): RuntimeEventIdentity {
  return createRuntimeEventIdentitySnapshot({
    eventId: options.eventId ?? `evt_${crypto.randomUUID()}`,
    traceId: options.traceId ?? `trace_${crypto.randomUUID()}`,
    createdAt: options.createdAt ?? new Date().toISOString()
  });
}

export function assertCanonicalRuntimeTimestamp(
  value: unknown,
  field: string
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a canonical UTC ISO timestamp.`);
  }

  const parsed = new Date(value);

  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC ISO timestamp.`);
  }

  return value;
}

export function createUserMessageRuntimeEvent(
  message: string | undefined,
  identity: RuntimeEventIdentity = createRuntimeEventIdentity()
): UserMessageRuntimeEvent {
  const runtimeIdentity = createRuntimeEventIdentitySnapshot(identity);

  try {
    return Object.freeze({
      ...runtimeIdentity,
      type: 'USER_MESSAGE',
      payload: Object.freeze({
        currentUserMessage: normalizeOneLineMessage(message)
      })
    } satisfies UserMessageRuntimeEvent);
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      throw new RuntimeEventInputError(error.reason, runtimeIdentity);
    }

    throw error;
  }
}

export function createRuntimeEventIdentitySnapshot(
  identity: RuntimeEventIdentity
): RuntimeEventIdentity {
  if (identity.eventId.trim().length === 0 || identity.traceId.trim().length === 0) {
    throw new TypeError('Runtime event identity requires non-empty event and trace IDs.');
  }

  if (identity.eventId === identity.traceId) {
    throw new TypeError('Runtime event identity requires separate event and trace IDs.');
  }

  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: assertCanonicalRuntimeTimestamp(
      identity.createdAt,
      'Runtime event createdAt'
    )
  } satisfies RuntimeEventIdentity);
}
