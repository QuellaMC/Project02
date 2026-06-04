import {
  normalizeOneLineMessage,
  OneLineMessageValidationError,
  type OneLineMessageValidationReason
} from './message-validation.ts';

export type RuntimeEventType = 'USER_MESSAGE';

export type RuntimeEventIdentity = {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
};

export type UserMessageRuntimeEvent = RuntimeEventIdentity & {
  readonly type: 'USER_MESSAGE';
  readonly payload: {
    readonly currentUserMessage: string;
  };
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
        ? 'Provide exactly one non-empty message.'
        : 'Provide exactly one non-empty single-line message.'
    );
    this.name = 'RuntimeEventInputError';
    this.reason = reason;
    this.identity = identity;
  }
}

export function createRuntimeEventIdentity(
  options: RuntimeEventIdentityOptions = {}
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: options.eventId ?? `evt_${crypto.randomUUID()}`,
    traceId: options.traceId ?? `trace_${crypto.randomUUID()}`,
    createdAt: options.createdAt ?? new Date().toISOString()
  } satisfies RuntimeEventIdentity);
}

export function createUserMessageRuntimeEvent(
  message: string | undefined,
  identity: RuntimeEventIdentity = createRuntimeEventIdentity()
): UserMessageRuntimeEvent {
  try {
    return Object.freeze({
      ...identity,
      type: 'USER_MESSAGE',
      payload: Object.freeze({
        currentUserMessage: normalizeOneLineMessage(message)
      })
    } satisfies UserMessageRuntimeEvent);
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      throw new RuntimeEventInputError(error.reason, identity);
    }

    throw error;
  }
}
