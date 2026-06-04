import {
  normalizeOneLineMessage,
  oneLineMessageMissingErrorMessage,
  oneLineMessageMultilineErrorMessage,
  OneLineMessageValidationError,
  type OneLineMessageValidationReason
} from './message-validation.ts';

export type RuntimeEventType = 'USER_MESSAGE';

export type RuntimeEvent = UserMessageRuntimeEvent;

export type RuntimeEventIdentity = {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
};

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
    this.identity = freezeRuntimeEventIdentity(identity);
  }
}

export function createRuntimeEventIdentity(
  options: RuntimeEventIdentityOptions = {}
): RuntimeEventIdentity {
  return freezeRuntimeEventIdentity({
    eventId: options.eventId ?? `evt_${crypto.randomUUID()}`,
    traceId: options.traceId ?? `trace_${crypto.randomUUID()}`,
    createdAt: options.createdAt ?? new Date().toISOString()
  });
}

export function createUserMessageRuntimeEvent(
  message: string | undefined,
  identity: RuntimeEventIdentity = createRuntimeEventIdentity()
): UserMessageRuntimeEvent {
  const runtimeIdentity = freezeRuntimeEventIdentity(identity);

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

function freezeRuntimeEventIdentity(identity: RuntimeEventIdentity): RuntimeEventIdentity {
  if (identity.eventId.trim().length === 0 || identity.traceId.trim().length === 0) {
    throw new Error('Runtime event identity requires non-empty event and trace IDs.');
  }

  if (identity.eventId === identity.traceId) {
    throw new Error('Runtime event identity requires separate event and trace IDs.');
  }

  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: identity.createdAt
  } satisfies RuntimeEventIdentity);
}
